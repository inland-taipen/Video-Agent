"""The Life Story agents, ported from Bio-per3:

* interviewer  (interviewerAgent.js) — onboarding, interview turns, session openers
* analyst      (uploadAgent.js)      — maps a family recording onto the coverage map
* writer       (writerAgent.js)      — two-pass biography: outline, then full prose

Bio-per3 hard-coded one subject in subject.config.js; here everything comes from
the persona + its life_story row. The interviewer can talk to the subject
themselves, or to a family member about them (when the subject has passed away).
"""
from __future__ import annotations

import re
from typing import Optional

from .. import config, db
from ..ingestion import _parse_json
from ..providers.http import ProviderError
from ..providers.llm import complete_with_fallback
from . import questions as qs
from . import store

MAX_SOURCE_CHARS = 40_000       # one recording sent to the analyst
MAX_BIO_TRANSCRIPT = 90_000     # interview transcript sent to the writer
MAX_BIO_MEMORIES = 40_000       # family memories sent to the writer


def first_name(name: str) -> str:
    return name.split()[0] if name.split() else name


def _json_call(order: list[str], system: str, prompt: str, *, temperature: float, max_tokens: int) -> tuple[dict, str]:
    text, provider = complete_with_fallback(
        order, system, [{"role": "user", "content": prompt}],
        json_mode=True, temperature=temperature, max_tokens=max_tokens,
    )
    data = _parse_json(text)
    if not isinstance(data, dict):
        raise ValueError("expected a JSON object")
    return data, provider


# ── Context blocks ───────────────────────────────────────────────────────────

def background_block(persona: dict, story: dict) -> str:
    parts = []
    facts = [persona.get("bio") or "", story.get("background") or ""]
    life = " – ".join(x for x in (persona.get("born"), persona.get("passed")) if x)
    if life:
        facts.insert(0, f"Life span: {life}")
    known = "\n".join(f for f in facts if f.strip())
    if known:
        parts.append("KNOWN BACKGROUND (use this to personalise questions — never ask what you already know):\n" + known)
    if (story.get("reference_material") or "").strip():
        parts.append(
            "REFERENCE MATERIAL — public events, initiatives and documented work.\n"
            "Do NOT treat this as already covered. It is a map of where the richest stories live: invite the "
            "speaker to expand on it in their own voice — the scene, the people, the emotion, the lesson.\n"
            + story["reference_material"].strip()
        )
    return "\n\n".join(parts)


def format_profile(profile: dict) -> str:
    labels = {
        "name": "Name", "birthDecade": "Birth decade", "birthPlace": "Birthplace", "hometown": "Hometown",
        "profession": "Profession / life focus", "lifeFocus": "Life centred on",
        "importantPeople": "Important people", "spouse": "Spouse/Partner", "children": "Children",
    }
    lines = [f"{labels.get(k, k)}: {v}" for k, v in profile.items() if v and k != "onboardingComplete"]
    return "\n".join(lines) or "Profile not yet built."


def who_line(persona: dict, speaker: str, user: dict, relationship: str) -> str:
    name, first = persona["name"], first_name(persona["name"])
    if speaker == "subject":
        return f"You are conducting a life-story interview with {name}, in person."
    rel = f", {first}'s {relationship}" if relationship else ""
    gone = f"{first} has passed away" if persona.get("passed") else f"{first} is not present"
    return (
        f"You are interviewing {user['name']}{rel}, to gather THEIR memories of {name}'s life. {gone}.\n"
        f"Ask what they saw, heard, were told and felt about {first}. Refer to {first} by name or as "
        f"\"your {relationship or 'loved one'}\". Never pretend to be {first} and never put words in {first}'s mouth."
    )


# ── Interviewer ──────────────────────────────────────────────────────────────

INTERVIEW_RULES = """HARD RULES — never break these:
1. Ask exactly ONE question per response. Never stack two questions. Never.
2. Before asking your question, write a brief reflection (1–3 sentences) that shows you genuinely heard what was just said. Use specific words or images from their answer.
3. Never push a sensitive thread more than once. If they deflect, note it and move on.
4. Never ask a yes/no question. Every question must invite a story or a scene.
5. Your default move is to go DEEPER — not to advance to the next topic. Move on only when a thread is genuinely exhausted.
6. Use the real names of people, firms and places they mention. Sound personal and informed.
7. Never ask for information you already know from the background, the profile, or memories the family already added.
8. Your tone is warm, unhurried and genuinely curious. You are not conducting a survey — you are listening to a life.

OUTPUT FORMAT — return only a JSON object with exactly these fields:
{
  "reflection": "Your 1–3 sentence reflection showing you heard them",
  "question": "Your single, personalised follow-up question",
  "moveType": "deepen" | "redirect" | "advance",
  "questionId": <integer id of the coverage-map question being addressed, or null if deepening>,
  "newThreads": ["thread description"],
  "profileUpdates": { "key": "value" },
  "coverageUpdate": { "questionId": <int>, "status": "partial" | "covered" } | null,
  "answerQuality": "vague" | "moderate" | "rich"
}"""


def interviewer_system(persona: dict, story: dict, speaker: str, user: dict, relationship: str) -> str:
    return (
        "You are a skilled biographical interviewer with the warmth of a trusted friend and the craft of a "
        "seasoned journalist.\n" + who_line(persona, speaker, user, relationship) + "\n\n"
        + background_block(persona, story) + "\n\n" + INTERVIEW_RULES
    )


def _speaker_label(persona: dict, turn: dict) -> str:
    if turn["role"] == "agent":
        return "Interviewer"
    return first_name(persona["name"]) if turn.get("speaker", "subject") == "subject" else "Family member"


def interview_context(persona: dict, story: dict, answer: str, last_question: Optional[int]) -> str:
    cov = store.coverage(persona["id"])
    st = qs.stats(cov)
    nxt = qs.next_questions(cov, story["profile"])[:5]
    threads = store.open_threads(persona["id"])[:6]
    recent = store.recent_turns(persona["id"], 12)
    last_q = qs.BY_ID.get(last_question) if last_question else None

    threads_str = "\n".join(
        f"[Thread{' SENSITIVE' if t['sensitivity'] == 'sensitive' else ''}] {t['text']}"
        + (f" (from a family recording: {t['recording_title']})" if t.get("recording_title") else "")
        for t in threads
    ) or "None yet."
    return f"""## SUBJECT PROFILE
{format_profile(story['profile'])}

## COVERAGE STATUS
Coverage: {st['covered']} covered, {st['partial']} partial, {st['untouched']} untouched out of {st['total']}.

## OPEN THREADS (things mentioned — here or in family recordings — that deserve deeper exploration)
{threads_str}

## CANDIDATE NEXT QUESTIONS (from the coverage map — use these for an ADVANCE move)
{chr(10).join(f"[Q{q['id']} S{q['section']}] {q['skeleton']} (weight: {q['weight']})" for q in nxt)}

## RECENT CONVERSATION
{chr(10).join(f"{_speaker_label(persona, t)}: {t['content']}" for t in recent) or '(none yet)'}

## CURRENT TURN
{f'Last question being addressed: [Q{last_q["id"]}] "{last_q["skeleton"]}"' if last_q else 'No specific question was last asked (free sharing).'}
Latest answer: "{answer}"

Now analyse this answer and generate your response. Remember: ONE question only. Default to deepening unless the thread is genuinely exhausted."""


def interview_turn(persona: dict, story: dict, session: dict, user: dict, relationship: str, answer: str) -> dict:
    """One interview turn. Updates coverage, threads and profile; returns the agent's reply."""
    last_q = session.get("last_question")
    provider = "mock"
    try:
        result, provider = _json_call(
            config.chat_llm_order(), interviewer_system(persona, story, session["speaker"], user, relationship),
            interview_context(persona, story, answer, last_q), temperature=0.75, max_tokens=2048,
        )
        if not str(result.get("question") or "").strip():
            raise ValueError("no question in reply")
    except (ProviderError, ValueError) as exc:
        print(f"  [lifestory] interviewer fell back to the coverage map: {exc}")
        nxt = qs.next_questions(store.coverage(persona["id"]), story["profile"])
        q = next((x for x in nxt if x["id"] != last_q), None)
        result = {"reflection": "Thank you for sharing that.", "question": q["skeleton"] if q else "Tell me more.",
                  "moveType": "advance", "questionId": q["id"] if q else None}

    if session["speaker"] == "subject":
        store.merge_profile(persona, result.get("profileUpdates"))
    cu = result.get("coverageUpdate") if isinstance(result.get("coverageUpdate"), dict) else {}
    to_mark = qs.valid_id(cu.get("questionId")) or last_q
    if to_mark:
        store.mark_coverage(persona["id"], to_mark, cu.get("status") or "partial")
    for t in result.get("newThreads") or []:
        if isinstance(t, str):
            store.add_thread(persona["id"], t)

    reflection = str(result.get("reflection") or "").strip()
    question = str(result["question"]).strip()
    return {
        "message": f"{reflection}\n\n{question}" if reflection else question,
        "question_id": qs.valid_id(result.get("questionId")),
        "move_type": result.get("moveType") if result.get("moveType") in ("deepen", "redirect", "advance") else "deepen",
        "provider": provider,
    }


# ── Onboarding (subject only, first ever session) ───────────────────────────

def onboarding_system(persona: dict, story: dict) -> str:
    return f"""You are beginning a warm, welcoming biographical interview with {persona['name']}.

{background_block(persona, story)}

Your job right now is NOT to ask about their career or public life — that comes in depth later. Make them feel genuinely welcome and learn a few things that will make every future question feel personal:
- Their birthplace and approximate birth decade
- The 2–3 people who matter most to them personally (spouse, children, parents)
- One sentence on the emotional centre of their life — family, a driving idea, service, legacy?

HARD RULES:
- Ask ONE question at a time. Be warm and conversational, not clinical.
- Do NOT ask about anything you already know from the background.
- Each response: a brief warm acknowledgement, then one natural question.
- Set onboardingComplete to true once you have enough to begin the real interview. When you do, the response
  must be ONLY a warm 1–2 sentence acknowledgement with NO question — the first interview question is added
  automatically after it.

Return only a JSON object:
{{"response": "Your warm message", "profileUpdates": {{"fieldName": "value"}}, "onboardingComplete": true | false}}"""


def onboarding_turn(persona: dict, story: dict, answer: str) -> dict:
    recent = store.recent_turns(persona["id"], 8)
    prompt = (
        f"Known so far: {format_profile(story['profile'])}\n\nConversation so far:\n"
        + "\n".join(f"{_speaker_label(persona, t)}: {t['content']}" for t in recent)
        + f'\n\nLatest message: "{answer}"\n\nNow generate your response.'
    )
    try:
        result, provider = _json_call(config.chat_llm_order(), onboarding_system(persona, story), prompt,
                                      temperature=0.7, max_tokens=1500)
        if not str(result.get("response") or "").strip():
            raise ValueError("empty response")
    except (ProviderError, ValueError) as exc:
        print(f"  [lifestory] onboarding fell back: {exc}")
        result, provider = {"response": "Thank you — that helps me know you a little.", "onboardingComplete": True}, "mock"
    store.merge_profile(persona, result.get("profileUpdates"))
    message, complete = str(result["response"]).strip(), bool(result.get("onboardingComplete"))
    if complete:
        # The first interview question is appended next; keep to one question per message.
        kept = [s for s in re.split(r"(?<=[.!?])\s+", message) if not s.rstrip().endswith("?")]
        message = " ".join(kept).strip() or "Thank you — that helps me know you a little."
    return {"message": message, "complete": complete, "provider": provider}


# ── Openers (Bio-per3 subject.config.js `openings`, made generic) ────────────

def opening_onboarding(persona: dict) -> str:
    return (f"{persona['name']}, it is a genuine honour to sit with you today.\n\n"
            "Before we begin to trace the arc of your life, I would love to spend a few moments simply getting "
            "to know the person behind the story. So let us start simply: where in the world did your story "
            "begin, and what kind of family did you grow up in?")


def opening_first_interview() -> str:
    return ("Wonderful. Now we can begin in earnest.\n\nEvery life has a root — a place, a household, a set of "
            "values passed down quietly across generations.\n\nTake me back to the very beginning: where were "
            "you born, and what was the world you arrived into?")


ONBOARDING_COMPLETE_SUFFIX = (
    "\n\nWonderful. Now I feel I know a little of the person behind the name.\n\nLet us begin. Every life has a "
    "starting point — a family, a place, a set of values you didn't choose but that shaped everything that "
    "followed. Take me back to the very beginning: where were you born, and what kind of world did you arrive into?"
)


def opening_family_first(persona: dict, user: dict) -> str:
    first = first_name(persona["name"])
    return (f"Thank you for sitting down with me to talk about {first}, {first_name(user['name'])}. I'd like to "
            f"gather the stories you carry — the scenes, the sayings, the moments only you were there for.\n\n"
            f"Let's begin wherever feels natural: what is the first memory of {first} that comes to you?")


def session_opener(persona: dict, story: dict, speaker: str, user: dict, relationship: str) -> dict:
    """Warm reconnection for a returning session, picking up an open thread or a coverage gap."""
    cov = store.coverage(persona["id"])
    st = qs.stats(cov)
    nxt = qs.next_questions(cov, story["profile"])[:3]
    threads = store.open_threads(persona["id"])
    top = next((t for t in threads if t["sensitivity"] != "sensitive"), threads[0] if threads else None)
    last = store.last_ended_session(persona["id"])
    tail = store.session_turns(last["id"])[-4:] if last else []

    prompt = f"""{who_line(persona, speaker, user, relationship)}
This is the start of interview session #{(last['session_number'] if last else 0) + 1}.
Coverage: {st['covered']} of {st['total']} questions covered.

End of the last session:
{chr(10).join(f"{'Interviewer' if t['role'] == 'agent' else 'Speaker'}: {t['content']}" for t in tail) or '(no previous session)'}

Most important open thread: {top['text'] if top else 'None yet'}{f" (from the family recording '{top['recording_title']}')" if top and top.get('recording_title') else ''}

Top next questions: {'; '.join(f"[Q{q['id']}] {q['skeleton']}" for q in nxt)}

Write a warm, personal 2–3 sentence welcome-back message that:
1. Acknowledges you're picking up where you left off
2. Either gently revisits the open thread OR signals you'll continue exploring the story
3. Ends with ONE natural question that feels like a genuine continuation

Return JSON: {{"message": "...", "questionId": <int or null>}}"""
    try:
        result, provider = _json_call(config.chat_llm_order(),
                                      "You are a warm, skilled biographical interviewer. Return only valid JSON.",
                                      prompt, temperature=0.7, max_tokens=1200)
        if not str(result.get("message") or "").strip():
            raise ValueError("empty message")
        return {"message": result["message"].strip(), "question_id": qs.valid_id(result.get("questionId")),
                "provider": provider}
    except (ProviderError, ValueError) as exc:
        print(f"  [lifestory] opener fell back: {exc}")
        q = nxt[0] if nxt else None
        return {"message": "Welcome back. Let's pick up where we left off.\n\n" + (q["skeleton"] if q else "What would you like to share today?"),
                "question_id": q["id"] if q else None, "provider": "mock"}


# ── Analyst: family recordings → coverage map (uploadAgent.js) ──────────────

ANALYST_SYSTEM = """You are a biographical data extraction specialist. You receive a transcript or written account (voice notes, interviews, chat exports, family recollections) and map it onto a biography project.

WHAT TO EXTRACT:
1. profileUpdates — factual attributes of the SUBJECT: name, birthDecade, birthPlace, hometown, profession, lifeFocus, importantPeople, spouse, children, education, etc.
2. coverageUpdates — which of the numbered questions does the text address? "covered" = a rich, specific answer; "partial" = mentioned but lacking depth. Be generous: if it touches a topic even briefly, mark it partial.
3. newThreads — people, events or feelings mentioned that deserve deeper exploration in a future interview. One sentence each, saying what was mentioned and why it is interesting. Mark death, grief, divorce, abuse, trauma, addiction or estrangement as "sensitive".
4. summary — 2–3 sentences on what was found.

RULES:
- Do NOT invent facts. Only extract what is explicitly stated or very strongly implied.
- If the text is a family member's account, the facts are still about the subject.
- If it is a two-person dialogue, the subject is the non-interviewer.

Return only JSON:
{"profileUpdates": {}, "coverageUpdates": [{"questionId": 0, "status": "partial"}], "newThreads": [{"text": "", "sensitivity": "normal"}], "summary": ""}"""


def analyze_recording(recording_id: str) -> Optional[dict]:
    """Map a processed family recording onto the coverage map + threads.

    Skips interview sessions (their coverage was tracked live). Safe to re-run:
    coverage never downgrades and the recording's previous threads are replaced.
    Returns None when skipped or when no AI provider is available.
    """
    rec = db.one("SELECT * FROM recordings WHERE id = ?", (recording_id,))
    if not rec or not (rec.get("transcript_text") or "").strip():
        return None
    if db.one("SELECT 1 FROM interview_sessions WHERE recording_id = ?", (recording_id,)):
        return None
    persona = db.one("SELECT * FROM personas WHERE id = ?", (rec["persona_id"],))
    if not persona:
        return None
    story = store.get_story(persona)
    text = rec["transcript_text"]
    if len(text) > MAX_SOURCE_CHARS:
        text = text[:MAX_SOURCE_CHARS] + "\n\n[... truncated ...]"
    kind = "a family member's account ABOUT the subject" if rec["speaker_mode"] == "family_account" else "the subject's own words"
    prompt = (
        f"Subject: {persona['name']}\nCurrent profile:\n{format_profile(story['profile'])}\n\n"
        "== QUESTION LIST ==\n" + "\n".join(f"[Q{q['id']} S{q['section']}] {q['skeleton']}" for q in qs.QUESTIONS)
        + f"\n\n== TEXT TO ANALYSE ({kind}; titled \"{rec['title']}\") ==\n{text.strip()}"
    )
    try:
        result, _ = _json_call(config.extraction_llm_order(), ANALYST_SYSTEM, prompt, temperature=0.2, max_tokens=4096)
    except (ProviderError, ValueError) as exc:
        print(f"  [lifestory] coverage analysis skipped for {recording_id}: {exc}")
        return None

    store.merge_profile(persona, result.get("profileUpdates"))
    marked = 0
    for cu in result.get("coverageUpdates") or []:
        if isinstance(cu, dict) and qs.valid_id(cu.get("questionId")):
            store.mark_coverage(persona["id"], cu["questionId"], cu.get("status") or "partial", source="recording")
            marked += 1
    db.execute("DELETE FROM interview_threads WHERE recording_id = ? AND status = 'open'", (recording_id,))
    for t in result.get("newThreads") or []:
        if isinstance(t, dict):
            store.add_thread(persona["id"], t.get("text", ""), t.get("sensitivity"), recording_id=recording_id)
        elif isinstance(t, str):
            store.add_thread(persona["id"], t, recording_id=recording_id)
    return {"summary": str(result.get("summary") or ""), "questions_marked": marked}


# ── Writer (writerAgent.js) ──────────────────────────────────────────────────

WRITER_SYSTEM = """You are a literary biographer of the highest order — think Robert Caro meets Mary Karr. You have the full transcript of a biographical interview, plus memories the family recorded, and must write a complete, beautifully crafted biography.

Your task:
1. Read the transcript, memories and profile carefully.
2. Find the throughline — the theme or quality that unifies this person's life.
3. Follow the chapter plan you are given.
4. Write the biography as a story, not a report.

WRITING RULES:
- Vivid, literary prose. No bullet points. No headers that sound like a report.
- Open each chapter with a specific scene or image from the sources.
- Preserve the subject's actual words and phrases — quote them directly.
- Family accounts are other people's recollections: attribute them ("his daughter remembers…"), never present them as the subject's own words.
- Only use facts found in the sources. Never invent names, dates, places, events or feelings. If something is unknown, leave it out.
- Find patterns and connections the subject may not have stated explicitly, but do not moralise or over-interpret. Let the life speak.
- Present tense for scenes, past tense for reflection.

FORMAT — a Markdown document with:
- A title: "# [Full Name]: [A Short, Evocative Subtitle]"
- A short epigraph (a real quote from the sources)
- Chapters as ## headers with evocative titles (not "Chapter 1")
- A brief author's note at the end, saying it was drafted by AI from recorded interviews and family memories.

Length: 2,000–4,000 words. Write it all."""


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + "\n\n[... truncated for length ...]"


def writer_sources(persona: dict) -> dict:
    """Everything the writer may use. Interview memories are skipped (the transcript has them verbatim)."""
    first = first_name(persona["name"])
    turns = store.all_turns(persona["id"])
    lines, cur = [], None
    for t in turns:
        if t["session_number"] != cur:
            cur = t["session_number"]
            who = first if t["speaker"] == "subject" else f"{t['user_name']} (family, about {first})"
            lines.append(f"\n### Interview session {cur} — speaking: {who}")
        speaker = "Interviewer" if t["role"] == "agent" else (first if t["speaker"] == "subject" else t["user_name"])
        lines.append(f"**{speaker}:** {t['content']}")

    skip = store.interview_recording_ids(persona["id"])
    mems = db.all_rows(
        """SELECT m.title, m.summary, m.excerpt, m.time_period, m.source_kind, m.recording_id, r.title AS recording_title
           FROM memories m LEFT JOIN recordings r ON r.id = m.recording_id WHERE m.persona_id = ? ORDER BY m.created_at""",
        (persona["id"],),
    )
    mem_lines = []
    for m in mems:
        if m["recording_id"] in skip:
            continue
        tag = "FAMILY ACCOUNT" if m["source_kind"] == "family_account" else f"{first.upper()}'S OWN WORDS"
        line = f"- [{tag}] {m['title']}" + (f" ({m['time_period']})" if m["time_period"] else "") + f": {m['summary']}"
        if m["excerpt"]:
            line += f'\n  Verbatim: "{m["excerpt"]}"'
        mem_lines.append(line)
    user_turns = sum(1 for t in turns if t["role"] == "user")
    return {"transcript": "\n".join(lines).strip(), "memories": "\n".join(mem_lines),
            "user_turns": user_turns, "memory_count": len(mem_lines)}


def write_biography(persona: dict) -> tuple[str, str]:
    """Return (markdown, provider). Raises ProviderError when no AI provider can write it."""
    story = store.get_story(persona)
    src = writer_sources(persona)
    threads = store.open_threads(persona["id"])
    context = f"""## SUBJECT PROFILE
{format_profile(story['profile'])}

{background_block(persona, story)}

## INTERVIEW TRANSCRIPT
{_clip(src['transcript'], MAX_BIO_TRANSCRIPT) or '(No interview sessions yet)'}

## MEMORIES RECORDED BY THE FAMILY
{_clip(src['memories'], MAX_BIO_MEMORIES) or '(None)'}

## UNRESOLVED THREADS (context only — these may not have answers)
{chr(10).join(f"- {t['text']}" for t in threads[:30]) or 'None'}"""

    order = config.extraction_llm_order()  # long context first (Gemini), then Groq
    try:
        outline, _ = _json_call(
            order,
            "You are a literary biographer. Given these sources, plan the biography. Return JSON: "
            '{"title": "", "subtitle": "", "epigraph": "", "throughline": "", "chapters": [{"title": "", "focus": ""}]}. '
            "Plan 5–7 chapters. The epigraph must be a real quote from the sources. Return only valid JSON.",
            context, temperature=0.7, max_tokens=2048,
        )
        chapters = [c for c in outline.get("chapters") or [] if isinstance(c, dict) and c.get("title")]
        if not chapters:
            raise ValueError("no chapters")
    except (ProviderError, ValueError) as exc:
        if isinstance(exc, ProviderError):
            raise
        outline = {"title": persona["name"], "subtitle": "A Life", "epigraph": "", "throughline": ""}
        chapters = [{"title": t, "focus": f} for t, f in (
            ("Origins", "Early life and family"), ("The Making", "Education and early work"),
            ("The Work", "The working life and its achievements"), ("Turning Points", "Major changes and crises"),
            ("What Remains", "Legacy, wisdom and final reflections"))]

    plan = "\n".join(f"Chapter {i + 1}: \"{c['title']}\" — {c.get('focus', '')}" for i, c in enumerate(chapters))
    prompt = f"""{context}

## BIOGRAPHY PLAN
Title: {outline.get('title') or persona['name']}: {outline.get('subtitle') or ''}
Epigraph: "{outline.get('epigraph') or ''}"
Throughline: {outline.get('throughline') or ''}

Chapters to write:
{plan}

Write the complete biography now. All chapters. Full literary prose. 2,000–4,000 words."""
    text, provider = complete_with_fallback(order, WRITER_SYSTEM, [{"role": "user", "content": prompt}],
                                            temperature=0.8, max_tokens=8192)
    return text.strip(), provider
