"""End-to-end API tests for Digital Legacy, fully offline.

All external providers are disabled, so this exercises the mock fallbacks:
no STT → needs_transcript, mock extraction, local hash embeddings, mock replies.
Run: cd backend && .venv/bin/python -m pytest tests -q
"""
from __future__ import annotations

import io
import json
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

STORY = """When I was nine we lived in Nashik, near the Godavari river. My father ran a small cloth shop on the main road.
Every Sunday he took me and my sister Meena to the river ghats and bought us hot jalebis from the corner stall.

In 1971 I joined the railways as a junior clerk in Bombay. The pay was ninety rupees a month, and I sent half of it home to my mother.

I met your grandmother Kamala at a wedding in Pune in 1975. She was laughing so loudly at a joke that the whole hall turned around.
I told her she laughed like a temple bell. We were married the next spring."""


@pytest.fixture()
def client(tmp_path, monkeypatch):
    for key in ("GROQ_API_KEY", "VITE_GROQ_API_KEY", "GEMINI_API_KEY", "ELEVENLABS_API_KEY"):
        monkeypatch.setenv(key, "")
    monkeypatch.setenv("LEGACY_DATA_DIR", str(tmp_path))
    from legacy import storage
    storage._backend = None  # pick up the temp dir
    from legacy.routes import router
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as c:
        yield c
    storage._backend = None


def signup(c, email, name="Asha"):
    r = c.post("/api/legacy/auth/register", json={"email": email, "name": name, "password": "correct horse"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def make_persona(c, h, **kw):
    body = {"name": "Ramesh Kulkarni", "born": "1950", "passed": "2021", "bio": "Railway clerk from Nashik.",
            "relationship": "granddaughter", "consent_accepted": True, **kw}
    r = c.post("/api/legacy/personas", json=body, headers=h)
    return r


def wait_status(c, h, rid, want, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        s = c.get(f"/api/legacy/recordings/{rid}", headers=h).json()
        if s["status"] in want:
            return s
        time.sleep(0.1)
    raise AssertionError(f"timed out; last status {s['status']}: {s['status_detail']}")


def ask(c, h, cid, text):
    r = c.post(f"/api/legacy/conversations/{cid}/messages", json={"text": text}, headers=h)
    assert r.status_code == 200
    events = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    return events[0], "".join(e["text"] for e in events if e["type"] == "delta"), events[-1]


def test_auth_required_and_consent_enforced(client):
    assert client.get("/api/legacy/personas").status_code == 401
    h = signup(client, "asha@example.com")
    assert make_persona(client, h, consent_accepted=False).status_code == 400
    r = make_persona(client, h)
    assert r.status_code == 200 and r.json()["role"] == "owner"
    detail = client.get(f"/api/legacy/personas/{r.json()['id']}", headers=h).json()
    assert detail["consents"][0]["kind"] == "persona_creation"
    # duplicate registration and bad login
    assert client.post("/api/legacy/auth/register", json={"email": "ASHA@example.com", "name": "x", "password": "12345678"}).status_code == 409
    assert client.post("/api/legacy/auth/login", json={"email": "asha@example.com", "password": "nope"}).status_code == 401


def test_text_ingestion_retrieval_and_grounded_conversation(client):
    h = signup(client, "asha@example.com")
    pid = make_persona(client, h).json()["id"]
    r = client.post(f"/api/legacy/personas/{pid}/recordings", headers=h,
                    data={"title": "Childhood and marriage", "transcript": STORY, "speaker_mode": "solo"})
    assert r.status_code == 200, r.text
    rec = wait_status(client, h, r.json()["id"], {"ready", "failed"})
    assert rec["status"] == "ready", rec["status_detail"]
    assert rec["extraction_source"] == "mock" and rec["memories"]
    assert all(m["embedding_model"].startswith("local-hash") for m in rec["memories"])

    hits = client.get(f"/api/legacy/personas/{pid}/memories", params={"q": "how did you meet Kamala"}, headers=h).json()
    assert "Kamala" in (hits[0]["summary"] + hits[0]["excerpt"])

    conv = client.post(f"/api/legacy/personas/{pid}/conversations", headers=h).json()
    assert "AI recreation" in conv["greeting"]

    meta, reply, done = ask(client, h, conv["conversation_id"], "Tell me how you met grandmother Kamala at the wedding in Pune")
    assert meta["grounded"] and meta["sources"]
    assert done["type"] == "done" and done["provider"] == "mock"
    assert "Kamala" in reply  # mock quotes the recorded words

    meta, reply, _ = ask(client, h, conv["conversation_id"], "What was your favourite cricket team in the world cup?")
    assert not meta["grounded"]
    assert "don't think I recorded" in reply

    turns = client.get(f"/api/legacy/conversations/{conv['conversation_id']}", headers=h).json()["turns"]
    assert [t["role"] for t in turns] == ["persona", "user", "persona", "user", "persona"]


def test_audio_without_stt_waits_for_manual_transcript(client):
    h = signup(client, "asha@example.com")
    pid = make_persona(client, h).json()["id"]
    audio = io.BytesIO(b"ID3" + b"\x00" * 2048)
    r = client.post(f"/api/legacy/personas/{pid}/recordings", headers=h, data={"title": "Tape 1"},
                    files={"file": ("tape1.mp3", audio, "audio/mpeg")})
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    rec = wait_status(client, h, rid, {"needs_transcript", "failed"})
    assert rec["status"] == "needs_transcript"

    # original file is preserved byte-for-byte and only served with auth
    assert client.get(f"/api/legacy/recordings/{rid}/audio").status_code == 401
    got = client.get(f"/api/legacy/recordings/{rid}/audio", headers=h)
    assert got.status_code == 200 and got.content == b"ID3" + b"\x00" * 2048

    assert client.post(f"/api/legacy/recordings/{rid}/transcript", json={"text": STORY}, headers=h).status_code == 200
    rec = wait_status(client, h, rid, {"ready", "failed"})
    assert rec["status"] == "ready" and rec["transcript_source"] == "manual"


def test_rejects_non_audio_upload(client):
    h = signup(client, "asha@example.com")
    pid = make_persona(client, h).json()["id"]
    r = client.post(f"/api/legacy/personas/{pid}/recordings", headers=h, data={"title": "x"},
                    files={"file": ("evil.html", io.BytesIO(b"<script>"), "text/html")})
    assert r.status_code == 400


def test_family_access_roles(client):
    owner = signup(client, "asha@example.com")
    pid = make_persona(client, owner).json()["id"]
    client.post(f"/api/legacy/personas/{pid}/recordings", headers=owner, data={"title": "s", "transcript": STORY})

    stranger = signup(client, "stranger@example.com", "Stranger")
    assert client.get(f"/api/legacy/personas/{pid}", headers=stranger).status_code == 404
    assert client.post(f"/api/legacy/personas/{pid}/conversations", headers=stranger).status_code == 404

    # invite before the cousin has an account → claimed on sign-up
    r = client.post(f"/api/legacy/personas/{pid}/members", headers=owner,
                    json={"email": "Cousin@Example.com", "role": "listener", "relationship": "grandson"})
    assert r.status_code == 200 and r.json()["joined"] is False
    cousin = signup(client, "cousin@example.com", "Ravi")
    assert [p["id"] for p in client.get("/api/legacy/personas", headers=cousin).json()] == [pid]

    # listener: can talk, cannot upload, cannot manage members, can't see emails
    assert client.post(f"/api/legacy/personas/{pid}/conversations", headers=cousin).status_code == 200
    assert client.post(f"/api/legacy/personas/{pid}/recordings", headers=cousin,
                       data={"title": "x", "transcript": "hi"}).status_code == 403
    assert client.post(f"/api/legacy/personas/{pid}/members", headers=cousin,
                       json={"email": "x@example.com"}).status_code == 403
    assert all(m["email"] is None for m in client.get(f"/api/legacy/personas/{pid}/members", headers=cousin).json())

    # conversations are private to each family member
    conv = client.post(f"/api/legacy/personas/{pid}/conversations", headers=owner).json()["conversation_id"]
    assert client.get(f"/api/legacy/conversations/{conv}", headers=cousin).status_code == 404

    # can't remove the last owner; can promote then demote
    assert client.delete(f"/api/legacy/personas/{pid}/members/asha@example.com", headers=owner).status_code == 400
    assert client.patch(f"/api/legacy/personas/{pid}/members/cousin@example.com", headers=owner,
                        json={"role": "editor"}).status_code == 200
    assert client.post(f"/api/legacy/personas/{pid}/recordings", headers=cousin,
                       data={"title": "x", "transcript": "We went to Shirdi."}).status_code == 200

    # removing access takes effect immediately
    assert client.delete(f"/api/legacy/personas/{pid}/members/cousin@example.com", headers=owner).status_code == 200
    assert client.get(f"/api/legacy/personas/{pid}", headers=cousin).status_code == 404


def test_storage_rejects_path_traversal(tmp_path):
    from legacy.storage import LocalStorage
    s = LocalStorage(tmp_path)
    with pytest.raises(ValueError):
        s.local_path("../../etc/passwd")
