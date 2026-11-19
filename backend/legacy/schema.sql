-- Digital Legacy schema (SQLite dev implementation).
--
-- Written to map 1:1 onto Postgres/Supabase later:
--   TEXT ids        -> uuid
--   TEXT timestamps -> timestamptz (ISO-8601 UTC strings here)
--   TEXT json cols  -> jsonb
--   memories.embedding (JSON float array) -> vector(768) with pgvector
--   users/sessions  -> replaced by Supabase Auth (auth.users)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    born             TEXT,
    passed           TEXT,
    bio              TEXT NOT NULL DEFAULT '',
    photo_key        TEXT,
    language         TEXT NOT NULL DEFAULT 'en-IN',
    style_profile    TEXT NOT NULL DEFAULT '{}',   -- json: tone, phrases, address terms
    voice_provider   TEXT NOT NULL DEFAULT 'browser',
    voice_config     TEXT NOT NULL DEFAULT '{}',   -- json: provider-specific settings
    is_demo          INTEGER NOT NULL DEFAULT 0,
    created_by       TEXT NOT NULL REFERENCES users(id),
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

-- Family access. user_id is NULL while an invite is pending (matched on sign-up by email).
CREATE TABLE IF NOT EXISTS persona_members (
    persona_id   TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
    email        TEXT NOT NULL,
    user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'listener')),
    relationship TEXT NOT NULL DEFAULT '',
    invited_by   TEXT REFERENCES users(id),
    created_at   TEXT NOT NULL,
    PRIMARY KEY (persona_id, email)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON persona_members(user_id);

-- Auditable consent records (persona creation now; voice cloning later).
CREATE TABLE IF NOT EXISTS consents (
    id           TEXT PRIMARY KEY,
    persona_id   TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id),
    kind         TEXT NOT NULL CHECK (kind IN ('persona_creation', 'voice_clone')),
    relationship TEXT NOT NULL,
    statement    TEXT NOT NULL,
    ip           TEXT,
    user_agent   TEXT,
    accepted_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recordings (
    id                TEXT PRIMARY KEY,
    persona_id        TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
    uploaded_by       TEXT NOT NULL REFERENCES users(id),
    title             TEXT NOT NULL,
    source_type       TEXT NOT NULL CHECK (source_type IN ('audio', 'text')),
    speaker_mode      TEXT NOT NULL DEFAULT 'solo',     -- solo | interview | family_account
    storage_key       TEXT,                              -- original file (never modified)
    original_filename TEXT,
    mime_type         TEXT,
    size_bytes        INTEGER,
    duration_sec      REAL,
    recorded_on       TEXT,
    notes             TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'queued',   -- queued|transcribing|extracting|embedding|ready|needs_transcript|failed
    status_detail     TEXT NOT NULL DEFAULT '',
    transcript_text   TEXT,
    transcript_source TEXT,                              -- groq-whisper | manual | text-upload
    language          TEXT,
    extraction_source TEXT,                              -- gemini | groq | mock
    created_at        TEXT NOT NULL,
    processed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_recordings_persona ON recordings(persona_id);

CREATE TABLE IF NOT EXISTS transcript_segments (
    id           TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    idx          INTEGER NOT NULL,
    start_sec    REAL,
    end_sec      REAL,
    text         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_recording ON transcript_segments(recording_id);

CREATE TABLE IF NOT EXISTS memories (
    id              TEXT PRIMARY KEY,
    persona_id      TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
    recording_id    TEXT REFERENCES recordings(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    summary         TEXT NOT NULL,
    excerpt         TEXT NOT NULL DEFAULT '',   -- verbatim words from the transcript
    start_sec       REAL,
    end_sec         REAL,
    time_period     TEXT NOT NULL DEFAULT '',
    places          TEXT NOT NULL DEFAULT '[]',
    themes          TEXT NOT NULL DEFAULT '[]',
    source_kind     TEXT NOT NULL DEFAULT 'own_words',  -- own_words | family_account
    embedding       TEXT,                               -- json float array
    embedding_model TEXT,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_persona ON memories(persona_id);

CREATE TABLE IF NOT EXISTS people (
    id           TEXT PRIMARY KEY,
    persona_id   TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    relationship TEXT NOT NULL DEFAULT '',
    UNIQUE (persona_id, name)
);

CREATE TABLE IF NOT EXISTS memory_people (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    PRIMARY KEY (memory_id, person_id)
);

CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id),
    started_at TEXT NOT NULL,
    ended_at   TEXT
);

CREATE TABLE IF NOT EXISTS conversation_turns (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'persona')),
    text            TEXT NOT NULL,
    source_ids      TEXT NOT NULL DEFAULT '[]',  -- memory ids used to ground this reply
    grounded        INTEGER NOT NULL DEFAULT 0,
    provider        TEXT,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_conversation ON conversation_turns(conversation_id);
