"""Configuration for the Digital Legacy feature — everything comes from env vars."""
from __future__ import annotations

import os
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent.parent


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def data_dir() -> Path:
    """Root for the SQLite DB and locally stored files (gitignored)."""
    p = Path(_env("LEGACY_DATA_DIR") or (_BACKEND_DIR / "data"))
    p.mkdir(parents=True, exist_ok=True)
    return p


def db_path() -> Path:
    return Path(_env("LEGACY_DB_PATH") or (data_dir() / "legacy.db"))


def database_url() -> str:
    """Postgres connection string (e.g. Supabase). Empty → local SQLite file."""
    return _env("LEGACY_DATABASE_URL") or _env("DATABASE_URL")


def supabase_url() -> str:
    return _env("SUPABASE_URL").rstrip("/")


def supabase_service_key() -> str:
    """Server-only key: new-style `sb_secret_…` or legacy `service_role` JWT."""
    return _env("SUPABASE_SECRET_KEY") or _env("SUPABASE_SERVICE_ROLE_KEY")


def storage_bucket() -> str:
    return _env("LEGACY_STORAGE_BUCKET", "legacy")


def cache_root() -> Path:
    """Local cache for files kept in cloud storage (FFmpeg and FileResponse need a path)."""
    p = data_dir() / "cache"
    p.mkdir(parents=True, exist_ok=True)
    return p


def storage_root() -> Path:
    p = Path(_env("LEGACY_STORAGE_DIR") or (data_dir() / "storage"))
    p.mkdir(parents=True, exist_ok=True)
    return p


def groq_key() -> str:
    return _env("GROQ_API_KEY") or _env("VITE_GROQ_API_KEY")


def gemini_key() -> str:
    return _env("GEMINI_API_KEY")


# Provider ordering — comma-separated, first that works wins. "mock" is always
# appended as the last resort so the journey never dead-ends.
def chat_llm_order() -> list[str]:
    return [p.strip() for p in _env("LEGACY_CHAT_LLM_ORDER", "groq,gemini").split(",") if p.strip()]


def extraction_llm_order() -> list[str]:
    # Gemini first: transcripts are long and Groq's free tier has a low tokens/min cap.
    return [p.strip() for p in _env("LEGACY_EXTRACT_LLM_ORDER", "gemini,groq").split(",") if p.strip()]


def groq_chat_model() -> str:
    return _env("LEGACY_GROQ_MODEL", "openai/gpt-oss-120b")


def gemini_chat_model() -> str:
    return _env("LEGACY_GEMINI_MODEL", "gemini-3.1-flash-lite")


def whisper_model() -> str:
    return _env("LEGACY_WHISPER_MODEL", "whisper-large-v3-turbo")


def embedding_provider() -> str:
    """'gemini' (real) or 'local' (offline hashing mock)."""
    return _env("LEGACY_EMBEDDINGS", "gemini")


def gemini_embedding_model() -> str:
    return _env("LEGACY_GEMINI_EMBED_MODEL", "gemini-embedding-001")


EMBED_DIM = 768
MAX_UPLOAD_BYTES = int(_env("LEGACY_MAX_UPLOAD_MB", "200")) * 1024 * 1024
SESSION_DAYS = int(_env("LEGACY_SESSION_DAYS", "30"))
