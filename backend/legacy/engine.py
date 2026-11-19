"""Memory-grounded persona conversation engine (text in → streamed text out)."""
from __future__ import annotations

import json
import re
from typing import Iterator, Optional

from . import config, db
from .providers.llm import stream_with_fallback
from .retrieval import public_memory, search

HISTORY_TURNS = 8


def first_name(name: str) -> str:
    return name.split()[0] if name.split() else name


def greeting(persona: dict, memory_count: int) -> str:
    n = persona["name"]
    if memory_count == 0:
        return (f"Hello. This is an AI recreation of {n}. No recorded memories have been added yet, "
                f"so I can't share any of {first_name(n)}'s stories until recordings are uploaded.")
    return (f"Hello. This is an AI recreation of {n}, made from {memory_count} recorded "
            f"{'memory' if memory_count == 1 else 'memories'}. I'm not the real {first_name(n)}, "
            f"and I'll only share what was recorded. What would you like to talk about?")


def _style_block(style: dict) -> str:
    lines = []
    if style.get("tone"):
        lines.append(f"Tone: {style['tone']}")
    if style.get("phrases"):
        lines.append("Phrases they actually used: " + "; ".join(f'"{p}"' for p in style["phrases"][:12]))
    if style.get("address_terms"):
        lines.append("Ways they addressed people: " + ", ".join(style["address_terms"][:8]))
    if style.get("notes"):
        lines.append(f"Notes: {style['notes']}")
    return "\n".join(lines) or "No style evidence yet — speak plainly and warmly."


def _memory_block(mems: list[dict]) -> str:
    if not mems:
        return "(No recorded memory matches this question.)"
    out = []
    for i, m in enumerate(mems, 1):
        tag = "FAMILY ACCOUNT (told by family, not in their own words)" if m["source_kind"] == "family_account" \
            else "IN THEIR OWN WORDS"
        bits = [f"[M{i}] {m['title']} — {tag}", f"Summary: {m['summary']}"]
        if m["excerpt"]:
            bits.append(f'Verbatim: "{m["excerpt"]}"')
        if m.get("people_names"):
            bits.append(f"People: {m['people_names']}")
        if m["time_period"]:
            bits.append(f"When: {m['time_period']}")
        out.append("\n".join(bits))
    return "\n\n".join(out)


def system_prompt(persona: dict, user: dict, relationship: str, mems: list[dict], grounded: bool) -> str:
    name = persona["name"]
    style = db.jload(persona["style_profile"], {})
    life = ", ".join(x for x in [f"born {persona['born']}" if persona["born"] else "",
                                 f"passed {persona['passed']}" if persona["passed"] else ""] if x)
    rel = f" (their {relationship})" if relationship else ""
    return f"""You are an AI recreation of {name}{f' ({life})' if life else ''}, built from recordings they made. \
You are in a live VOICE call with {user['name']}{rel}. Everyone knows you are an AI recreation, not the real person.

HOW TO SPEAK
- First person, as {name}, warm and natural, like a phone call with family.
- Short: 1-4 spoken sentences. No lists, markdown, emojis, or stage directions like *smiles*.
- Match their documented style:
{_style_block(style)}

HONESTY RULES — these override everything else
1. Personal facts (events, people, names, dates, places, opinions, feelings about specific things) may ONLY come from the MEMORIES below. Never invent, embellish, or fill gaps.
2. If the memories don't cover what was asked, say so naturally, e.g. "I don't think I ever recorded anything about that." You may offer a related memory that IS listed.
3. FAMILY ACCOUNT memories were told by relatives; present them as "the family remembers…", not as your own first-hand memory.
4. You can respond to greetings and feelings and offer comfort, but never claim to know events after the recordings or what the real {first_name(name)} would think about new situations — say you can only share what was recorded.
5. If asked whether you are real, alive, or actually {first_name(name)}: say clearly you are an AI recreation built from their recordings.
6. No medical, legal or financial advice in their name.

BACKGROUND (written by the family, may be used): {persona['bio'] or '—'}

MEMORIES RETRIEVED FOR THIS QUESTION ({'relevant matches found' if grounded else 'NO strong match — follow rule 2'}):
{_memory_block(mems)}"""


_IDENTITY_Q = re.compile(r"\b(are you (real|alive|really|actually)|is (this|that) (really )?you|who are you|are you a (bot|robot|computer|machine|ai))\b", re.I)
_GREETING = re.compile(r"^\s*(hi|hello|hey|namaste|namaskar|good (morning|afternoon|evening))\b", re.I)


def _mock_reply(persona: dict, text: str, mems: list[dict], grounded: bool) -> str:
    """Used only when no LLM is reachable: quote real recorded words, never generate new 'memories'."""
    if _IDENTITY_Q.search(text):
        return (f"I'm an AI recreation of {persona['name']}, made from their recordings. "
                f"I'm not really {first_name(persona['name'])}.")
    if _GREETING.search(text) and not grounded:
        return "Hello. It's good to hear from you. Ask me about the stories in my recordings."
    if not grounded or not mems:
        return "I'm sorry, I don't think I recorded anything about that."
    m = mems[0]
    if m["source_kind"] == "family_account":
        return f"The family remembers this: {m['summary']}"
    if m["excerpt"]:
        return f"Here is what I said about that in my recording. {m['excerpt']}"
    return m["summary"]


def _history(conversation_id: str) -> list[dict]:
    rows = db.all_rows(
        "SELECT role, text FROM conversation_turns WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        (conversation_id, HISTORY_TURNS),
    )
    return [{"role": "assistant" if r["role"] == "persona" else "user", "content": r["text"]} for r in reversed(rows)]


def _retrieval_query(history: list[dict], text: str) -> str:
    """Short follow-ups ("what happened next?") need the previous question for context."""
    if len(text.split()) >= 6:
        return text
    prev = [h["content"] for h in history if h["role"] == "user"][-1:]
    last_reply = [h["content"] for h in history if h["role"] == "assistant"][-1:]
    return " ".join(prev + last_reply[:1] + [text])


def respond(conversation: dict, persona: dict, user: dict, relationship: str, text: str) -> Iterator[str]:
    """Yield NDJSON lines: meta → delta* → done (or error)."""
    history = _history(conversation["id"])
    db.insert("conversation_turns", {
        "id": db.new_id(), "conversation_id": conversation["id"], "role": "user", "text": text,
        "source_ids": "[]", "grounded": 0, "provider": None, "created_at": db.now(),
    })

    try:
        hits = search(persona["id"], _retrieval_query(history, text), k=8)
    except Exception as exc:  # noqa: BLE001
        print(f"  [legacy] retrieval failed: {exc}")
        hits = []
    relevant = [h for h in hits if h["relevant"]][:5]
    grounded = bool(relevant)
    context = relevant or hits[:2]  # weak matches still let the model offer something related

    turn_id = db.new_id()
    yield json.dumps({"type": "meta", "turn_id": turn_id, "grounded": grounded,
                      "sources": [public_memory(m) for m in relevant]}) + "\n"

    system = system_prompt(persona, user, relationship, context, grounded)
    provider, stream = stream_with_fallback(
        config.chat_llm_order(), system, history + [{"role": "user", "content": text}],
        max_tokens=320, temperature=0.6,
    )
    parts: list[str] = []
    try:
        if provider is None:
            provider = "mock"
            reply = _mock_reply(persona, text, relevant, grounded)
            parts.append(reply)
            yield json.dumps({"type": "delta", "text": reply}) + "\n"
        else:
            for chunk in stream:
                parts.append(chunk)
                yield json.dumps({"type": "delta", "text": chunk}) + "\n"
        full = "".join(parts).strip() or "I'm sorry, I lost my train of thought. Could you ask that again?"
        yield json.dumps({"type": "done", "text": full, "provider": provider}) + "\n"
    finally:
        # Runs on normal completion AND when the caller interrupts (client disconnect).
        full = "".join(parts).strip()
        if full:
            db.insert("conversation_turns", {
                "id": turn_id, "conversation_id": conversation["id"], "role": "persona", "text": full,
                "source_ids": json.dumps([m["id"] for m in relevant]), "grounded": int(grounded),
                "provider": provider, "created_at": db.now(),
            })


def memory_count(persona_id: str) -> int:
    row = db.one("SELECT count(*) AS n FROM memories WHERE persona_id = ?", (persona_id,))
    return row["n"] if row else 0


def relationship_of(persona_id: str, user_id: str) -> str:
    row: Optional[dict] = db.one(
        "SELECT relationship FROM persona_members WHERE persona_id = ? AND user_id = ?", (persona_id, user_id))
    return row["relationship"] if row else ""
