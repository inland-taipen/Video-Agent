"""Life Story (ported Bio-per3 interviewer + biographer), fully offline.

Providers are disabled, so the interviewer falls back to the coverage map; AI
calls that need a real model are monkeypatched where a test needs their output.
"""
from __future__ import annotations

import time

import pytest

from test_legacy import STORY, client, make_persona, signup, wait_status  # noqa: F401 — fixtures/helpers


def setup_persona(c, **kw):
    h = signup(c, "owner@example.com", "Asha")
    pid = make_persona(c, h, **kw).json()["id"]
    return h, pid


def start(c, h, pid, **body):
    r = c.post(f"/api/legacy/personas/{pid}/interview/sessions", json=body, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def answer(c, h, sid, text):
    r = c.post(f"/api/legacy/interview/sessions/{sid}/turns", json={"text": text}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def test_overview_has_80_questions_in_5_sections(client):
    h, pid = setup_persona(client, passed=None)
    o = client.get(f"/api/legacy/personas/{pid}/lifestory", headers=h).json()
    assert o["coverage"]["stats"] == {"covered": 0, "partial": 0, "untouched": 80, "total": 80, "percent": 0}
    assert [len(s["questions"]) for s in o["coverage"]["sections"]] == [16, 16, 16, 16, 16]
    assert o["default_speaker"] == "subject"
    assert o["profile"]["name"] == "Ramesh Kulkarni"


def test_subject_interview_onboards_then_follows_coverage_map(client):
    h, pid = setup_persona(client, passed=None)
    s = start(client, h, pid)
    assert s["session"]["onboarding"] == 1 and "honour" in s["session"]["turns"][0]["content"]

    # Offline onboarding completes immediately and hands over to Q1.
    r = answer(client, h, s["session"]["id"], "I was born in Nashik in 1950.")
    assert r["onboarding"] is False and r["question_id"] == 1 and r["provider"] == "mock"

    # Offline interviewer: marks the question being answered, advances via the coverage map.
    r = answer(client, h, s["session"]["id"], "Near the Godavari river, in a small house.")
    assert r["question_id"] and r["question_id"] != 1
    assert r["coverage"]["partial"] == 1

    # Starting again resumes the same unfinished session.
    again = start(client, h, pid)
    assert again["resumed"] and again["session"]["id"] == s["session"]["id"]
    assert len(again["session"]["turns"]) == 5


def test_ending_session_saves_it_as_memories(client):
    h, pid = setup_persona(client, passed=None)
    sid = start(client, h, pid)["session"]["id"]
    answer(client, h, sid, "I was born in Nashik.")
    answer(client, h, sid, STORY)
    rid = client.post(f"/api/legacy/interview/sessions/{sid}/end", json={}, headers=h).json()["recording_id"]
    assert rid
    rec = wait_status(client, h, rid, {"ready"})
    assert rec["speaker_mode"] == "interview" and len(rec["memories"]) > 0
    assert client.post(f"/api/legacy/interview/sessions/{sid}/turns", json={"text": "more"}, headers=h).status_code == 409

    # The next session is a returning one (no onboarding) and opens with a question.
    s2 = start(client, h, pid)
    assert not s2["resumed"] and s2["session"]["session_number"] == 2 and s2["session"]["onboarding"] == 0


def test_empty_session_is_not_saved(client):
    h, pid = setup_persona(client, passed=None)
    sid = start(client, h, pid)["session"]["id"]
    assert client.post(f"/api/legacy/interview/sessions/{sid}/end", json={}, headers=h).json()["recording_id"] is None


def test_family_interview_for_a_persona_who_has_passed(client):
    h, pid = setup_persona(client)  # make_persona sets passed=2021
    s = start(client, h, pid)
    assert s["session"]["speaker"] == "family" and s["session"]["onboarding"] == 0
    assert "Ramesh" in s["session"]["turns"][0]["content"]
    sid = s["session"]["id"]
    answer(client, h, sid, "He took us to the river ghats every Sunday for jalebis.")
    rid = client.post(f"/api/legacy/interview/sessions/{sid}/end", json={}, headers=h).json()["recording_id"]
    rec = wait_status(client, h, rid, {"ready"})
    assert rec["speaker_mode"] == "family_account"


def test_family_recording_updates_coverage_and_threads(client, monkeypatch):
    from legacy.lifestory import agents

    calls = []

    def fake_json_call(order, system, prompt, **kw):
        calls.append(system)
        assert "QUESTION LIST" in prompt and "Godavari" in prompt
        return {"profileUpdates": {"birthPlace": "Nashik"},
                "coverageUpdates": [{"questionId": 1, "status": "covered"}, {"questionId": 999, "status": "covered"},
                                    {"questionId": 4, "status": "partial"}],
                "newThreads": [{"text": "His sister Meena and the Sunday jalebis", "sensitivity": "normal"},
                               {"text": "How his mother died", "sensitivity": "normal"}],
                "summary": "Childhood in Nashik."}, "fake"

    monkeypatch.setattr(agents, "_json_call", fake_json_call)
    h, pid = setup_persona(client)
    r = client.post(f"/api/legacy/personas/{pid}/recordings", data={"title": "Childhood", "transcript": STORY,
                                                                      "speaker_mode": "family_account"}, headers=h)
    rec = wait_status(client, h, r.json()["id"], {"ready"})
    assert "touches 2 life-story questions" in rec["status_detail"]

    o = client.get(f"/api/legacy/personas/{pid}/lifestory", headers=h).json()
    assert o["coverage"]["stats"]["covered"] == 1 and o["coverage"]["stats"]["partial"] == 1
    q1 = o["coverage"]["sections"][0]["questions"][0]
    assert q1["status"] == "covered" and q1["source"] == "recording"
    assert o["profile"]["birthPlace"] == "Nashik"
    threads = {t["text"]: t for t in o["threads"]}
    assert threads["How his mother died"]["sensitivity"] == "sensitive"  # keyword check overrides the model
    assert threads["His sister Meena and the Sunday jalebis"]["recording_title"] == "Childhood"

    # Retrying the recording doesn't duplicate threads; dismissing one hides it.
    client.post(f"/api/legacy/recordings/{r.json()['id']}/retry", headers=h)
    wait_status(client, h, r.json()["id"], {"ready"})
    o = client.get(f"/api/legacy/personas/{pid}/lifestory", headers=h).json()
    assert len(o["threads"]) == 2
    tid = o["threads"][0]["id"]
    assert client.patch(f"/api/legacy/threads/{tid}", json={"status": "dismissed"}, headers=h).status_code == 200
    assert len(client.get(f"/api/legacy/personas/{pid}/lifestory", headers=h).json()["threads"]) == 1


def test_coverage_never_downgrades(client):
    from legacy.lifestory import store
    h, pid = setup_persona(client)
    store.mark_coverage(pid, 5, "covered")
    store.mark_coverage(pid, 5, "partial")
    store.mark_coverage(pid, "abc", "covered")
    assert store.coverage(pid) == {5: "covered"}


def wait_bio(c, h, pid, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        b = c.get(f"/api/legacy/personas/{pid}/biography", headers=h).json()
        if b["status"] != "generating":
            return b
        time.sleep(0.1)
    raise AssertionError("biography still generating")


def test_biography_needs_material_and_reports_missing_ai(client):
    h, pid = setup_persona(client)
    assert client.post(f"/api/legacy/personas/{pid}/biography", headers=h).status_code == 400
    assert client.get(f"/api/legacy/personas/{pid}/biography", headers=h).status_code == 404

    r = client.post(f"/api/legacy/personas/{pid}/recordings", data={"title": "Story", "transcript": STORY}, headers=h)
    wait_status(client, h, r.json()["id"], {"ready"})
    assert client.post(f"/api/legacy/personas/{pid}/biography", headers=h).json()["status"] == "generating"
    b = wait_bio(client, h, pid)
    assert b["status"] == "failed" and "provider" in b["status_detail"]


def test_biography_uses_interview_and_family_memories(client, monkeypatch):
    from legacy.lifestory import agents
    seen = {}

    def fake_complete(order, system, messages, **kw):
        prompt = messages[0]["content"]
        if "plan the biography" in system:
            return '{"title":"Ramesh Kulkarni","subtitle":"Temple Bell","epigraph":"","throughline":"","chapters":[{"title":"River","focus":"Nashik"}]}', "fake"
        seen["prompt"] = prompt
        return "# Ramesh Kulkarni: Temple Bell\n\n## River\n\nProse.", "fake"

    monkeypatch.setattr(agents, "complete_with_fallback", fake_complete)
    h, pid = setup_persona(client)
    sid = start(client, h, pid)["session"]["id"]
    answer(client, h, sid, "He laughed at his own jokes before finishing them.")
    answer(client, h, sid, "He called everyone beta.")
    rid = client.post(f"/api/legacy/interview/sessions/{sid}/end", json={}, headers=h).json()["recording_id"]
    wait_status(client, h, rid, {"ready"})
    r = client.post(f"/api/legacy/personas/{pid}/recordings",
                    data={"title": "Wedding", "transcript": STORY, "speaker_mode": "family_account"}, headers=h)
    wait_status(client, h, r.json()["id"], {"ready"})

    client.post(f"/api/legacy/personas/{pid}/biography", headers=h)
    b = wait_bio(client, h, pid)
    assert b["status"] == "ready" and b["content_md"].startswith("# Ramesh Kulkarni")
    assert "laughed at his own jokes" in seen["prompt"]  # interview transcript
    assert "[FAMILY ACCOUNT]" in seen["prompt"]          # family memories, attributed
    # Memories extracted from the interview itself aren't duplicated into the memory list.
    assert seen["prompt"].count("called everyone beta") == 1

    assert client.delete(f"/api/legacy/biographies/{b['id']}", headers=h).status_code == 200
    assert client.get(f"/api/legacy/personas/{pid}/biography", headers=h).status_code == 404


def test_roles_listeners_read_only_and_outsiders_404(client):
    h, pid = setup_persona(client)
    client.post(f"/api/legacy/personas/{pid}/members", json={"email": "kid@example.com", "role": "listener",
                                                             "relationship": "grandson"}, headers=h)
    hl = signup(client, "kid@example.com", "Kid")
    ho = signup(client, "stranger@example.com", "Stranger")
    assert client.get(f"/api/legacy/personas/{pid}/lifestory", headers=hl).status_code == 200
    assert client.post(f"/api/legacy/personas/{pid}/interview/sessions", json={}, headers=hl).status_code == 403
    assert client.patch(f"/api/legacy/personas/{pid}/lifestory", json={"background": "x"}, headers=hl).status_code == 403
    assert client.get(f"/api/legacy/personas/{pid}/lifestory", headers=ho).status_code == 404
    sid = start(client, h, pid)["session"]["id"]
    assert client.get(f"/api/legacy/interview/sessions/{sid}", headers=ho).status_code == 404


def test_background_is_used_by_the_interviewer(client):
    from legacy import db
    from legacy.lifestory import agents, store
    h, pid = setup_persona(client, passed=None)
    assert client.patch(f"/api/legacy/personas/{pid}/lifestory",
                        json={"background": "Chairman of FICCI WRC.", "reference_material": "OMC Power, 2011."},
                        headers=h).status_code == 200
    p = db.one("SELECT * FROM personas WHERE id = ?", (pid,))
    system = agents.interviewer_system(p, store.get_story(p), "subject", {"name": "Asha"}, "")
    assert "Chairman of FICCI WRC." in system and "OMC Power, 2011." in system and "ONE question" in system


def test_onboarding_completion_never_stacks_two_questions(client, monkeypatch):
    from legacy.lifestory import agents
    monkeypatch.setattr(agents, "_json_call", lambda *a, **k: (
        {"response": "Thank you, that is lovely. What did your mother cook?", "onboardingComplete": True}, "fake"))
    h, pid = setup_persona(client, passed=None)
    sid = start(client, h, pid)["session"]["id"]
    r = answer(client, h, sid, "Born in Nashik; my wife and daughters matter most.")
    assert "What did your mother cook" not in r["message"]
    assert r["message"].count("?") == 1 and r["question_id"] == 1


def test_private_story_link_opens_only_the_subjects_interview(client):
    h, pid = setup_persona(client, passed=None)
    from legacy import db
    client.get(f"/api/legacy/personas/{pid}/lifestory", headers=h)  # creates the life_story row
    db.update("life_story", "persona_id", pid, {"page": '{"pull_quote": "A builder."}'})

    other = signup(client, "editor@example.com", "Ed")
    client.post(f"/api/legacy/personas/{pid}/members", json={"email": "editor@example.com", "role": "editor",
                                                             "relationship": "son"}, headers=h)
    assert client.post(f"/api/legacy/personas/{pid}/story-link", headers=other).status_code == 403  # owners only
    token = client.post(f"/api/legacy/personas/{pid}/story-link", headers=h).json()["token"]
    assert client.get(f"/api/legacy/personas/{pid}/story-link", headers=h).json()["active"] is True

    page = client.get(f"/api/legacy/story/{token}").json()  # no Authorization header
    assert page["name"] == "Ramesh Kulkarni" and page["page"]["pull_quote"] == "A builder." and page["open_session"] is None
    assert "memories" not in page and "members" not in page

    s = client.post(f"/api/legacy/story/{token}/sessions").json()["session"]
    assert s["speaker"] == "subject" and s["onboarding"] == 1
    r = client.post(f"/api/legacy/story/{token}/sessions/{s['id']}/turns", json={"text": "Born in Nashik."}).json()
    assert r["question_id"] == 1
    assert client.get(f"/api/legacy/story/{token}").json()["open_session"]["id"] == s["id"]  # resumes

    # The family sees the session in the app; the link can't touch a family member's session.
    o = client.get(f"/api/legacy/personas/{pid}/lifestory", headers=h).json()
    assert o["sessions"][0]["user_name"] == "Ramesh Kulkarni"
    fam = start(client, h, pid, speaker="family")["session"]["id"]
    assert client.post(f"/api/legacy/story/{token}/sessions/{fam}/turns", json={"text": "x"}).status_code == 404

    rid = client.post(f"/api/legacy/story/{token}/sessions/{s['id']}/end").json()["recording_id"]
    assert wait_status(client, h, rid, {"ready"})["speaker_mode"] == "interview"

    # The link account can't sign in.
    link_email = db.one("SELECT email FROM users WHERE name = 'Ramesh Kulkarni'")["email"]
    assert client.post("/api/legacy/auth/login", json={"email": link_email, "password": "anything"}).status_code != 200

    # Regenerate: old link dies, new one continues the same story.
    new = client.post(f"/api/legacy/personas/{pid}/story-link", headers=h).json()["token"]
    assert client.get(f"/api/legacy/story/{token}").status_code == 404
    assert client.get(f"/api/legacy/story/{new}").json()["sessions_done"] == 1
    client.delete(f"/api/legacy/personas/{pid}/story-link", headers=h)
    assert client.get(f"/api/legacy/story/{new}").status_code == 404
    assert client.get("/api/legacy/story/made-up-token").status_code == 404


def test_story_link_sharing_chapters_and_past_conversations(client):
    h, pid = setup_persona(client, passed=None)
    token = client.post(f"/api/legacy/personas/{pid}/story-link", headers=h).json()["token"]

    page = client.get(f"/api/legacy/story/{token}").json()
    assert [s["total"] for s in page["sections"]] == [16] * 5 and page["sections"][0]["covered"] == 0

    # Share a written note (title optional) and a voice memo.
    r = client.post(f"/api/legacy/story/{token}/recordings", data={"transcript": STORY})
    assert r.status_code == 200 and r.json()["title"].startswith("Written note from Ramesh")
    memo = client.post(f"/api/legacy/story/{token}/recordings", data={"title": "Memo"},
                       files={"file": ("memo.webm", b"\x1aE\xdf\xa3fake", "audio/webm")})
    assert memo.status_code == 200 and memo.json()["source_type"] == "audio"
    assert client.post(f"/api/legacy/story/{token}/recordings", data={}).status_code == 400
    assert client.post(f"/api/legacy/story/{token}/recordings",
                       files={"file": ("x.pdf", b"%PDF", "application/pdf")}).status_code == 400
    rec = wait_status(client, h, r.json()["id"], {"ready"})
    assert rec["speaker_mode"] == "transcript" and rec["memories"]  # his own words → memories

    # A finished interview shows under past conversations, not under shared items.
    s = client.post(f"/api/legacy/story/{token}/sessions").json()["session"]
    client.post(f"/api/legacy/story/{token}/sessions/{s['id']}/turns", json={"text": "Born in Nashik."})
    rid = client.post(f"/api/legacy/story/{token}/sessions/{s['id']}/end").json()["recording_id"]
    wait_status(client, h, rid, {"ready"})
    shared = client.get(f"/api/legacy/story/{token}/recordings").json()
    assert {x["title"] for x in shared} == {r.json()["title"], "Memo"}
    past = client.get(f"/api/legacy/story/{token}/sessions").json()
    assert len(past) == 1 and past[0]["turns"][1]["content"] == "Born in Nashik."

    # Family uploads and family interview sessions never show on his link.
    client.post(f"/api/legacy/personas/{pid}/recordings", data={"title": "Family", "transcript": STORY}, headers=h)
    assert len(client.get(f"/api/legacy/story/{token}/recordings").json()) == 2
    fam = start(client, h, pid, speaker="family")["session"]["id"]
    answer(client, h, fam, "He loved jalebis.")
    client.post(f"/api/legacy/interview/sessions/{fam}/end", json={}, headers=h)
    assert len(client.get(f"/api/legacy/story/{token}/sessions").json()) == 1
    client.delete(f"/api/legacy/personas/{pid}/story-link", headers=h)
    assert client.get(f"/api/legacy/story/{token}/sessions").status_code == 404
