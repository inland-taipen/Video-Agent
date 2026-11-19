"""Recording → memories pipeline.

queued → transcribing → extracting → embedding → ready
                 ↘ needs_transcript (no STT available; user can paste one)
                 ↘ failed (error shown in UI; can be retried)

Runs on a single background worker so free-tier rate limits aren't hammered.
The original upload is never modified; re-processing replaces only the derived
transcript segments and memories for that recording.
"""
from __future__ import annotations

import json
import re
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from . import config, db
from .providers import embeddings as emb
from .providers.http import ProviderError
from .providers.llm import complete_with_fallback
from .providers.stt import STTUnavailable, get_stt, probe_duration
from .storage import get_storage

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="legacy-ingest")
_inflight: set[str] = set()
_lock = threading.Lock()

TERMINAL = {"ready", "failed", "needs_transcript"}
WINDOW_CHARS = 60_000


def enqueue(recording_id: str) -> None:
    with _lock:
        if recording_id in _inflight:
            return
        _inflight.add(recording_id)
    _executor.submit(_run, recording_id)


def resume_pending() -> None:
    """Re-queue work interrupted by a server restart."""
    for r in db.all_rows("SELECT id FROM recordings WHERE status NOT IN ('ready','failed','needs_transcript')"):
        enqueue(r["id"])


def _run(recording_id: str) -> None:
    try:
        process_recording(recording_id)
    except Exception as exc:  # noqa: BLE001 — surface every failure in the UI
        traceback.print_exc()
        _status(recording_id, "failed", _friendly(exc))
    finally:
        with _lock:
            _inflight.discard(recording_id)


def _friendly(exc: Exception) -> str:
    msg = str(exc)
    if "429" in msg:
        return "The free AI quota is used up for now. Wait a minute and press Retry."
    return msg[:400]


def _status(recording_id: str, status: str, detail: str = "", **extra) -> None:
    fields = {"status": status, "status_detail": detail, **extra}
    if status == "ready":
        fields["processed_at"] = db.now()
    db.update("recordings", "id", recording_id, fields)


# ── Stage 1: transcript ─────────────────────────────────────────────────────

def _segments_from_text(text: str) -> list[dict]:
    paras = [p.strip() for p in re.split(r"\n\s*\n|\n", text) if p.strip()]
    return [{"start": None, "end": None, "text": p} for p in paras]


def _save_segments(recording_id: str, segments: list[dict]) -> None:
    with db.tx() as c:
        c.execute("DELETE FROM transcript_segments WHERE recording_id = ?", (recording_id,))
        c.executemany(
            "INSERT INTO transcript_segments (id, recording_id, idx, start_sec, end_sec, text) VALUES (?,?,?,?,?,?)",
            [(db.new_id(), recording_id, i, s["start"], s["end"], s["text"]) for i, s in enumerate(segments)],
        )


def _ensure_transcript(rec: dict, persona: dict) -> Optional[list[dict]]:
    """Return segments, or None if processing must pause for a manual transcript."""
    if rec["transcript_text"]:
        rows = db.all_rows(
            "SELECT start_sec AS start, end_sec AS end, text FROM transcript_segments WHERE recording_id = ? ORDER BY idx",
            (rec["id"],),
        )
        if rows:
            return rows
        segs = _segments_from_text(rec["transcript_text"])
        _save_segments(rec["id"], segs)
        return segs

    _status(rec["id"], "transcribing", "Converting speech to text…")
    path = get_storage().local_path(rec["storage_key"])
    try:
        t = get_stt().transcribe(path, persona["language"])
    except STTUnavailable as exc:
        _status(rec["id"], "needs_transcript",
                f"Speech-to-text is unavailable ({exc}). Paste a transcript to continue.",
                duration_sec=probe_duration(path))
        return None
    except ProviderError as exc:
        if "HTTP 401" in str(exc) or "HTTP 403" in str(exc):
            _status(rec["id"], "needs_transcript",
                    "The speech-to-text service rejected the API key (check GROQ_API_KEY). "
                    "Paste a transcript to continue, or press Retry after fixing the key.",
                    duration_sec=probe_duration(path))
            return None
        raise
    segs = [{"start": s.start, "end": s.end, "text": s.text} for s in t.segments]
    _save_segments(rec["id"], segs)
    db.update("recordings", "id", rec["id"], {
        "transcript_text": t.text, "transcript_source": t.provider,
        "language": t.language, "duration_sec": t.duration,
    })
    return segs


# ── Stage 2: memory extraction ──────────────────────────────────────────────

_EXTRACT_SYSTEM = """You turn transcripts of a person's recorded life stories into a structured memory archive.
Accuracy matters more than anything: family members will rely on this to remember someone who may have passed away.

Rules:
- Only record what is actually said in the transcript. Never add facts, names, dates, places or feelings that are not stated.
- If the recording is an interview, extract what the SUBJECT says about their own life. Questions from the interviewer are context only.
- Split the transcript into distinct memories/stories (one event, period, person or topic each). Skip small talk.
- summary: 1-3 factual sentences in third person using the subject's name.
- excerpt: the most characteristic VERBATIM sentence(s) from the transcript for that memory (copy exactly, max ~60 words).
- start_sec / end_sec: use the [seconds] markers at the start of lines when present, else null.
- time_period: only if stated or clearly implied (e.g. "1960s", "his school years"); else "".
- people: people mentioned in that memory with their relationship to the subject if stated, else "".
- style: how the subject speaks — tone, recurring phrases or sayings (verbatim), terms of address they use (e.g. "beta"), language mixing. Only from evidence in the transcript.

Return JSON only:
{"memories":[{"title":"","summary":"","excerpt":"","start_sec":null,"end_sec":null,"time_period":"","places":[],"themes":[],"people":[{"name":"","relationship":""}]}],
 "style":{"tone":"","phrases":[],"address_terms":[],"notes":""}}"""


def _fmt_segment(s: dict) -> str:
    return f"[{s['start']:.0f}] {s['text']}" if s.get("start") is not None else s["text"]


def _windows(segments: list[dict]) -> list[str]:
    out, cur = [], []
    size = 0
    for s in segments:
        line = _fmt_segment(s)
        if cur and size + len(line) > WINDOW_CHARS:
            out.append("\n".join(cur))
            cur, size = [], 0
        cur.append(line)
        size += len(line) + 1
    if cur:
        out.append("\n".join(cur))
    return out


def _parse_json(text: str) -> dict:
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        return json.loads(text)
    except ValueError:
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            raise
        return json.loads(m.group(0))


def _mock_extract(segments: list[dict], persona_name: str) -> dict:
    """Offline fallback: group segments into ~60-150 word windows; verbatim text as summary and excerpt."""
    memories, buf, start = [], [], None
    end = None

    def flush():
        if not buf:
            return
        text = " ".join(buf)
        words = text.split()
        memories.append({
            "title": " ".join(words[:8]) + ("…" if len(words) > 8 else ""),
            "summary": f"In {persona_name}'s words: {text}",
            "excerpt": " ".join(words[:150]),
            "start_sec": start, "end_sec": end, "time_period": "", "places": [], "themes": [], "people": [],
        })

    # Text uploads arrive as paragraphs (start=None) — treat each as its own story.
    target = 25 if all(s.get("start") is None for s in segments) else 60
    for s in segments:
        if start is None:
            start = s.get("start")
        end = s.get("end")
        buf.append(s["text"])
        if sum(len(b.split()) for b in buf) >= target:
            flush()
            buf, start = [], None
    flush()
    return {"memories": memories, "style": {}}


def _extract(rec: dict, persona: dict, segments: list[dict]) -> tuple[dict, str]:
    context = {
        "solo": "The subject is the only speaker.",
        "interview": "This is an interview: another person asks questions; the subject answers.",
        "family_account": f"This is a family member's written account ABOUT {persona['name']}, not their own words.",
        "transcript": f"This is {persona['name']}'s own words, written down.",
    }.get(rec["speaker_mode"], "")
    combined: dict = {"memories": [], "style": {}}
    provider = "mock"
    for window in _windows(segments):
        prompt = (
            f"Subject: {persona['name']}\n"
            f"Recording: {rec['title']}" + (f" (recorded {rec['recorded_on']})" if rec["recorded_on"] else "") + "\n"
            f"{context}\n" + (f"Uploader's notes: {rec['notes']}\n" if rec["notes"] else "")
            + f"\nTRANSCRIPT:\n{window}"
        )
        try:
            text, provider = complete_with_fallback(
                config.extraction_llm_order(), _EXTRACT_SYSTEM,
                [{"role": "user", "content": prompt}], json_mode=True, temperature=0.1,
            )
            data = _parse_json(text)
        except (ProviderError, ValueError) as exc:
            print(f"  [legacy] extraction fell back to mock: {exc}")
            data, provider = _mock_extract(segments, persona["name"]), "mock"
            combined = data
            break
        combined["memories"].extend(data.get("memories") or [])
        _merge_style(combined["style"], data.get("style") or {})
    return combined, provider


def _merge_style(base: dict, new: dict) -> dict:
    for key in ("phrases", "address_terms"):
        seen = list(base.get(key) or [])
        for item in new.get(key) or []:
            if isinstance(item, str) and item.strip() and item not in seen:
                seen.append(item.strip())
        base[key] = seen[:20]
    for key in ("tone", "notes"):
        vals = [v for v in [base.get(key, ""), new.get(key, "")] if v]
        base[key] = " ".join(dict.fromkeys(vals))[:600]
    return base


def _num(v) -> Optional[float]:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _str_list(v) -> list[str]:
    return [str(x).strip() for x in v if str(x).strip()] if isinstance(v, list) else []


# ── Stage 3: embeddings + save ──────────────────────────────────────────────

def memory_embedding_text(m: dict, people: list[dict]) -> str:
    parts = [m["title"], m["summary"], m.get("excerpt", "")]
    if people:
        parts.append("People: " + ", ".join(
            f"{p['name']} ({p['relationship']})" if p.get("relationship") else p["name"] for p in people))
    if m.get("time_period"):
        parts.append(f"When: {m['time_period']}")
    if m.get("places"):
        parts.append("Places: " + ", ".join(m["places"]))
    return "\n".join(p for p in parts if p)


def embed_texts(texts: list[str]) -> tuple[list[list[float]], str]:
    provider = emb.default_provider()
    try:
        return provider.embed(texts), provider.model_id
    except Exception as exc:  # noqa: BLE001 — fall back to offline embeddings
        print(f"  [legacy] {provider.model_id} embedding failed, using local fallback: {exc}")
        local = emb.LocalHashEmbeddings()
        return local.embed(texts), local.model_id


def _upsert_person(c, persona_id: str, name: str, relationship: str) -> str:
    row = c.execute("SELECT id, relationship FROM people WHERE persona_id = ? AND lower(name) = lower(?)",
                    (persona_id, name)).fetchone()
    if row:
        if relationship and not row["relationship"]:
            c.execute("UPDATE people SET relationship = ? WHERE id = ?", (relationship, row["id"]))
        return row["id"]
    pid = db.new_id()
    c.execute("INSERT INTO people (id, persona_id, name, relationship) VALUES (?,?,?,?)",
              (pid, persona_id, name, relationship))
    return pid


def save_memories(persona_id: str, recording_id: Optional[str], memories: list[dict],
                  source_kind: str, duration: Optional[float]) -> int:
    clean = []
    for m in memories:
        title, summary = str(m.get("title") or "").strip(), str(m.get("summary") or "").strip()
        if not summary:
            continue
        start, end = _num(m.get("start_sec")), _num(m.get("end_sec"))
        if duration and start is not None and not (0 <= start <= duration):
            start, end = None, None
        people = [
            {"name": str(p.get("name", "")).strip(), "relationship": str(p.get("relationship", "")).strip()}
            for p in (m.get("people") or []) if isinstance(p, dict) and str(p.get("name", "")).strip()
        ]
        clean.append({
            "title": title or summary[:60], "summary": summary,
            "excerpt": str(m.get("excerpt") or "").strip(), "start_sec": start, "end_sec": end,
            "time_period": str(m.get("time_period") or "").strip(),
            "places": _str_list(m.get("places")), "themes": _str_list(m.get("themes")), "people": people,
        })
    if not clean:
        return 0
    vectors, model_id = embed_texts([memory_embedding_text(m, m["people"]) for m in clean])
    with db.tx() as c:
        if recording_id:
            c.execute("DELETE FROM memories WHERE recording_id = ?", (recording_id,))
        for m, vec in zip(clean, vectors):
            mid = db.new_id()
            c.execute(
                """INSERT INTO memories (id, persona_id, recording_id, title, summary, excerpt, start_sec, end_sec,
                   time_period, places, themes, source_kind, embedding, embedding_model, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (mid, persona_id, recording_id, m["title"], m["summary"], m["excerpt"], m["start_sec"], m["end_sec"],
                 m["time_period"], json.dumps(m["places"]), json.dumps(m["themes"]), source_kind,
                 json.dumps([round(x, 6) for x in vec]), model_id, db.now()),
            )
            for p in m["people"]:
                pid = _upsert_person(c, persona_id, p["name"], p["relationship"])
                c.execute("INSERT OR IGNORE INTO memory_people (memory_id, person_id) VALUES (?,?)", (mid, pid))
    return len(clean)


def process_recording(recording_id: str) -> None:
    rec = db.one("SELECT * FROM recordings WHERE id = ?", (recording_id,))
    if not rec:
        return
    persona = db.one("SELECT * FROM personas WHERE id = ?", (rec["persona_id"],))
    if not persona:
        return

    segments = _ensure_transcript(rec, persona)
    if segments is None:
        return
    rec = db.one("SELECT * FROM recordings WHERE id = ?", (recording_id,))

    _status(recording_id, "extracting", "Finding stories, people and events…")
    data, provider = _extract(rec, persona, segments)

    _status(recording_id, "embedding", "Indexing memories for conversation…")
    source_kind = "family_account" if rec["speaker_mode"] == "family_account" else "own_words"
    count = save_memories(persona["id"], recording_id, data.get("memories") or [], source_kind, rec["duration_sec"])

    if data.get("style") and source_kind == "own_words":
        style = _merge_style(db.jload(persona["style_profile"], {}), data["style"])
        db.update("personas", "id", persona["id"], {"style_profile": json.dumps(style), "updated_at": db.now()})

    detail = f"{count} memories extracted"
    if provider == "mock":
        detail += " (offline fallback — AI extraction unavailable; press Retry later for better results)"
    _status(recording_id, "ready", detail, extraction_source=provider)
