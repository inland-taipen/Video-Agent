"""Private story link — one secret URL for the subject themselves (Bio-per3's model).

Opening /#/story/<token> shows the subject's own page: portrait, timeline and
the life-story interview, with no account needed. The token only reaches that
persona's interview (as the subject) and its finished biography — not the
family's memories, recordings, members or conversations.

Only a hash of the token is stored. The owner sees the link once; regenerating
revokes the old link but keeps the same link account, so interviews carry on.
"""
from __future__ import annotations

import hashlib
import json
import secrets
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from .. import db
from .. import routes as core
from ..auth import CurrentUser, require_role
from ..providers.http import ProviderError
from ..providers.stt import STTUnavailable, transcribe_bytes_quick
from ..storage import get_storage
from . import routes as ls
from . import store

router = APIRouter(prefix="/api/legacy", tags=["life-story-link"])

DISABLED_PASSWORD = "!link-account-cannot-sign-in"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ── Owner: create / regenerate / revoke ─────────────────────────────────────

def _active_link(persona_id: str) -> Optional[dict]:
    return db.one(
        "SELECT * FROM story_links WHERE persona_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
        (persona_id,),
    )


@router.get("/personas/{persona_id}/story-link")
def link_status(persona_id: str, user: dict = CurrentUser):
    require_role(persona_id, user, "owner")
    link = _active_link(persona_id)
    return {"active": bool(link), "created_at": link["created_at"] if link else None}


@router.post("/personas/{persona_id}/story-link")
def create_link(persona_id: str, user: dict = CurrentUser):
    """Create the link, or replace it (the previous link stops working immediately)."""
    require_role(persona_id, user, "owner")
    p = ls._persona_or_404(persona_id)
    prev = db.one("SELECT link_user_id FROM story_links WHERE persona_id = ? ORDER BY created_at DESC LIMIT 1",
                  (persona_id,))
    token, ts = secrets.token_urlsafe(32), db.now()
    with db.tx() as c:
        if prev:
            link_user = prev["link_user_id"]
        else:
            link_user = db.new_id()
            # An account the link answers as. Its email can't be registered and its password can't be used.
            c.execute("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)",
                      (link_user, f"story-link+{link_user}@invalid", p["name"], DISABLED_PASSWORD, ts))
        c.execute("UPDATE story_links SET revoked_at = ? WHERE persona_id = ? AND revoked_at IS NULL", (ts, persona_id))
        c.execute("INSERT INTO story_links (token_hash, persona_id, link_user_id, created_by, created_at) VALUES (?,?,?,?,?)",
                  (_hash(token), persona_id, link_user, user["id"], ts))
    return {"token": token, "created_at": ts}


@router.delete("/personas/{persona_id}/story-link")
def revoke_link(persona_id: str, user: dict = CurrentUser):
    require_role(persona_id, user, "owner")
    db.execute("UPDATE story_links SET revoked_at = ? WHERE persona_id = ? AND revoked_at IS NULL",
               (db.now(), persona_id))
    return {"ok": True}


# ── Link holder (the subject) ───────────────────────────────────────────────

def _resolve(token: str) -> tuple[dict, dict]:
    """(persona, link user) for a live token. Unknown and revoked tokens look the same: 404."""
    link = db.one("SELECT * FROM story_links WHERE token_hash = ? AND revoked_at IS NULL", (_hash(token),))
    p = db.one("SELECT * FROM personas WHERE id = ?", (link["persona_id"],)) if link else None
    if not link or not p:
        raise HTTPException(404, "This link isn't valid any more. Ask the family for a new one.")
    u = db.one("SELECT id, name, email FROM users WHERE id = ?", (link["link_user_id"],))
    return p, {**u, "name": p["name"]}


@router.get("/story/{token}")
def story_page(token: str):
    p, u = _resolve(token)
    story = store.get_story(p)
    open_s = db.one(
        """SELECT * FROM interview_sessions WHERE persona_id = ? AND user_id = ? AND ended_at IS NULL
           ORDER BY session_number DESC LIMIT 1""",
        (p["id"], u["id"]),
    )
    bio = ls._latest_bio(p["id"])
    return {
        "name": p["name"], "born": p["born"], "passed": p["passed"], "bio": p["bio"], "has_photo": bool(p["photo_key"]),
        "page": db.jload(story.get("page"), {}),
        "coverage": ls._coverage_out(p["id"])["stats"],
        "sections": [
            {"name": sec["name"], "total": len(sec["questions"]),
             "covered": sum(q["status"] == "covered" for q in sec["questions"]),
             "partial": sum(q["status"] == "partial" for q in sec["questions"])}
            for sec in ls._coverage_out(p["id"])["sections"]
        ],
        "sessions_done": db.one("SELECT count(*) AS n FROM interview_sessions WHERE persona_id = ? AND user_id = ? AND ended_at IS NOT NULL",
                                (p["id"], u["id"]))["n"],
        "open_session": ls._session_out(open_s, turns=True) if open_s else None,
        "biography": {"content_md": bio["content_md"], "created_at": bio["created_at"]} if bio and bio["status"] == "ready" else None,
    }


@router.get("/story/{token}/photo")
def story_photo(token: str):
    p, _ = _resolve(token)
    if not p["photo_key"]:
        raise HTTPException(404, "No photo")
    return FileResponse(get_storage().local_path(p["photo_key"]), headers={"Cache-Control": "private, max-age=300"})


@router.post("/story/{token}/sessions")
def story_start(token: str):
    p, u = _resolve(token)
    return ls.start_or_resume(p, u, "subject")


def _own_session(token: str, sid: str) -> tuple[dict, dict]:
    p, u = _resolve(token)
    s = db.one("SELECT * FROM interview_sessions WHERE id = ?", (sid,))
    if not s or s["persona_id"] != p["id"] or s["user_id"] != u["id"]:
        raise HTTPException(404, "Interview session not found")
    return s, u


class AnswerBody(BaseModel):
    text: str = Field(min_length=1, max_length=8000)


@router.post("/story/{token}/sessions/{sid}/turns")
def story_answer(token: str, sid: str, body: AnswerBody):
    s, u = _own_session(token, sid)
    return ls.answer_turn(s, u, body.text)


@router.post("/story/{token}/sessions/{sid}/end")
def story_end(token: str, sid: str):
    s, _ = _own_session(token, sid)
    return ls.end_interview(s)


@router.post("/story/{token}/stt")
async def story_stt(token: str, file: UploadFile = File(...), language: Optional[str] = Form(None)):
    p, _ = _resolve(token)
    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413, "Audio clip too long")
    try:
        t = transcribe_bytes_quick(data, file.filename or "turn.webm", language or p["language"])
    except STTUnavailable as exc:
        raise HTTPException(503, f"Speech-to-text unavailable: {exc}")
    except ProviderError as exc:
        if "empty transcript" in str(exc):
            return {"text": ""}
        raise HTTPException(502, "Speech-to-text failed — please type your answer instead.")
    return {"text": t.text}


# ── Sharing material (Bio-per3's upload panel) ──────────────────────────────

@router.post("/story/{token}/recordings")
def story_share(
    token: str,
    title: str = Form("", max_length=200),
    transcript: Optional[str] = Form(None, max_length=400_000),
    file: Optional[UploadFile] = File(None),
):
    """Paste text (notes, a WhatsApp export…), upload audio, or send a recorded voice memo — in his own words."""
    p, u = _resolve(token)
    first = p["name"].split()[0]
    kind = "Voice memo" if file is not None and file.filename else "Written note"
    name = title.strip() or f"{kind} from {first} · {db.now()[:10]}"
    return core.create_recording(p["id"], u["id"], name, "solo", None, "Shared through the private story link.",
                                 transcript, file)


@router.get("/story/{token}/recordings")
def story_shared(token: str):
    """What he has shared himself (not the auto-saved interview sessions), with processing status."""
    p, u = _resolve(token)
    return db.all_rows(
        """SELECT r.id, r.title, r.source_type, r.status, r.status_detail, r.created_at,
                  (SELECT count(*) FROM memories m WHERE m.recording_id = r.id) AS memory_count
           FROM recordings r WHERE r.persona_id = ? AND r.uploaded_by = ?
             AND coalesce(r.transcript_source, '') <> 'interview' ORDER BY r.created_at DESC LIMIT 100""",
        (p["id"], u["id"]),
    )


# ── Past conversations ──────────────────────────────────────────────────────

@router.get("/story/{token}/sessions")
def story_sessions(token: str):
    """His finished interview conversations, newest first, with their full transcript."""
    p, u = _resolve(token)
    rows = db.all_rows(
        """SELECT * FROM interview_sessions WHERE persona_id = ? AND user_id = ? AND ended_at IS NOT NULL
           ORDER BY session_number DESC LIMIT 50""",
        (p["id"], u["id"]),
    )
    return [ls._session_out(s, turns=True) for s in rows]


# ── The full legacy on the link: memories + conversation with the AI recreation ──
# The same screens as the signed-in app (MemoriesTab, CallScreen) run against these.

def _visitor(p: dict, u: dict) -> dict:
    """Who the AI recreation is talking to on the link (honest: we only know it's the link)."""
    return {**u, "name": f"someone using {p['name'].split()[0]}'s private story link"}


@router.get("/story/{token}/persona")
def story_persona(token: str):
    p, _ = _resolve(token)
    out = core._persona_out(p, "listener")
    out["people"] = db.all_rows(
        """SELECT p.name, p.relationship, count(mp.memory_id) AS mentions FROM people p
           LEFT JOIN memory_people mp ON mp.person_id = p.id WHERE p.persona_id = ?
           GROUP BY p.id ORDER BY mentions DESC, p.name LIMIT 60""",
        (p["id"],),
    )
    out["my_relationship"] = ""
    return out


@router.get("/story/{token}/memories")
def story_memories(token: str, q: Optional[str] = None):
    p, _ = _resolve(token)
    if q and q.strip():
        return [core.public_memory(m) for m in core.search(p["id"], q, k=12)]
    return [core.public_memory(m) for m in core.load_memories(p["id"])]


@router.get("/story/{token}/recordings/{recording_id}/audio")
def story_recording_audio(token: str, recording_id: str):
    p, _ = _resolve(token)
    r = db.one("SELECT * FROM recordings WHERE id = ? AND persona_id = ?", (recording_id, p["id"]))
    if not r or not r["storage_key"]:
        raise HTTPException(404, "No original audio for this memory")
    return FileResponse(get_storage().local_path(r["storage_key"]), media_type=r["mime_type"] or "audio/mpeg",
                        headers={"Cache-Control": "private, no-store"})


@router.post("/story/{token}/conversations")
def story_start_conversation(token: str):
    p, u = _resolve(token)
    cid = db.new_id()
    db.insert("conversations", {"id": cid, "persona_id": p["id"], "user_id": u["id"], "started_at": db.now()})
    text = core.engine.greeting(p, core.engine.memory_count(p["id"]))
    db.insert("conversation_turns", {"id": db.new_id(), "conversation_id": cid, "role": "persona", "text": text,
                                     "source_ids": "[]", "grounded": 0, "provider": "system", "created_at": db.now()})
    return {"conversation_id": cid, "greeting": text, "voice_provider": p["voice_provider"]}


def _own_conversation(token: str, cid: str) -> tuple[dict, dict, dict]:
    p, u = _resolve(token)
    c = db.one("SELECT * FROM conversations WHERE id = ?", (cid,))
    if not c or c["persona_id"] != p["id"] or c["user_id"] != u["id"]:
        raise HTTPException(404, "Conversation not found")
    return c, p, u


class StoryMessage(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


@router.post("/story/{token}/conversations/{cid}/messages")
def story_message(token: str, cid: str, body: StoryMessage):
    c, p, u = _own_conversation(token, cid)
    if c["ended_at"]:
        raise HTTPException(409, "This conversation has ended")

    def guarded():
        try:
            yield from core.engine.respond(c, p, _visitor(p, u), "", body.text.strip())
        except Exception as exc:  # noqa: BLE001
            print(f"  [legacy] story-link respond failed: {exc}")
            yield json.dumps({"type": "error", "message": "Something went wrong while answering. Please try again."}) + "\n"

    return StreamingResponse(guarded(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.post("/story/{token}/conversations/{cid}/end")
def story_end_conversation(token: str, cid: str):
    _own_conversation(token, cid)
    db.execute("UPDATE conversations SET ended_at = ? WHERE id = ? AND ended_at IS NULL", (db.now(), cid))
    return {"ok": True}


@router.get("/story/{token}/conversations")
def story_conversations(token: str):
    p, u = _resolve(token)
    return db.all_rows(
        """SELECT c.id, c.started_at, c.ended_at, count(t.id) AS turns,
                  (SELECT text FROM conversation_turns WHERE conversation_id = c.id AND role = 'user'
                   ORDER BY created_at LIMIT 1) AS first_question
           FROM conversations c LEFT JOIN conversation_turns t ON t.conversation_id = c.id
           WHERE c.persona_id = ? AND c.user_id = ? GROUP BY c.id ORDER BY c.started_at DESC LIMIT 50""",
        (p["id"], u["id"]),
    )


@router.get("/story/{token}/conversations/{cid}")
def story_conversation(token: str, cid: str):
    c, _, _ = _own_conversation(token, cid)
    turns = db.all_rows(
        f"""SELECT id, role, text, source_ids, grounded, provider, created_at FROM conversation_turns
            WHERE conversation_id = ? ORDER BY created_at, {db.order_tiebreak()}""",
        (cid,),
    )
    for t in turns:
        t["source_ids"] = db.jload(t["source_ids"], [])
    return {**c, "turns": turns}


@router.post("/story/{token}/speak")
def story_speak(token: str, body: StoryMessage):
    p, _ = _resolve(token)
    provider = core.voices.get_voice(p["voice_provider"])
    if provider.client_side:
        raise HTTPException(400, "This persona uses the browser voice")
    try:
        audio, mime = provider.synthesize(body.text, db.jload(p["voice_config"], {}))
    except ProviderError as exc:
        raise HTTPException(502, str(exc))
    return Response(audio, media_type=mime, headers={"X-AI-Generated": "true", "Cache-Control": "no-store"})
