"""Hybrid memory search: embedding cosine similarity + keyword overlap.

Prototype scale (hundreds–low thousands of memories per persona) is searched
in-process. With Supabase this becomes a pgvector `ORDER BY embedding <=> q`
query; the function signature stays the same.
"""
from __future__ import annotations

import math
import os
import re
from collections import Counter

from . import db
from .providers import embeddings as emb

_TOKEN = re.compile(r"[a-z0-9ऀ-ॿ']+")
_STOP = set("""a an the and or but if of to in on at for with about from by as is was were be been are am do did does
have has had i you he she it we they me my your his her our their this that these those what when where who whom
why how which tell me us please can could would should will just so very really any some more much one there here
then than too also not no yes ok okay""".split())

# A memory counts as "grounding" only above this blended score. Real embeddings
# separate related/unrelated text far better than the offline hashing mock.
_MIN_SCORE = {"gemini": float(os.getenv("LEGACY_MIN_RELEVANCE", "0.52")), "local": 0.12}


def _tokens(text: str) -> list[str]:
    return [t for t in _TOKEN.findall(text.lower()) if t not in _STOP and len(t) > 1]


def _memory_text(m: dict) -> str:
    return " ".join([m["title"], m["summary"], m["excerpt"], m.get("people_names") or "",
                     m["time_period"], " ".join(db.jload(m["places"], []))])


def load_memories(persona_id: str) -> list[dict]:
    return db.all_rows(
        """SELECT m.*, r.title AS recording_title, r.source_type AS recording_source,
                  (SELECT group_concat(p.name || CASE WHEN p.relationship != '' THEN ' (' || p.relationship || ')' ELSE '' END, ', ')
                     FROM memory_people mp JOIN people p ON p.id = mp.person_id WHERE mp.memory_id = m.id) AS people_names
           FROM memories m LEFT JOIN recordings r ON r.id = m.recording_id
           WHERE m.persona_id = ? ORDER BY m.created_at""",
        (persona_id,),
    )


def search(persona_id: str, query: str, k: int = 6) -> list[dict]:
    mems = load_memories(persona_id)
    if not mems or not query.strip():
        return []

    # Keyword score (BM25-lite with IDF over this persona's memories).
    docs = [Counter(_tokens(_memory_text(m))) for m in mems]
    df: Counter = Counter()
    for d in docs:
        df.update(d.keys())
    n = len(docs)
    q_tokens = set(_tokens(query))
    kw = []
    for d in docs:
        s = sum(math.log(1 + n / df[t]) * min(d[t], 3) ** 0.5 for t in q_tokens if t in d)
        kw.append(s)
    kw_max = max(kw) or 1.0

    # Vector score, per embedding model actually stored for this persona.
    vec_scores: dict[int, float] = {}
    for model_id in {m["embedding_model"] for m in mems if m["embedding_model"]}:
        try:
            qv = emb.by_model_id(model_id).embed([query], query=True)[0]
        except Exception as exc:  # noqa: BLE001 — keyword search still works
            print(f"  [legacy] query embedding ({model_id}) failed: {exc}")
            continue
        for i, m in enumerate(mems):
            if m["embedding_model"] == model_id and m["embedding"]:
                vec_scores[i] = emb.cosine(qv, db.jload(m["embedding"], []))

    results = []
    for i, m in enumerate(mems):
        k_norm = kw[i] / kw_max if kw[i] else 0.0
        if i in vec_scores:
            family = "gemini" if m["embedding_model"].startswith("gemini") else "local"
            score = 0.8 * vec_scores[i] + 0.2 * k_norm
        else:
            family = "local"
            score = 0.5 * k_norm
        results.append({**m, "score": round(score, 4), "relevant": score >= _MIN_SCORE[family]})
    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:k]


def public_memory(m: dict) -> dict:
    """Shape a memory row for API responses (drops the raw vector)."""
    return {
        "id": m["id"], "recording_id": m["recording_id"], "recording_title": m.get("recording_title"),
        "has_audio": m.get("recording_source") == "audio",
        "title": m["title"], "summary": m["summary"], "excerpt": m["excerpt"],
        "start_sec": m["start_sec"], "end_sec": m["end_sec"], "time_period": m["time_period"],
        "places": db.jload(m["places"], []), "themes": db.jload(m["themes"], []),
        "people": m.get("people_names") or "", "source_kind": m["source_kind"],
        "embedding_model": m["embedding_model"], "score": m.get("score"), "relevant": m.get("relevant"),
        "created_at": m["created_at"],
    }
