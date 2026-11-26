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
import secrets
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import db
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
