"""Create a demo account with a FICTIONAL persona so the full journey can be tried
without uploading anything. Runs the real ingestion pipeline (AI extraction and
embeddings if keys work, offline fallbacks otherwise).

    cd backend && .venv/bin/python -m legacy.seed_demo
"""
from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=True)

from . import auth, db, ingestion  # noqa: E402

EMAIL, PASSWORD = "demo@example.com", "demo-legacy"

STORIES = [
    ("Growing up in Nashik", """I was born in 1950 in Nashik. My father had a small cloth shop near the Godavari river.
Every Sunday he took me and my sister Meena to the river ghats and bought us hot jalebis. Arre, those jalebis! Nothing tastes like that now.

My mother, Sushila, woke up at five every morning to fill water from the municipal tap. She never once complained. She used to say, "Work is worship, beta.\""""),
    ("Joining the railways", """In 1971 I got a job in the railways as a junior clerk in Bombay. Ninety rupees a month, and I sent half of it home to my mother.
I lived in a chawl in Dadar with four other boys. We cooked on one kerosene stove and took turns making dal. My friend Prakash burned it every single time.

I retired in 2010 as a section officer. Thirty-nine years, and I was late only twice. Once was the 2005 floods, when I walked home for six hours through water up to my waist."""),
    ("Meeting Kamala", """I met your grandmother Kamala at a wedding in Pune in 1975. She was laughing so loudly at some joke that the whole hall turned around.
I told her she laughed like a temple bell. She did not speak to me for one hour after that!
We were married the next spring, in April 1976. Her father made me promise I would bring her to Pune every Diwali, and I kept that promise for forty-five years."""),
    ("Advice for the grandchildren", """Hard work and honesty, beta. That is all I ever had, and it was enough.
Don't chase money. Chase good sleep. A man who sleeps well at night has done nothing to be ashamed of.
And call your mother. Even when you are busy. Especially when you are busy."""),
]


def main() -> None:
    user = db.one("SELECT * FROM users WHERE email = ?", (EMAIL,))
    if not user:
        uid = db.new_id()
        db.insert("users", {"id": uid, "email": EMAIL, "name": "Demo Family Member",
                            "password_hash": auth.hash_password(PASSWORD), "created_at": db.now()})
        user = db.one("SELECT * FROM users WHERE id = ?", (uid,))
    if db.one("SELECT 1 FROM personas WHERE is_demo = 1 AND created_by = ?", (user["id"],)):
        print(f"Demo already exists. Sign in with {EMAIL} / {PASSWORD}")
        return

    pid, ts = db.new_id(), db.now()
    db.insert("personas", {
        "id": pid, "name": "Ramesh Kulkarni (demo)", "born": "1950", "passed": "2021",
        "bio": "FICTIONAL demo persona. Retired railway section officer from Nashik; loved jalebis, cricket on the radio, and long walks.",
        "language": "en-IN", "is_demo": 1, "created_by": user["id"], "created_at": ts, "updated_at": ts,
    })
    db.insert("persona_members", {"persona_id": pid, "email": EMAIL, "user_id": user["id"], "role": "owner",
                                  "relationship": "granddaughter", "invited_by": user["id"], "created_at": ts})
    db.insert("consents", {"id": db.new_id(), "persona_id": pid, "user_id": user["id"], "kind": "persona_creation",
                           "relationship": "granddaughter", "statement": "Demo data — fictional persona.",
                           "ip": None, "user_agent": "seed_demo", "accepted_at": ts})
    for title, text in STORIES:
        rid = db.new_id()
        db.insert("recordings", {
            "id": rid, "persona_id": pid, "uploaded_by": user["id"], "title": title, "source_type": "text",
            "speaker_mode": "transcript", "transcript_text": text, "transcript_source": "text-upload",
            "status": "queued", "created_at": db.now(),
        })
        print(f"Processing '{title}'…")
        ingestion.process_recording(rid)
        r = db.one("SELECT status, status_detail FROM recordings WHERE id = ?", (rid,))
        print(f"  {r['status']}: {r['status_detail']}")
    print(f"\nDone. Sign in with {EMAIL} / {PASSWORD}")


if __name__ == "__main__":
    main()
