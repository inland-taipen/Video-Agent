# AI Digital Legacy — prototype

Family members upload a loved one's recorded stories. The app turns them into a searchable memory archive that family can **talk to by voice**. Answers come only from what was recorded.

It's a separate section of the app (**Digital Legacy** in the header, `#/legacy`). The Stories pipeline is unchanged.

## Run it

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt
.venv/bin/python -m legacy.seed_demo        # optional: fictional demo persona (demo@example.com / demo-legacy)
.venv/bin/python -m uvicorn main:app --port 8000 --reload

cd ../frontend && npm install && npm run dev  # http://localhost:5173/#/legacy  (use Chrome or Edge for voice)
```

Tests (offline; no keys needed): `cd backend && .venv/bin/python -m pytest tests -q`

## Status: working, mocked or deferred

| Area | Status | Notes |
|---|---|---|
| Accounts, sessions | ✅ Working | Local email/password (PBKDF2), bearer tokens |
| Persona profile, photo, bio | ✅ Working | |
| Consent on creation | ✅ Working | The exact statement, user, IP and time are stored in `consents` |
| Family access (owner / editor / listener) | ✅ Working | Invites by email, claimed on sign-up. **No email is sent** (mocked) |
| Upload audio / record in browser / paste text | ✅ Working | Original file kept unchanged; served only to members |
| Speech-to-text for uploads | ✅ Working (needs a valid `GROQ_API_KEY`) | Groq Whisper; FFmpeg normalises audio and splits long files into chunks. **Fallback:** status "Needs transcript", and family can paste one |
| Memory extraction (stories, people, places, dates, speaking style) | ✅ Working (needs Gemini or Groq) | **Fallback (mock):** splits by paragraph and keeps the exact words. Marked in the UI, with a Retry button |
| Embeddings and search | ✅ Working (Gemini `gemini-embedding-001`) | **Fallback (mock):** offline hashed keyword vectors. Every vector stores which model made it |
| Grounded conversation | ✅ Working (Groq → Gemini, streamed) | Prompt forbids invented memories; each reply records which memories it used. **Fallback (mock):** quotes the recorded words or says "I don't think I recorded that" |
| Live voice call | ✅ Working | Browser speech recognition, or Whisper on the server via voice detection. Replies are spoken sentence by sentence. Interrupt by tapping, pressing Space, or (with headphones) speaking. Gentle prompt after 20s of silence, then hangs up. Type instead if you prefer |
| Voice output | ✅ Working (temporary) | Browser `speechSynthesis`, always labelled "computer voice, not theirs" |
| Server-side voice provider | ⏸ Deferred | `ElevenLabsVoice` + `ServerTextToSpeech` are wired up but off (`LEGACY_ENABLE_ELEVENLABS=1`) |
| Voice **cloning** | ⏸ Deferred | Needs a paid plan, clean single-speaker clips, and a `voice_clone` consent record (the consent text is already defined) |
| Hosted database + file storage | ✅ Working | Postgres (e.g. Supabase) via `DATABASE_URL`, recordings in a private Supabase Storage bucket via `LEGACY_STORAGE=supabase`. Without them: SQLite + local disk (dev only — wiped on every Render deploy) |
| Encryption at rest, audit log, email delivery | ⏸ Deferred | |

## Architecture

```
backend/legacy/
  schema.sql        SQLite schema written to port to Postgres/pgvector (see header comment)
  db.py             tiny data layer (WAL mode)
  auth.py           sessions + role checks; swap for Supabase JWT verification later
  storage.py        StorageBackend → LocalStorage (cloud backends implement the same 4 methods)
  providers/
    stt.py          STTProvider → GroqWhisperSTT
    llm.py          LLMProvider → GroqLLM, GeminiLLM (+ ordered fallback, streaming)
    embeddings.py   EmbeddingProvider → GeminiEmbeddings, LocalHashEmbeddings (mock)
    voice.py        VoiceProvider → BrowserVoice, ElevenLabsVoice (deferred)
  ingestion.py      queued → transcribing → extracting → embedding → ready (single background worker)
  retrieval.py      hybrid search: cosine + keyword scores
  engine.py         system prompt + honesty rules + streamed reply (NDJSON)
  routes.py         /api/legacy/*
frontend/src/legacy/
  voice/            SpeechToTextProvider + TextToSpeechProvider interfaces and implementations
  call/             useVoiceCall state machine, CallScreen, Visualizer
  components/       pages and tabs
```

**Adding a provider:** subclass the interface, register it in that module's registry, then select it with an env var (backend) or `voice/index.ts` (frontend). The conversation code doesn't change.

## Deploying (Render + Supabase)

Render's disk is wiped on every deploy and restart, so production needs a hosted database and file store. One free Supabase project provides both.

1. Create a project at supabase.com.
2. **Database:** Project → Connect → **Session pooler** → copy the URI (Render has no IPv6, so don't use the "Direct connection" one). Put your database password into it.
3. **Storage:** Project Settings → API → copy the Project URL and the `service_role` key (secret — server only). The private bucket `legacy` is created automatically on first upload.
4. In Render → your service → Environment, add:
   ```
   DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   LEGACY_STORAGE=supabase
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service_role key>
   ```
   plus the provider keys (`GROQ_API_KEY`, `GEMINI_API_KEY`, …).
5. Deploy. Tables are created automatically on first start. Optional demo persona: run `python -m legacy.seed_demo` once with those env vars set (locally or in the Render shell).

The SQL is written SQLite-style; `db.py` rewrites it for Postgres (`?` → `%s`, `INSERT OR IGNORE`, `group_concat`). Run the tests against Postgres with `LEGACY_TEST_DATABASE_URL=postgresql://… pytest tests`.

**Later (Supabase-native):** map `TEXT` json → `jsonb` and `embedding` → `vector(768)` with a pgvector query in `retrieval.search`, and swap `auth.current_user` for Supabase JWT verification.

## Honesty and safety safeguards

- Disclosure before every call, a permanent "AI recreation" badge during the call, and a spoken disclosure in the greeting.
- Answers may only use retrieved memories. Below a relevance threshold the AI is told it has no match and must say so.
- Family-written accounts are tagged so the AI says "the family remembers…" instead of claiming them first-hand.
- Generated speech is never stored as a recording. "Play original recording" always plays the real upload.
- Conversations are private to the person who had them. Non-members get 404s, so persona IDs can't be probed.

## Known limits

- **Render's disk is wiped on redeploy:** `backend/data/` (database + recordings) is lost. Use a persistent disk or Supabase before storing real family data.
- **Browser speech recognition** sends audio to Google (Chrome) or Apple (Safari). The "Whisper (server)" mode avoids this.
- **Speaking to interrupt** only works reliably with headphones, because the browser voice isn't echo-cancelled.
- **Free tiers:** Groq's free tier caps tokens per minute, so long chats can briefly fall back to Gemini, and failing that to quotes.
