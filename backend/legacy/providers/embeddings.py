"""Embedding providers.

GeminiEmbeddings (working, free tier): gemini-embedding-001 at 768 dimensions,
with separate document/query task types.
LocalHashEmbeddings (mock/offline): deterministic hashed word + bigram vectors.
Much weaker than a real model, but lets ingestion and retrieval run with no key.

Each stored vector records the model that produced it, and retrieval only
compares vectors from the same model.
"""
from __future__ import annotations

import hashlib
import math
import re
from abc import ABC, abstractmethod

from .. import config
from .http import post

_WORD = re.compile(r"[a-z0-9ऀ-ॿ']+")


def l2_normalise(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))  # inputs are normalised


class EmbeddingProvider(ABC):
    model_id: str

    @abstractmethod
    def available(self) -> bool: ...

    @abstractmethod
    def embed(self, texts: list[str], *, query: bool = False) -> list[list[float]]: ...


class GeminiEmbeddings(EmbeddingProvider):
    BASE = "https://generativelanguage.googleapis.com/v1beta/models"

    @property
    def model_id(self) -> str:  # type: ignore[override]
        return f"gemini:{config.gemini_embedding_model()}:{config.EMBED_DIM}"

    def available(self) -> bool:
        return bool(config.gemini_key())

    def embed(self, texts: list[str], *, query: bool = False) -> list[list[float]]:
        model = config.gemini_embedding_model()
        out: list[list[float]] = []
        for i in range(0, len(texts), 100):
            batch = texts[i:i + 100]
            body = {"requests": [{
                "model": f"models/{model}",
                "content": {"parts": [{"text": t[:8000]}]},
                "taskType": "RETRIEVAL_QUERY" if query else "RETRIEVAL_DOCUMENT",
                "outputDimensionality": config.EMBED_DIM,
            } for t in batch]}
            r = post(f"{self.BASE}/{model}:batchEmbedContents",
                     headers={"x-goog-api-key": config.gemini_key(), "Content-Type": "application/json"},
                     json=body, timeout=60)
            out.extend(l2_normalise(e["values"]) for e in r.json()["embeddings"])
        return out


class LocalHashEmbeddings(EmbeddingProvider):
    model_id = f"local-hash-v1:{config.EMBED_DIM}"

    def available(self) -> bool:
        return True

    def embed(self, texts: list[str], *, query: bool = False) -> list[list[float]]:
        return [self._one(t) for t in texts]

    def _one(self, text: str) -> list[float]:
        words = [w for w in _WORD.findall(text.lower()) if len(w) > 2]
        feats = words + [f"{a}_{b}" for a, b in zip(words, words[1:])]
        v = [0.0] * config.EMBED_DIM
        for f in feats:
            h = int.from_bytes(hashlib.md5(f.encode()).digest()[:8], "little")
            v[h % config.EMBED_DIM] += 1.0 if (h >> 63) & 1 else -1.0
        return l2_normalise(v)


def by_model_id(model_id: str) -> EmbeddingProvider:
    if model_id.startswith("gemini:"):
        return GeminiEmbeddings()
    return LocalHashEmbeddings()


def default_provider() -> EmbeddingProvider:
    if config.embedding_provider() == "gemini":
        g = GeminiEmbeddings()
        if g.available():
            return g
    return LocalHashEmbeddings()
