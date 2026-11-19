"""Local email/password auth + per-persona role checks.

Dev implementation: PBKDF2 password hashes, opaque bearer tokens stored hashed.
When moving to Supabase, replace `current_user` with a dependency that verifies
the Supabase JWT; the role checks (`require_role`) stay the same.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, Header, HTTPException

from . import config, db

ROLE_RANK = {"listener": 1, "editor": 2, "owner": 3}
_ITERATIONS = 240_000


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _ITERATIONS)
    return f"pbkdf2_sha256${_ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iters, salt_hex, dk_hex = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(iters))
        return hmac.compare_digest(dk.hex(), dk_hex)
    except (ValueError, TypeError):
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=config.SESSION_DAYS)
    db.insert("sessions", {
        "token_hash": _token_hash(token),
        "user_id": user_id,
        "created_at": db.now(),
        "expires_at": expires.isoformat(timespec="seconds"),
    })
    return token


def revoke_session(token: str) -> None:
    db.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))


def claim_pending_invites(user_id: str, email: str) -> None:
    """Link invites that were sent to this email before the account existed."""
    db.execute(
        "UPDATE persona_members SET user_id = ? WHERE lower(email) = lower(?) AND user_id IS NULL",
        (user_id, email),
    )


def _bearer(authorization: Optional[str]) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Sign in required")
    return authorization.split(" ", 1)[1].strip()


def current_user(authorization: Optional[str] = Header(default=None)) -> dict:
    token = _bearer(authorization)
    row = db.one(
        """SELECT u.id, u.email, u.name, s.expires_at FROM sessions s
           JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?""",
        (_token_hash(token),),
    )
    if not row:
        raise HTTPException(401, "Session expired — please sign in again")
    if datetime.fromisoformat(row["expires_at"]) < datetime.now(timezone.utc):
        revoke_session(token)
        raise HTTPException(401, "Session expired — please sign in again")
    return {"id": row["id"], "email": row["email"], "name": row["name"], "token": token}


def role_for(persona_id: str, user_id: str) -> Optional[str]:
    row = db.one(
        "SELECT role FROM persona_members WHERE persona_id = ? AND user_id = ?",
        (persona_id, user_id),
    )
    return row["role"] if row else None


def require_role(persona_id: str, user: dict, minimum: str) -> str:
    """Raise 404 (not 403) for non-members so persona ids can't be probed."""
    role = role_for(persona_id, user["id"])
    if role is None:
        raise HTTPException(404, "Persona not found")
    if ROLE_RANK[role] < ROLE_RANK[minimum]:
        raise HTTPException(403, f"This needs {minimum} access; you are a {role}")
    return role


CurrentUser = Depends(current_user)
