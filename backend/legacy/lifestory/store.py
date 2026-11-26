"""Life Story persistence (Bio-per3 database.js, on the shared Legacy data layer)."""
from __future__ import annotations

import json
from typing import Optional

from .. import db
from . import questions as qs


# ── Settings + profile ───────────────────────────────────────────────────────

def get_story(persona: dict) -> dict:
    """The persona's life_story row, created on first use with the name pre-filled."""
    sql = "SELECT * FROM life_story WHERE persona_id = ?"
    row = db.one(sql, (persona["id"],))
    if not row:
        db.execute(
            "INSERT OR IGNORE INTO life_story (persona_id, profile, updated_at) VALUES (?,?,?)",
            (persona["id"], json.dumps({"name": persona["name"]}), db.now()),
        )
        row = db.one(sql, (persona["id"],))
    row["profile"] = db.jload(row["profile"], {})
    return row


def update_story(persona_id: str, **fields) -> None:
    if "profile" in fields:
        fields["profile"] = json.dumps(fields["profile"])
    fields["updated_at"] = db.now()
    db.update("life_story", "persona_id", persona_id, fields)


def merge_profile(persona: dict, updates) -> None:
    if not isinstance(updates, dict):
        return
    clean = {str(k): v for k, v in updates.items() if v not in (None, "", [], {}) and str(k) != "onboardingComplete"}
    if not clean:
        return
    story = get_story(persona)
    update_story(persona["id"], profile={**story["profile"], **clean})


# ── Coverage ─────────────────────────────────────────────────────────────────

def coverage(persona_id: str) -> dict[int, str]:
    rows = db.all_rows("SELECT question_id, status FROM interview_coverage WHERE persona_id = ?", (persona_id,))
    return {int(r["question_id"]): r["status"] for r in rows}


def mark_coverage(persona_id: str, question_id, status: str, source: str = "interview") -> None:
    """Upsert; never downgrades covered → partial."""
    qid = qs.valid_id(question_id)
    if qid is None or status not in ("partial", "covered"):
        return
    db.execute(
        """INSERT INTO interview_coverage (persona_id, question_id, status, source, updated_at) VALUES (?,?,?,?,?)
           ON CONFLICT (persona_id, question_id) DO UPDATE SET
             status = CASE WHEN interview_coverage.status = 'covered' THEN 'covered' ELSE excluded.status END,
             updated_at = excluded.updated_at""",
        (persona_id, qid, status, source, db.now()),
    )


# ── Threads ──────────────────────────────────────────────────────────────────

def open_threads(persona_id: str) -> list[dict]:
    return db.all_rows(
        f"""SELECT t.id, t.text, t.sensitivity, t.recording_id, r.title AS recording_title, t.created_at
            FROM interview_threads t LEFT JOIN recordings r ON r.id = t.recording_id
            WHERE t.persona_id = ? AND t.status = 'open' ORDER BY t.created_at, t.{db.order_tiebreak()}""",
        (persona_id,),
    )


def add_thread(persona_id: str, text: str, sensitivity: Optional[str] = None,
               recording_id: Optional[str] = None) -> None:
    text = str(text or "").strip()
    if not text:
        return
    if db.one("SELECT 1 FROM interview_threads WHERE persona_id = ? AND lower(text) = lower(?)", (persona_id, text)):
        return
    sens = "sensitive" if sensitivity == "sensitive" or qs.is_sensitive(text) else "normal"
    db.insert("interview_threads", {
        "id": db.new_id(), "persona_id": persona_id, "text": text[:500], "status": "open",
        "sensitivity": sens, "recording_id": recording_id, "created_at": db.now(),
    })


# ── Sessions + turns ─────────────────────────────────────────────────────────

def create_session(persona_id: str, user_id: str, speaker: str, onboarding: bool) -> dict:
    n = db.one("SELECT count(*) AS n FROM interview_sessions WHERE persona_id = ?", (persona_id,))["n"]
    sid = db.new_id()
    db.insert("interview_sessions", {
        "id": sid, "persona_id": persona_id, "user_id": user_id, "speaker": speaker,
        "session_number": int(n) + 1, "onboarding": int(onboarding), "started_at": db.now(),
    })
    return db.one("SELECT * FROM interview_sessions WHERE id = ?", (sid,))


def add_turn(session: dict, role: str, content: str, question_id=None, move_type: Optional[str] = None) -> None:
    db.insert("interview_turns", {
        "id": db.new_id(), "session_id": session["id"], "persona_id": session["persona_id"], "role": role,
        "content": content, "question_id": qs.valid_id(question_id), "move_type": move_type, "created_at": db.now(),
    })


def session_turns(session_id: str) -> list[dict]:
    return db.all_rows(
        f"""SELECT id, role, content, question_id, move_type, created_at FROM interview_turns
            WHERE session_id = ? ORDER BY created_at, {db.order_tiebreak()}""",
        (session_id,),
    )


def recent_turns(persona_id: str, n: int = 12) -> list[dict]:
    rows = db.all_rows(
        f"""SELECT t.role, t.content, s.speaker FROM interview_turns t JOIN interview_sessions s ON s.id = t.session_id
            WHERE t.persona_id = ? ORDER BY t.created_at DESC, t.{db.order_tiebreak()} DESC LIMIT ?""",
        (persona_id, n),
    )
    return list(reversed(rows))


def all_turns(persona_id: str) -> list[dict]:
    return db.all_rows(
        f"""SELECT t.role, t.content, t.session_id, s.speaker, s.session_number, u.name AS user_name
            FROM interview_turns t JOIN interview_sessions s ON s.id = t.session_id
            JOIN users u ON u.id = s.user_id
            WHERE t.persona_id = ? ORDER BY s.session_number, t.created_at, t.{db.order_tiebreak()}""",
        (persona_id,),
    )


def last_ended_session(persona_id: str) -> Optional[dict]:
    return db.one(
        """SELECT * FROM interview_sessions WHERE persona_id = ? AND ended_at IS NOT NULL
           ORDER BY session_number DESC LIMIT 1""",
        (persona_id,),
    )


def interview_recording_ids(persona_id: str) -> set[str]:
    rows = db.all_rows(
        "SELECT recording_id FROM interview_sessions WHERE persona_id = ? AND recording_id IS NOT NULL", (persona_id,))
    return {r["recording_id"] for r in rows}
