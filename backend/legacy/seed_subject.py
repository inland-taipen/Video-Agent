"""Import a Bio-per3 subject (subject.config.js, exported to JSON) as a Legacy persona.

Bio-per3 deployed one app per subject. Here a subject is just a persona whose
Life Story tab carries the interviewer background + reference material, so you
can host any number of them in one deployment.

    cd backend && .venv/bin/python -m legacy.seed_subject --owner you@example.com [legacy/subjects/jiwarajka.json]

The owner must already have an account (sign up in the app first). Running it
again updates the background/reference material of the existing persona.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=True)

from . import db  # noqa: E402
from .lifestory import store  # noqa: E402
from .storage import get_storage, make_key  # noqa: E402

DEFAULT = Path(__file__).parent / "subjects" / "jiwarajka.json"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("subject", nargs="?", default=str(DEFAULT), help="subject JSON file")
    ap.add_argument("--owner", required=True, help="email of an existing account that will own the persona")
    ap.add_argument("--relationship", default="biographer", help="owner's relationship to the subject")
    args = ap.parse_args()

    path = Path(args.subject)
    s = json.loads(path.read_text())
    user = db.one("SELECT * FROM users WHERE lower(email) = lower(?)", (args.owner,))
    if not user:
        raise SystemExit(f"No account for {args.owner}. Sign up in the app first, then re-run.")

    existing = db.one(
        """SELECT p.* FROM personas p JOIN persona_members m ON m.persona_id = p.id
           WHERE m.user_id = ? AND m.role = 'owner' AND p.name = ?""",
        (user["id"], s["name"]),
    )
    if existing:
        pid = existing["id"]
        print(f"Updating existing persona '{s['name']}' ({pid})")
    else:
        pid, ts = db.new_id(), db.now()
        with db.tx() as c:
            c.execute(
                """INSERT INTO personas (id, name, born, passed, bio, language, created_by, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (pid, s["name"], s.get("born"), s.get("passed"), s.get("bio", ""), s.get("language", "en-IN"),
                 user["id"], ts, ts),
            )
            c.execute(
                """INSERT INTO persona_members (persona_id, email, user_id, role, relationship, invited_by, created_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (pid, user["email"], user["id"], "owner", args.relationship, user["id"], ts),
            )
            c.execute(
                """INSERT INTO consents (id, persona_id, user_id, kind, relationship, statement, ip, user_agent, accepted_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (db.new_id(), pid, user["id"], "persona_creation", args.relationship,
                 f"Imported by the owner from a Bio-per3 biographical-interview deployment ({s.get('source', path.name)}).",
                 None, "seed_subject", ts),
            )
        print(f"Created persona '{s['name']}' ({pid})")

    persona = db.one("SELECT * FROM personas WHERE id = ?", (pid,))
    story = store.get_story(persona)
    page = {k: s[k] for k in ("honorific", "pull_quote", "nameplate_title", "timeline", "bio_facts") if s.get(k)}
    store.update_story(pid, background=s.get("background", ""), reference_material=s.get("reference_material", ""),
                       profile={**story["profile"], "name": s["name"]}, page=json.dumps(page))

    photo = path.with_suffix(".png")
    if photo.exists() and not persona["photo_key"]:
        key = make_key(pid, "photo", photo.name)
        with photo.open("rb") as f:
            get_storage().put(key, f)
        db.update("personas", "id", pid, {"photo_key": key, "updated_at": db.now()})
        print("Added portrait")
    print("Done. Open the persona → Life story → Interviewer notes → create his private link.")


if __name__ == "__main__":
    main()
