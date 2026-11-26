"""HTTP API for Life Story. Mounted under /api/legacy next to the core Legacy routes.

Bio-per3 equivalents:
  POST /api/subjects/:id/sessions          → POST /personas/{pid}/interview/sessions
  POST /api/interview/turn                 → POST /interview/sessions/{sid}/turns
  POST|GET|DELETE /api/subjects/:id/biography → /personas/{pid}/biography, /biographies/{bid}
  POST /api/subjects/:id/upload-*          → the existing Recordings tab (analysed automatically)
"""
from __future__ import annotations

import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import db, engine, ingestion
from ..auth import CurrentUser, require_role
from ..providers.http import ProviderError
from . import agents, store
from . import questions as qs

router = APIRouter(prefix="/api/legacy", tags=["life-story"])

_bio_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="legacy-biography")
_bio_lock = threading.Lock()


def _persona_or_404(persona_id: str) -> dict:
    p = db.one("SELECT * FROM personas WHERE id = ?", (persona_id,))
    if not p:
        raise HTTPException(404, "Persona not found")
    return p


def _coverage_out(persona_id: str) -> dict:
    cov = store.coverage(persona_id)
    sources = {int(r["question_id"]): r["source"] for r in db.all_rows(
        "SELECT question_id, source FROM interview_coverage WHERE persona_id = ?", (persona_id,))}
    return {
        "stats": qs.stats(cov),
        "sections": [
            {"id": sid, "name": name, "questions": [
                {"id": q["id"], "skeleton": q["skeleton"], "weight": q["weight"],
                 "status": cov.get(q["id"], "untouched"), "source": sources.get(q["id"])}
                for q in qs.QUESTIONS if q["section"] == sid
            ]}
            for sid, name in qs.SECTIONS.items()
        ],
    }


def _bio_out(b: Optional[dict]) -> Optional[dict]:
    if not b:
        return None
    return {k: b[k] for k in ("id", "status", "status_detail", "content_md", "provider", "created_at")} | {
        "generated_by_name": b.get("generated_by_name")}


def _latest_bio(persona_id: str) -> Optional[dict]:
    return db.one(
        """SELECT b.*, u.name AS generated_by_name FROM biographies b LEFT JOIN users u ON u.id = b.generated_by
           WHERE b.persona_id = ? ORDER BY b.created_at DESC LIMIT 1""",
        (persona_id,),
    )


def _session_out(s: dict, turns: bool = False) -> dict:
    out = {k: s[k] for k in ("id", "speaker", "session_number", "onboarding", "last_question", "recording_id",
                             "started_at", "ended_at")}
    out["user_name"] = s.get("user_name")
    if turns:
        out["turns"] = store.session_turns(s["id"])
    return out


# ── Overview + settings ─────────────────────────────────────────────────────

@router.get("/personas/{persona_id}/lifestory")
def overview(persona_id: str, user: dict = CurrentUser):
    role = require_role(persona_id, user, "listener")
    p = _persona_or_404(persona_id)
    story = store.get_story(p)
    sessions = db.all_rows(
        """SELECT s.*, u.name AS user_name, (SELECT count(*) FROM interview_turns t WHERE t.session_id = s.id AND t.role = 'user') AS answers
           FROM interview_sessions s JOIN users u ON u.id = s.user_id WHERE s.persona_id = ? ORDER BY s.session_number DESC""",
        (persona_id,),
    )
    return {
        "role": role,
        "background": story["background"], "reference_material": story["reference_material"],
        "profile": story["profile"], "onboarding_complete": bool(story["onboarding_complete"]),
        "coverage": _coverage_out(persona_id),
        "threads": store.open_threads(persona_id),
        "sessions": [{**_session_out(s), "answers": s["answers"],
                      "mine": s["user_id"] == user["id"]} for s in sessions],
        "biography": _bio_out(_latest_bio(persona_id)),
        "default_speaker": "family" if p["passed"] else "subject",
    }


class StoryPatch(BaseModel):
    background: Optional[str] = Field(default=None, max_length=20_000)
    reference_material: Optional[str] = Field(default=None, max_length=60_000)


@router.patch("/personas/{persona_id}/lifestory")
def patch_story(persona_id: str, body: StoryPatch, user: dict = CurrentUser):
    require_role(persona_id, user, "editor")
    store.get_story(_persona_or_404(persona_id))
    fields = {k: v.strip() for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if fields:
        store.update_story(persona_id, **fields)
    return {"ok": True}


class ThreadPatch(BaseModel):
    status: Literal["open", "explored", "dismissed"]


@router.patch("/threads/{thread_id}")
def patch_thread(thread_id: str, body: ThreadPatch, user: dict = CurrentUser):
    t = db.one("SELECT persona_id FROM interview_threads WHERE id = ?", (thread_id,))
    if not t:
        raise HTTPException(404, "Thread not found")
    require_role(t["persona_id"], user, "editor")
    db.update("interview_threads", "id", thread_id, {"status": body.status})
    return {"ok": True}


# ── Interview sessions ──────────────────────────────────────────────────────

class StartBody(BaseModel):
    speaker: Optional[Literal["subject", "family"]] = None


@router.post("/personas/{persona_id}/interview/sessions")
def start_session(persona_id: str, body: StartBody, user: dict = CurrentUser):
    """Start an interview — or resume this user's unfinished one with the same speaker."""
    require_role(persona_id, user, "editor")
    p = _persona_or_404(persona_id)
    return start_or_resume(p, user, body.speaker or ("family" if p["passed"] else "subject"))


def start_or_resume(p: dict, user: dict, speaker: str) -> dict:
    """Core of starting a session; callers have already authorised `user` for persona `p`."""
    persona_id = p["id"]
    open_s = db.one(
        """SELECT * FROM interview_sessions WHERE persona_id = ? AND user_id = ? AND speaker = ? AND ended_at IS NULL
           ORDER BY session_number DESC LIMIT 1""",
        (persona_id, user["id"], speaker),
    )
    if open_s:
        return {"session": _session_out(open_s, turns=True), "resumed": True, "coverage": _coverage_out(persona_id)["stats"]}

    story = store.get_story(p)
    rel = engine.relationship_of(persona_id, user["id"])
    has_history = bool(db.one("SELECT 1 FROM interview_turns WHERE persona_id = ? LIMIT 1", (persona_id,)))
    onboarding = speaker == "subject" and not story["onboarding_complete"]

    if onboarding:
        opener = {"message": agents.opening_onboarding(p), "question_id": None}
    elif not has_history:
        opener = ({"message": agents.opening_first_interview(), "question_id": 1} if speaker == "subject"
                  else {"message": agents.opening_family_first(p, user), "question_id": None})
    else:
        opener = agents.session_opener(p, story, speaker, user, rel)

    s = store.create_session(persona_id, user["id"], speaker, onboarding)
    store.add_turn(s, "agent", opener["message"], opener["question_id"], None if onboarding else "advance")
    db.update("interview_sessions", "id", s["id"], {"last_question": qs.valid_id(opener["question_id"])})
    s = db.one("SELECT * FROM interview_sessions WHERE id = ?", (s["id"],))
    return {"session": _session_out(s, turns=True), "resumed": False, "coverage": _coverage_out(persona_id)["stats"]}


def _session_or_404(sid: str, user: dict, minimum: str = "editor") -> dict:
    s = db.one("SELECT * FROM interview_sessions WHERE id = ?", (sid,))
    if not s:
        raise HTTPException(404, "Interview session not found")
    require_role(s["persona_id"], user, minimum)
    return s


@router.get("/interview/sessions/{sid}")
def get_session(sid: str, user: dict = CurrentUser):
    s = _session_or_404(sid, user, "editor")
    s["user_name"] = (db.one("SELECT name FROM users WHERE id = ?", (s["user_id"],)) or {}).get("name")
    return _session_out(s, turns=True)


class AnswerBody(BaseModel):
    text: str = Field(min_length=1, max_length=8000)


@router.post("/interview/sessions/{sid}/turns")
def answer(sid: str, body: AnswerBody, user: dict = CurrentUser):
    return answer_turn(_session_or_404(sid, user), user, body.text)


def answer_turn(s: dict, user: dict, raw_text: str) -> dict:
    """Core of one interview turn; callers have already authorised `user` for this session's persona."""
    sid = s["id"]
    if s["ended_at"]:
        raise HTTPException(409, "This interview session has ended — start a new one")
    if s["user_id"] != user["id"]:
        raise HTTPException(403, "Only the person who started this session can answer in it")
    p = _persona_or_404(s["persona_id"])
    story = store.get_story(p)
    text = raw_text.strip()
    rel = engine.relationship_of(p["id"], user["id"])

    if s["onboarding"] and not story["onboarding_complete"]:
        r = agents.onboarding_turn(p, story, text)
        store.add_turn(s, "user", text)
        message, qid, move = r["message"], None, None
        if r["complete"]:
            store.update_story(p["id"], onboarding_complete=1)
            message += agents.ONBOARDING_COMPLETE_SUFFIX
            qid = 1
        db.update("interview_sessions", "id", sid, {"onboarding": 0 if r["complete"] else 1, "last_question": qid})
        provider, onboarding = r["provider"], not r["complete"]
    else:
        r = agents.interview_turn(p, story, s, user, rel, text)
        store.add_turn(s, "user", text, s["last_question"])
        message, qid, move, provider, onboarding = r["message"], r["question_id"], r["move_type"], r["provider"], False
        db.update("interview_sessions", "id", sid, {"last_question": qid, "onboarding": 0})

    store.add_turn(s, "agent", message, qid, move)
    return {"message": message, "question_id": qid, "move_type": move, "provider": provider,
            "onboarding": onboarding, "coverage": _coverage_out(p["id"])["stats"]}


def save_session_as_recording(s: dict) -> Optional[str]:
    """Turn a finished interview into a recording so ingestion makes memories from it."""
    turns = store.session_turns(s["id"])
    if not any(t["role"] == "user" for t in turns):
        return None
    p = _persona_or_404(s["persona_id"])
    u = db.one("SELECT name FROM users WHERE id = ?", (s["user_id"],)) or {"name": "Family member"}
    speaker = agents.first_name(p["name"]) if s["speaker"] == "subject" else u["name"]
    transcript = "\n\n".join(f"{'Interviewer' if t['role'] == 'agent' else speaker}: {t['content']}" for t in turns)
    rid = db.new_id()
    title = (f"Life-story interview · session {s['session_number']}" if s["speaker"] == "subject"
             else f"Memories of {agents.first_name(p['name'])} from {u['name']} · interview {s['session_number']}")
    with db.tx() as c:
        c.execute(
            """INSERT INTO recordings (id, persona_id, uploaded_by, title, source_type, speaker_mode, notes, status,
               status_detail, transcript_text, transcript_source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (rid, p["id"], s["user_id"], title, "text", "interview" if s["speaker"] == "subject" else "family_account",
             "Saved automatically from the Life Story interview.", "queued", "Waiting to be processed…",
             transcript, "interview", db.now()),
        )
        c.execute("UPDATE interview_sessions SET recording_id = ? WHERE id = ?", (rid, s["id"]))
    ingestion.enqueue(rid)
    return rid


@router.post("/interview/sessions/{sid}/end")
def end_session(sid: str, user: dict = CurrentUser):
    return end_interview(_session_or_404(sid, user))


def end_interview(s: dict) -> dict:
    sid = s["id"]
    if s["ended_at"]:
        return {"ok": True, "recording_id": s["recording_id"]}
    db.execute("UPDATE interview_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL", (db.now(), sid))
    rid = save_session_as_recording(s)
    return {"ok": True, "recording_id": rid}


# ── Biography ───────────────────────────────────────────────────────────────

def _write_job(bio_id: str, persona_id: str) -> None:
    try:
        p = _persona_or_404(persona_id)
        md, provider = agents.write_biography(p)
        db.update("biographies", "id", bio_id, {"status": "ready", "status_detail": "", "content_md": md,
                                                "provider": provider})
    except ProviderError as exc:
        msg = str(exc)
        detail = ("The free AI quota is used up for now. Wait a minute and try again." if "429" in msg
                  else "No AI provider could write the biography (check GROQ_API_KEY / GEMINI_API_KEY).")
        print(f"  [lifestory] biography failed: {msg}")
        db.update("biographies", "id", bio_id, {"status": "failed", "status_detail": detail})
    except Exception as exc:  # noqa: BLE001 — surface every failure in the UI
        traceback.print_exc()
        db.update("biographies", "id", bio_id, {"status": "failed", "status_detail": str(exc)[:400]})


@router.post("/personas/{persona_id}/biography")
def generate_biography(persona_id: str, user: dict = CurrentUser):
    require_role(persona_id, user, "editor")
    p = _persona_or_404(persona_id)
    with _bio_lock:
        latest = _latest_bio(persona_id)
        if latest and latest["status"] == "generating":
            return _bio_out(latest)
        src = agents.writer_sources(p)
        if src["user_turns"] < 2 and src["memory_count"] < 1:
            raise HTTPException(400, "Not enough material yet. Answer a few interview questions or add a recording first.")
        bid = db.new_id()
        db.insert("biographies", {"id": bid, "persona_id": persona_id, "status": "generating",
                                  "status_detail": "Planning chapters and writing — this takes a minute or two…",
                                  "generated_by": user["id"], "created_at": db.now()})
    _bio_executor.submit(_write_job, bid, persona_id)
    return _bio_out(_latest_bio(persona_id))


@router.get("/personas/{persona_id}/biography")
def get_biography(persona_id: str, user: dict = CurrentUser):
    require_role(persona_id, user, "listener")
    b = _latest_bio(persona_id)
    if not b:
        raise HTTPException(404, "No biography generated yet")
    return _bio_out(b)


@router.delete("/biographies/{bio_id}")
def delete_biography(bio_id: str, user: dict = CurrentUser):
    b = db.one("SELECT persona_id FROM biographies WHERE id = ?", (bio_id,))
    if not b:
        raise HTTPException(404, "Biography not found")
    require_role(b["persona_id"], user, "editor")
    db.execute("DELETE FROM biographies WHERE id = ?", (bio_id,))
    return {"ok": True}


def resume_pending() -> None:
    """Biographies interrupted by a restart can't resume mid-generation: mark them failed."""
    db.execute("UPDATE biographies SET status = 'failed', status_detail = ? WHERE status = 'generating'",
               ("Interrupted by a server restart — please generate again.",))


router.on_startup.append(resume_pending)
