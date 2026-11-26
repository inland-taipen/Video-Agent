"""HTTP API for the Digital Legacy feature. Mounted at /api/legacy."""
from __future__ import annotations

import json
import re
from typing import Iterator, Literal, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import auth, config, db, engine, ingestion
from .auth import CurrentUser, require_role
from .providers import embeddings as emb
from .providers import voice as voices
from .providers.http import ProviderError
from .providers.llm import providers as llm_providers
from .providers.stt import STTUnavailable, get_stt, transcribe_bytes_quick
from .retrieval import load_memories, public_memory, search
from .storage import get_storage, make_key

router = APIRouter(prefix="/api/legacy", tags=["digital-legacy"], on_startup=[ingestion.resume_pending])

PERSONA_CONSENT = (
    "I confirm that I am a close family member or legally authorised representative of this person; "
    "that I have the right to upload these recordings and personal memories; that the person consented "
    "to (or their estate/family has authorised) the creation of an AI recreation; and I understand that "
    "the AI recreation is not the real person and may make mistakes."
)
VOICE_CLONE_CONSENT = (
    "I confirm I have the legal right to recreate this person's voice, that they consented during their "
    "lifetime or their estate has authorised it, and that the recreated voice will only be shared with "
    "authorised family members and always labelled as AI-generated."
)

AUDIO_TYPES = re.compile(r"^(audio/|video/(mp4|webm|quicktime|ogg))")
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
Role = Literal["owner", "editor", "listener"]


# ── Auth ─────────────────────────────────────────────────────────────────────

class RegisterBody(BaseModel):
    email: str = Field(max_length=200)
    name: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=8, max_length=200)


class LoginBody(BaseModel):
    email: str
    password: str


def _user_out(u: dict) -> dict:
    return {"id": u["id"], "email": u["email"], "name": u["name"]}


@router.post("/auth/register")
def register(body: RegisterBody):
    email = body.email.strip().lower()
    if not EMAIL.match(email):
        raise HTTPException(400, "Please enter a valid email address")
    if db.one("SELECT id FROM users WHERE email = ?", (email,)):
        raise HTTPException(409, "An account with this email already exists — sign in instead")
    uid = db.new_id()
    db.insert("users", {"id": uid, "email": email, "name": body.name.strip(),
                        "password_hash": auth.hash_password(body.password), "created_at": db.now()})
    auth.claim_pending_invites(uid, email)
    return {"token": auth.create_session(uid), "user": {"id": uid, "email": email, "name": body.name.strip()}}


@router.post("/auth/login")
def login(body: LoginBody):
    u = db.one("SELECT * FROM users WHERE email = ?", (body.email.strip().lower(),))
    if not u or not auth.verify_password(body.password, u["password_hash"]):
        raise HTTPException(401, "Email or password is incorrect")
    auth.claim_pending_invites(u["id"], u["email"])
    return {"token": auth.create_session(u["id"]), "user": _user_out(u)}


@router.post("/auth/logout")
def logout(user: dict = CurrentUser):
    auth.revoke_session(user["token"])
    return {"ok": True}


@router.get("/auth/me")
def me(user: dict = CurrentUser):
    return _user_out(user)


# ── Capabilities (what's working / mocked / deferred right now) ─────────────

@router.get("/capabilities")
def capabilities():
    llms = [p.name for p in llm_providers(config.chat_llm_order())]
    embed = emb.default_provider()
    return {
        "speech_to_text": {"provider": "groq-whisper" if get_stt().available() else None,
                           "status": "working" if get_stt().available() else "unavailable"},
        "chat_llm": {"providers": llms, "status": "working" if llms else "mock"},
        "extraction_llm": {"providers": [p.name for p in llm_providers(config.extraction_llm_order())]},
        "embeddings": {"model": embed.model_id, "status": "working" if embed.model_id.startswith("gemini") else "mock"},
        "voices": voices.catalogue(),
        "storage": {"backend": get_storage().name},
        "database": {"backend": db.backend_name()},
        "consent_text": {"persona": PERSONA_CONSENT, "voice_clone": VOICE_CLONE_CONSENT},
    }


# ── Personas ─────────────────────────────────────────────────────────────────

class PersonaCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    born: Optional[str] = Field(default=None, max_length=40)
    passed: Optional[str] = Field(default=None, max_length=40)
    bio: str = Field(default="", max_length=4000)
    language: str = Field(default="en-IN", max_length=20)
    relationship: str = Field(min_length=1, max_length=60)
    consent_accepted: bool


class PersonaPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    born: Optional[str] = Field(default=None, max_length=40)
    passed: Optional[str] = Field(default=None, max_length=40)
    bio: Optional[str] = Field(default=None, max_length=4000)
    language: Optional[str] = Field(default=None, max_length=20)
    voice_config: Optional[dict] = None


def _persona_or_404(persona_id: str) -> dict:
    p = db.one("SELECT * FROM personas WHERE id = ?", (persona_id,))
    if not p:
        raise HTTPException(404, "Persona not found")
    return p


def _persona_out(p: dict, role: str) -> dict:
    counts = db.one(
        """SELECT (SELECT count(*) FROM memories WHERE persona_id = ?) AS memories,
                  (SELECT count(*) FROM recordings WHERE persona_id = ?) AS recordings,
                  (SELECT count(*) FROM recordings WHERE persona_id = ? AND status NOT IN ('ready','failed','needs_transcript')) AS processing""",
        (p["id"], p["id"], p["id"]),
    ) or {}
    return {
        "id": p["id"], "name": p["name"], "born": p["born"], "passed": p["passed"], "bio": p["bio"],
        "language": p["language"], "has_photo": bool(p["photo_key"]), "is_demo": bool(p["is_demo"]),
        "style_profile": db.jload(p["style_profile"], {}),
        "voice_provider": p["voice_provider"], "voice_config": db.jload(p["voice_config"], {}),
        "role": role, "counts": counts, "updated_at": p["updated_at"],
    }


@router.get("/personas")
def list_personas(user: dict = CurrentUser):
    rows = db.all_rows(
        """SELECT p.*, m.role FROM personas p JOIN persona_members m ON m.persona_id = p.id
           WHERE m.user_id = ? ORDER BY p.updated_at DESC""",
        (user["id"],),
    )
    return [_persona_out(r, r["role"]) for r in rows]


@router.post("/personas")
def create_persona(body: PersonaCreate, request: Request, user: dict = CurrentUser):
    if not body.consent_accepted:
        raise HTTPException(400, "You must confirm authorisation and consent to create a digital legacy")
    pid, ts = db.new_id(), db.now()
    with db.tx() as c:
        c.execute(
            """INSERT INTO personas (id, name, born, passed, bio, language, created_by, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (pid, body.name.strip(), body.born, body.passed, body.bio.strip(), body.language, user["id"], ts, ts),
        )
        c.execute(
            "INSERT INTO persona_members (persona_id, email, user_id, role, relationship, invited_by, created_at) VALUES (?,?,?,?,?,?,?)",
            (pid, user["email"], user["id"], "owner", body.relationship.strip(), user["id"], ts),
        )
        c.execute(
            "INSERT INTO consents (id, persona_id, user_id, kind, relationship, statement, ip, user_agent, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (db.new_id(), pid, user["id"], "persona_creation", body.relationship.strip(), PERSONA_CONSENT,
             request.client.host if request.client else None, request.headers.get("user-agent", "")[:300], ts),
        )
    return _persona_out(_persona_or_404(pid), "owner")


@router.get("/personas/{persona_id}")
def get_persona(persona_id: str, user: dict = CurrentUser):
    role = require_role(persona_id, user, "listener")
    p = _persona_or_404(persona_id)
    out = _persona_out(p, role)
    out["people"] = db.all_rows(
        """SELECT p.name, p.relationship, count(mp.memory_id) AS mentions FROM people p
           LEFT JOIN memory_people mp ON mp.person_id = p.id WHERE p.persona_id = ?
           GROUP BY p.id ORDER BY mentions DESC, p.name LIMIT 60""",
        (persona_id,),
    )
    out["consents"] = db.all_rows(
        """SELECT c.kind, c.relationship, c.accepted_at, u.name AS given_by FROM consents c
           JOIN users u ON u.id = c.user_id WHERE c.persona_id = ? ORDER BY c.accepted_at""",
        (persona_id,),
    )
    out["my_relationship"] = engine.relationship_of(persona_id, user["id"])
    return out


@router.patch("/personas/{persona_id}")
def patch_persona(persona_id: str, body: PersonaPatch, user: dict = CurrentUser):
    role = require_role(persona_id, user, "editor")
    fields = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k != "voice_config"}
    if body.voice_config is not None:
        fields["voice_config"] = json.dumps(body.voice_config)[:4000]
    if fields:
        fields["updated_at"] = db.now()
        db.update("personas", "id", persona_id, fields)
    return _persona_out(_persona_or_404(persona_id), role)


@router.delete("/personas/{persona_id}")
def delete_persona(persona_id: str, user: dict = CurrentUser):
    require_role(persona_id, user, "owner")
    store = get_storage()
    p = _persona_or_404(persona_id)
    for r in db.all_rows("SELECT storage_key FROM recordings WHERE persona_id = ? AND storage_key IS NOT NULL", (persona_id,)):
        store.delete(r["storage_key"])
    if p["photo_key"]:
        store.delete(p["photo_key"])
    db.execute("DELETE FROM personas WHERE id = ?", (persona_id,))
    return {"ok": True}


@router.post("/personas/{persona_id}/photo")
def upload_photo(persona_id: str, file: UploadFile = File(...), user: dict = CurrentUser):
    require_role(persona_id, user, "editor")
    if file.content_type not in IMAGE_TYPES:
        raise HTTPException(400, "Photo must be JPEG, PNG or WebP")
    p = _persona_or_404(persona_id)
    store = get_storage()
    key = make_key(persona_id, "photo", file.filename or "photo.jpg")
    store.put(key, file.file)
    if p["photo_key"]:
        store.delete(p["photo_key"])
    db.update("personas", "id", persona_id, {"photo_key": key, "updated_at": db.now()})
    return {"ok": True}


@router.get("/personas/{persona_id}/photo")
def get_photo(persona_id: str, user: dict = CurrentUser):
    require_role(persona_id, user, "listener")
    p = _persona_or_404(persona_id)
    if not p["photo_key"]:
        raise HTTPException(404, "No photo")
    return FileResponse(get_storage().local_path(p["photo_key"]), headers={"Cache-Control": "private, max-age=300"})


# ── Recordings ───────────────────────────────────────────────────────────────

def _recording_out(r: dict) -> dict:
    keys = ("id", "persona_id", "title", "source_type", "speaker_mode", "original_filename", "mime_type",
            "size_bytes", "duration_sec", "recorded_on", "notes", "status", "status_detail", "transcript_source",
            "language", "extraction_source", "created_at", "processed_at")
    out = {k: r.get(k) for k in keys}
    out["memory_count"] = r.get("memory_count", 0)
    out["uploaded_by_name"] = r.get("uploaded_by_name")
    return out


def _recording_or_404(recording_id: str, user: dict, minimum: str) -> dict:
    r = db.one("SELECT * FROM recordings WHERE id = ?", (recording_id,))
    if not r:
        raise HTTPException(404, "Recording not found")
    require_role(r["persona_id"], user, minimum)
    return r


@router.get("/personas/{persona_id}/recordings")
def list_recordings(persona_id: str, user: dict = CurrentUser):
    require_role(persona_id, user, "listener")
    rows = db.all_rows(
        """SELECT r.*, u.name AS uploaded_by_name,
                  (SELECT count(*) FROM memories m WHERE m.recording_id = r.id) AS memory_count
           FROM recordings r JOIN users u ON u.id = r.uploaded_by
           WHERE r.persona_id = ? ORDER BY r.created_at DESC""",
        (persona_id,),
    )
    return [_recording_out(r) for r in rows]


@router.post("/personas/{persona_id}/recordings")
def add_recording(
    persona_id: str,
    title: str = Form(..., min_length=1, max_length=200),
    speaker_mode: Literal["solo", "interview", "family_account", "transcript"] = Form("solo"),
    recorded_on: Optional[str] = Form(None, max_length=40),
    notes: str = Form("", max_length=2000),
    transcript: Optional[str] = Form(None, max_length=400_000),
    file: Optional[UploadFile] = File(None),
    user: dict = CurrentUser,
):
    require_role(persona_id, user, "editor")
    _persona_or_404(persona_id)
    return create_recording(persona_id, user["id"], title, speaker_mode, recorded_on, notes, transcript, file)


def create_recording(persona_id: str, user_id: str, title: str, speaker_mode: str, recorded_on: Optional[str],
                     notes: str, transcript: Optional[str], file: Optional[UploadFile]) -> dict:
    """Store an uploaded recording or written story and queue it for processing (caller authorises)."""
    rid = db.new_id()
    row = {
        "id": rid, "persona_id": persona_id, "uploaded_by": user_id, "title": title.strip(),
        "speaker_mode": speaker_mode, "recorded_on": recorded_on or None, "notes": notes.strip(),
        "created_at": db.now(), "status": "queued", "status_detail": "Waiting to be processed…",
    }
    if file is not None and file.filename:
        if not AUDIO_TYPES.match(file.content_type or ""):
            raise HTTPException(400, f"Unsupported file type '{file.content_type}'. Upload audio (MP3, WAV, M4A, WebM, OGG…)")
        key = make_key(persona_id, "recordings", file.filename)
        try:
            size = get_storage().put(key, file.file)
        except ValueError as exc:
            raise HTTPException(413, str(exc))
        row.update(source_type="audio", storage_key=key, original_filename=file.filename[:200],
                   mime_type=file.content_type, size_bytes=size)
        if transcript and transcript.strip():
            row.update(transcript_text=transcript.strip(), transcript_source="manual")
    elif transcript and transcript.strip():
        row.update(source_type="text", transcript_text=transcript.strip(), transcript_source="text-upload")
        if speaker_mode in ("solo", "interview"):
            row["speaker_mode"] = "transcript"
    else:
        raise HTTPException(400, "Upload an audio file or paste the story text")
    db.insert("recordings", row)
    db.update("personas", "id", persona_id, {"updated_at": db.now()})
    ingestion.enqueue(rid)
    return _recording_out(db.one("SELECT * FROM recordings WHERE id = ?", (rid,)))


@router.get("/recordings/{recording_id}")
def get_recording(recording_id: str, user: dict = CurrentUser):
    r = _recording_or_404(recording_id, user, "listener")
    out = _recording_out(r)
    out["segments"] = db.all_rows(
        "SELECT start_sec, end_sec, text FROM transcript_segments WHERE recording_id = ? ORDER BY idx", (recording_id,))
    out["memories"] = [public_memory(m) for m in load_memories(r["persona_id"]) if m["recording_id"] == recording_id]
    return out


@router.get("/recordings/{recording_id}/audio")
def recording_audio(recording_id: str, user: dict = CurrentUser):
    r = _recording_or_404(recording_id, user, "listener")
    if not r["storage_key"]:
        raise HTTPException(404, "This memory was added as text and has no audio")
    return FileResponse(get_storage().local_path(r["storage_key"]), media_type=r["mime_type"] or "audio/mpeg",
                        headers={"Cache-Control": "private, no-store"})


class TranscriptBody(BaseModel):
    text: str = Field(min_length=1, max_length=400_000)


@router.post("/recordings/{recording_id}/transcript")
def set_transcript(recording_id: str, body: TranscriptBody, user: dict = CurrentUser):
    _recording_or_404(recording_id, user, "editor")
    db.execute("DELETE FROM transcript_segments WHERE recording_id = ?", (recording_id,))
    db.update("recordings", "id", recording_id, {
        "transcript_text": body.text.strip(), "transcript_source": "manual",
        "status": "queued", "status_detail": "Waiting to be processed…",
    })
    ingestion.enqueue(recording_id)
    return {"ok": True}


@router.post("/recordings/{recording_id}/retry")
def retry_recording(recording_id: str, user: dict = CurrentUser):
    r = _recording_or_404(recording_id, user, "editor")
    if r["status"] not in ingestion.TERMINAL:
        raise HTTPException(409, "This recording is still being processed")
    db.update("recordings", "id", recording_id, {"status": "queued", "status_detail": "Waiting to be processed…"})
    ingestion.enqueue(recording_id)
    return {"ok": True}


@router.delete("/recordings/{recording_id}")
def delete_recording(recording_id: str, user: dict = CurrentUser):
    r = _recording_or_404(recording_id, user, "editor")
    if r["storage_key"]:
        get_storage().delete(r["storage_key"])
    db.execute("DELETE FROM recordings WHERE id = ?", (recording_id,))
    return {"ok": True}


# ── Memories ─────────────────────────────────────────────────────────────────

@router.get("/personas/{persona_id}/memories")
def list_memories(persona_id: str, q: Optional[str] = None, user: dict = CurrentUser):
    require_role(persona_id, user, "listener")
    if q and q.strip():
        return [public_memory(m) for m in search(persona_id, q, k=12)]
    return [public_memory(m) for m in load_memories(persona_id)]


class MemoryPatch(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    summary: Optional[str] = Field(default=None, min_length=1, max_length=4000)
    time_period: Optional[str] = Field(default=None, max_length=80)


@router.patch("/memories/{memory_id}")
def patch_memory(memory_id: str, body: MemoryPatch, user: dict = CurrentUser):
    m = db.one("SELECT * FROM memories WHERE id = ?", (memory_id,))
    if not m:
        raise HTTPException(404, "Memory not found")
    require_role(m["persona_id"], user, "editor")
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        return {"ok": True}
    merged = {**m, **fields, "places": db.jload(m["places"], [])}
    people = db.all_rows("SELECT p.name, p.relationship FROM memory_people mp JOIN people p ON p.id = mp.person_id WHERE mp.memory_id = ?", (memory_id,))
    vectors, model_id = ingestion.embed_texts([ingestion.memory_embedding_text(merged, people)])
    fields.update(embedding=json.dumps([round(x, 6) for x in vectors[0]]), embedding_model=model_id)
    db.update("memories", "id", memory_id, fields)
    return {"ok": True}


@router.delete("/memories/{memory_id}")
def delete_memory(memory_id: str, user: dict = CurrentUser):
    m = db.one("SELECT persona_id FROM memories WHERE id = ?", (memory_id,))
    if not m:
        raise HTTPException(404, "Memory not found")
    require_role(m["persona_id"], user, "editor")
    db.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
    return {"ok": True}


# ── Family access ────────────────────────────────────────────────────────────

class MemberBody(BaseModel):
    email: str = Field(max_length=200)
    role: Role = "listener"
    relationship: str = Field(default="", max_length=60)


@router.get("/personas/{persona_id}/members")
def list_members(persona_id: str, user: dict = CurrentUser):
    role = require_role(persona_id, user, "listener")
    rows = db.all_rows(
        """SELECT m.email, m.role, m.relationship, m.user_id IS NOT NULL AS joined, u.name
           FROM persona_members m LEFT JOIN users u ON u.id = m.user_id
           WHERE m.persona_id = ? ORDER BY m.role = 'owner' DESC, m.created_at""",
        (persona_id,),
    )
    if role != "owner":  # non-owners see names, not email addresses
        for r in rows:
            r["email"] = None
    return rows


@router.post("/personas/{persona_id}/members")
def add_member(persona_id: str, body: MemberBody, user: dict = CurrentUser):
    require_role(persona_id, user, "owner")
    email = body.email.strip().lower()
    if not EMAIL.match(email):
        raise HTTPException(400, "Please enter a valid email address")
    if db.one("SELECT 1 FROM persona_members WHERE persona_id = ? AND email = ?", (persona_id, email)):
        raise HTTPException(409, "This person already has access")
    existing = db.one("SELECT id FROM users WHERE email = ?", (email,))
    db.insert("persona_members", {
        "persona_id": persona_id, "email": email, "user_id": existing["id"] if existing else None,
        "role": body.role, "relationship": body.relationship.strip(), "invited_by": user["id"], "created_at": db.now(),
    })
    return {"ok": True, "joined": bool(existing)}


class MemberPatch(BaseModel):
    role: Role


def _owner_count(persona_id: str) -> int:
    return db.one("SELECT count(*) AS n FROM persona_members WHERE persona_id = ? AND role = 'owner'", (persona_id,))["n"]


@router.patch("/personas/{persona_id}/members/{email}")
def change_member(persona_id: str, email: str, body: MemberPatch, user: dict = CurrentUser):
    require_role(persona_id, user, "owner")
    m = db.one("SELECT role FROM persona_members WHERE persona_id = ? AND email = ?", (persona_id, email.lower()))
    if not m:
        raise HTTPException(404, "Member not found")
    if m["role"] == "owner" and body.role != "owner" and _owner_count(persona_id) <= 1:
        raise HTTPException(400, "A legacy needs at least one owner")
    db.execute("UPDATE persona_members SET role = ? WHERE persona_id = ? AND email = ?", (body.role, persona_id, email.lower()))
    return {"ok": True}


@router.delete("/personas/{persona_id}/members/{email}")
def remove_member(persona_id: str, email: str, user: dict = CurrentUser):
    require_role(persona_id, user, "owner")
    m = db.one("SELECT role FROM persona_members WHERE persona_id = ? AND email = ?", (persona_id, email.lower()))
    if not m:
        raise HTTPException(404, "Member not found")
    if m["role"] == "owner" and _owner_count(persona_id) <= 1:
        raise HTTPException(400, "A legacy needs at least one owner")
    db.execute("DELETE FROM persona_members WHERE persona_id = ? AND email = ?", (persona_id, email.lower()))
    return {"ok": True}


# ── Conversations ────────────────────────────────────────────────────────────

@router.post("/personas/{persona_id}/conversations")
def start_conversation(persona_id: str, user: dict = CurrentUser):
    require_role(persona_id, user, "listener")
    p = _persona_or_404(persona_id)
    cid = db.new_id()
    db.insert("conversations", {"id": cid, "persona_id": persona_id, "user_id": user["id"], "started_at": db.now()})
    text = engine.greeting(p, engine.memory_count(persona_id))
    db.insert("conversation_turns", {"id": db.new_id(), "conversation_id": cid, "role": "persona", "text": text,
                                     "source_ids": "[]", "grounded": 0, "provider": "system", "created_at": db.now()})
    return {"conversation_id": cid, "greeting": text, "voice_provider": p["voice_provider"]}


def _conversation_or_404(cid: str, user: dict) -> dict:
    c = db.one("SELECT * FROM conversations WHERE id = ?", (cid,))
    # Conversations are private to the family member who had them.
    if not c or c["user_id"] != user["id"]:
        raise HTTPException(404, "Conversation not found")
    require_role(c["persona_id"], user, "listener")
    return c


class MessageBody(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


@router.post("/conversations/{cid}/messages")
def send_message(cid: str, body: MessageBody, user: dict = CurrentUser):
    c = _conversation_or_404(cid, user)
    if c["ended_at"]:
        raise HTTPException(409, "This conversation has ended")
    p = _persona_or_404(c["persona_id"])
    rel = engine.relationship_of(p["id"], user["id"])

    def guarded() -> Iterator[str]:
        try:
            yield from engine.respond(c, p, user, rel, body.text.strip())
        except Exception as exc:  # noqa: BLE001
            print(f"  [legacy] respond failed: {exc}")
            yield json.dumps({"type": "error", "message": "Something went wrong while answering. Please try again."}) + "\n"

    return StreamingResponse(guarded(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.post("/conversations/{cid}/end")
def end_conversation(cid: str, user: dict = CurrentUser):
    _conversation_or_404(cid, user)
    db.execute("UPDATE conversations SET ended_at = ? WHERE id = ? AND ended_at IS NULL", (db.now(), cid))
    return {"ok": True}


@router.get("/personas/{persona_id}/conversations")
def list_conversations(persona_id: str, user: dict = CurrentUser):
    require_role(persona_id, user, "listener")
    return db.all_rows(
        """SELECT c.id, c.started_at, c.ended_at, count(t.id) AS turns,
                  (SELECT text FROM conversation_turns WHERE conversation_id = c.id AND role = 'user'
                   ORDER BY created_at LIMIT 1) AS first_question
           FROM conversations c LEFT JOIN conversation_turns t ON t.conversation_id = c.id
           WHERE c.persona_id = ? AND c.user_id = ? GROUP BY c.id ORDER BY c.started_at DESC LIMIT 50""",
        (persona_id, user["id"]),
    )


@router.get("/conversations/{cid}")
def get_conversation(cid: str, user: dict = CurrentUser):
    c = _conversation_or_404(cid, user)
    turns = db.all_rows(
        f"SELECT id, role, text, source_ids, grounded, provider, created_at FROM conversation_turns WHERE conversation_id = ? ORDER BY created_at, {db.order_tiebreak()}",
        (cid,),
    )
    for t in turns:
        t["source_ids"] = db.jload(t["source_ids"], [])
    return {**c, "turns": turns}


# ── Speech helpers for the live call ────────────────────────────────────────

@router.post("/stt")
async def speech_to_text(file: UploadFile = File(...), language: Optional[str] = Form(None), user: dict = CurrentUser):
    """Server-side STT for one spoken turn (used by the 'Whisper' listening mode)."""
    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413, "Audio clip too long")
    try:
        t = transcribe_bytes_quick(data, file.filename or "turn.webm", language)
    except STTUnavailable as exc:
        raise HTTPException(503, f"Server speech-to-text unavailable: {exc}")
    except ProviderError as exc:
        msg = str(exc)
        if "empty transcript" in msg:
            return {"text": ""}
        raise HTTPException(502, f"Speech-to-text failed: {msg[:200]}")
    return {"text": t.text, "language": t.language}


class SpeakBody(BaseModel):
    text: str = Field(min_length=1, max_length=1500)


@router.post("/personas/{persona_id}/speak")
def speak(persona_id: str, body: SpeakBody, user: dict = CurrentUser):
    """Server-side voice synthesis for providers that need it (deferred: ElevenLabs)."""
    require_role(persona_id, user, "listener")
    p = _persona_or_404(persona_id)
    provider = voices.get_voice(p["voice_provider"])
    if provider.client_side:
        raise HTTPException(400, "This persona uses the browser voice")
    try:
        audio, mime = provider.synthesize(body.text, db.jload(p["voice_config"], {}))
    except ProviderError as exc:
        raise HTTPException(502, str(exc))
    return Response(audio, media_type=mime, headers={"X-AI-Generated": "true", "Cache-Control": "no-store"})
