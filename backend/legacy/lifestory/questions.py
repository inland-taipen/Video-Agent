"""The 80-question coverage map and next-question selection (Bio-per3 coverageMap.js)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

_DATA = json.loads((Path(__file__).parent / "questions.json").read_text())

SECTIONS: dict[int, str] = {int(k): v for k, v in _DATA["sections"].items()}
QUESTIONS: list[dict] = _DATA["questions"]
BY_ID: dict[int, dict] = {q["id"]: q for q in QUESTIONS}
TOTAL = len(QUESTIONS)

STATUS_RANK = {"untouched": 0, "partial": 1, "covered": 2}


def valid_id(value) -> Optional[int]:
    """Coerce an LLM-supplied question id; None if it isn't one of ours."""
    try:
        qid = int(value)
    except (TypeError, ValueError):
        return None
    return qid if qid in BY_ID else None


def section_weights(profile: dict) -> dict[int, int]:
    """Section relevance for this subject: higher = ask sooner."""
    base = {s: 5 for s in SECTIONS}
    focus = str(profile.get("lifeFocus", "")).lower()
    profession = str(profile.get("profession", "")).lower()

    if any(w in focus for w in ("career", "work", "profession")) or any(
        w in profession for w in ("founder", "ceo", "entrepreneur", "engineer", "doctor", "lawyer",
                                  "scientist", "artist", "industrialist", "chairman", "director")
    ):
        base[2] += 4  # Education, career
        base[4] += 2  # Turning points (often career-linked)

    if any(w in focus for w in ("family", "parent", "children", "community", "relationships")):
        base[3] += 4  # Personal life, relationships
        base[1] += 2  # Early life

    decade = str(profile.get("birthDecade", ""))[:4]
    if decade.isdigit() and int(decade) <= 1960:
        base[5] += 3  # Wisdom & legacy
    return base


def next_questions(coverage: dict[int, str], profile: dict, current_section: int = 1) -> list[dict]:
    """Uncovered questions in priority order: partial first, then untouched, each by section weight."""
    weights = section_weights(profile)
    partial, untouched = [], []
    for q in QUESTIONS:
        status = coverage.get(q["id"], "untouched")
        if status == "covered":
            continue
        item = {**q, "priority": weights[q["section"]] + (10 if q["section"] == current_section else 0)}
        (partial if status == "partial" else untouched).append(item)

    def key(q):
        return (-q["priority"], q["id"])

    return sorted(partial, key=key) + sorted(untouched, key=key)


def stats(coverage: dict[int, str]) -> dict:
    covered = sum(1 for s in coverage.values() if s == "covered")
    partial = sum(1 for s in coverage.values() if s == "partial")
    return {
        "covered": covered, "partial": partial, "untouched": TOTAL - covered - partial, "total": TOTAL,
        "percent": round((covered + partial * 0.5) / TOTAL * 100),
    }


SENSITIVE_KEYWORDS = (
    "death", "died", "grief", "loss", "divorce", "abuse", "trauma", "estrang", "mental health",
    "depression", "addiction", "suicide", "affair", "violence", "regret", "shame", "secret",
    "never spoke", "stopped speaking",
)


def is_sensitive(text: str) -> bool:
    lower = text.lower()
    return any(k in lower for k in SENSITIVE_KEYWORDS)
