# Story-to-Video Agent — V0 System Overview

---

## Multi-Agent Framework

The system runs five specialized agents in a strict sequential pipeline. Each agent owns one cognitive responsibility and hands a structured JSON output to the next. The rationale for splitting instead of using one large prompt is that a single prompt trying to do everything (script + visual design + image prompt engineering) produces inconsistent, low-quality outputs. Splitting by expertise produces much tighter, focused results from the LLM.

```
User Input (text or voice)
        │
        ▼
┌─────────────────────┐
│  Orchestrator Agent │  — Validates input, sets global seed, manages state and retries
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Scriptwriter Agent │  — Calls Gemini. Converts raw narrative → structured scenes JSON
└────────┬────────────┘     (setting, action, narration, dialogue, transition per scene)
         │
         ▼
┌──────────────────────────┐
│  Visual Director Agent   │  — Calls Gemini. Adds visual composition, shot type,
└────────┬─────────────────┘    camera movement, duration to each scene
         │
         ▼
┌──────────────────────────┐
│  Storyboard Agent        │  — No LLM. Pure logic. Builds image prompts,
└────────┬─────────────────┘    assigns seeds, constructs image URLs
         │
         ▼
┌──────────────────────────┐
│  Video Compiler Agent    │  — Sends storyboard to backend. Backend runs
└────────┬─────────────────┘    gTTS + FFmpeg to compile the final MP4
         │
         ▼
  Interactive Player  +  Downloadable MP4
```

**Agent decisions:**
- **Gemini is called exactly twice** — Scriptwriter and Visual Director. These are the only two steps that require actual language reasoning. Everything else is deterministic logic.
- **JSON mode is enforced** on both Gemini calls using `responseMimeType: "application/json"`. This eliminates markdown wrapping or free-text responses that break parsing.
- **Orchestrator retries once** if a Gemini response fails schema validation before surfacing an error to the user. This handles transient formatting issues without re-running the full pipeline.
- **The global seed** is an integer set once at the start. Each scene gets `seed = globalSeed + sceneIndex`. This means the same story + same seed always produces the exact same storyboard, making the output fully reproducible.

---

## APIs Used and Why

### Gemini 1.5 Flash — Scriptwriter & Visual Director
**Why Gemini Flash specifically:** Flash is the right trade-off for this use case. It is fast enough for two sequential calls without the user waiting too long, and it handles structured JSON output reliably. Pro-tier models would add unnecessary latency and cost for what is essentially a well-scoped structured extraction task, not open-ended reasoning.

**How it is called:** Directly from the browser using the official `@google/generative-ai` JavaScript SDK. The API key is entered by the user and stored in `localStorage`. It never passes through the backend — the backend has no knowledge of Gemini at all.

**What the prompts enforce:** Each call uses a system instruction framing the agent's role (e.g. "You are a professional screenwriter"), followed by the input data, followed by an explicit instruction to return a specific JSON schema. The schema is described inline in the prompt so Gemini knows exactly which fields are required and what type they should be.

---

### Pollinations AI — Image Generation
**Why Pollinations:** It is the only free, no-auth image generation API that supports a `seed` parameter in the URL. This is the critical feature for determinism — the same URL with the same seed always returns the same image. Other free options (like Craiyon or Lexica) do not support seeded generation, which would break reproducibility.

**How it is called:** The Storyboard Agent constructs a URL by URL-encoding the image prompt and appending `?width=1024&height=576&nologo=true&seed={sceneSeed}`. No API key, no SDK — just a plain HTTPS GET request to fetch the image. In the browser this is rendered directly as an `<img src>` or drawn onto canvas.

**Concurrency:** All scene image URLs are fetched simultaneously using `Promise.all` rather than one by one. This is the biggest performance win in the whole pipeline — 10 images take the same time as 1.

---

### Web Speech API — Voice Dictation
**Why browser-native:** The Web Speech API runs entirely in the browser using the device's speech engine (no server round-trip, no cost, no audio upload). It emits live transcript chunks as the user speaks via `onresult` events, which get streamed directly into the input text area. The decision to use this over a server-side Whisper or Google STT integration is simplicity — for v0, there is no need to manage audio streams, file uploads, or transcription billing.

**Limitation acknowledged:** Browser support is currently Chrome and Edge only. Firefox does not support `webkitSpeechRecognition`. This is acceptable for v0 and flagged for v1.

---

### gTTS (Google Text-to-Speech) — Narration Audio
**Why gTTS:** It is the simplest Python library to synthesize human-sounding speech from text. It calls the Google Translate TTS endpoint under the hood and returns an MP3 file. No API key is required.

**How it is used:** The backend generates one MP3 file per scene narration, not one file for the entire story. This granularity is intentional — it allows partial re-renders when a user edits a single scene without invalidating all other audio files.

---

### FFmpeg — Video Compilation
**Why FFmpeg:** It is the only tool that can combine static images, audio tracks, and filter effects (Ken Burns zoom/pan, crossfades) into a proper H.264/AAC `.mp4` file at no cost. It runs as a subprocess called by the FastAPI backend.

**What it does specifically:**
- Loops each static image for the duration of its scene.
- Applies a `zoompan` filter to create the Ken Burns camera animation (zoom-in, zoom-out, or pan direction) based on the Visual Director's camera movement instruction for that scene.
- Applies `xfade` transitions between scenes (fade, crossfade, or hard cut depending on the Scriptwriter's transition field).
- Concatenates all per-scene audio MP3s into one audio track aligned to the video.
- Outputs a single H.264 video with AAC audio, compatible with all browsers and devices.

---

## Backend Architecture

**Stack:** FastAPI · gTTS · FFmpeg · Requests · Pydantic

The backend does not call any LLM. Its only job is media asset processing and compilation.

**Why FastAPI:** Async-first, fast, and BackgroundTasks is built-in — exactly what is needed to run FFmpeg jobs without blocking the server. A Flask server would block on each export request.

**Request flow:**
- Frontend POSTs the storyboard JSON to `/api/export`.
- The endpoint validates the payload with Pydantic, registers a background job, and immediately returns a `task_id`. The server thread is freed.
- The background job downloads images, generates per-scene audio files, runs FFmpeg, and writes the result to a temp directory on disk.
- The frontend polls `/api/export/status/{task_id}` every 2 seconds until status is `completed`.
- The frontend then hits `/api/export/download/{task_id}` to receive the file.

**Caching decision:** Completed MP4 files are stored on disk keyed by a hash of the storyboard JSON. If the user requests an export of the same storyboard twice, the backend detects the matching hash and skips recompilation, serving the cached file immediately.

---

## Frontend Architecture

**Stack:** React · Vite · HTML5 Canvas · Web Speech API · SpeechSynthesis API

The frontend owns the entire agent pipeline execution, the UI state, and the in-browser player. The backend is only contacted at export time.

**Input Panel:** A text area for narrative input, a microphone toggle that activates live Web Speech transcription, a style preset dropdown (maps to a pre-written global style string passed to agents), and a seed number input. These four inputs define the entire generation run.

**Agent execution:** When the user triggers generation, the frontend calls Gemini twice (Scriptwriter, then Visual Director), then runs the Storyboard Agent locally to build image prompts and URLs. All of this happens in the browser — no backend involvement.

**Storyboard Grid:** Renders a card for each scene showing the Pollinations image (loaded in parallel), narration text, camera movement label, and duration. Cards are clickable to jump the player to any scene.

**Interactive Theater (Canvas Player):**
- An HTML5 canvas element acts as the video screen.
- On play, the current scene's image is drawn onto the canvas and redrawn on every `requestAnimationFrame` tick with a progressive zoom or pan offset calculated from elapsed time and scene duration. This is the Ken Burns effect — no video file needed in the browser.
- The browser's native `SpeechSynthesis` API reads the narration text aloud, synchronized to the scene start.
- Subtitles are drawn directly onto the canvas as an overlay.
- When elapsed time exceeds the scene duration, the player auto-advances to the next scene.

**Why in-browser player instead of serving a video:** The in-browser player gives instant feedback — the user can start watching while images are still loading for later scenes. The exported MP4 is a separate deliverable for sharing, not for in-app playback.

---

## Bottleneck Handling

**Image generation latency**
All Pollinations image URLs are resolved in parallel. The browser fires all fetch requests simultaneously and waits for all to resolve together. A 10-scene storyboard takes ~3–4 seconds total instead of 30–40 seconds sequentially.

**FFmpeg compilation blocking the server**
FFmpeg is CPU-bound and can take 20–60 seconds for a long storyboard. Running it synchronously would block the FastAPI thread and time out the client. It runs as a background task — the server returns instantly with a task ID and the client polls for completion. No thread is held open.

**Partial scene edits triggering full re-renders**
Audio files are generated per scene and stored with a filename tied to the scene number and narration hash. Editing one scene's narration only regenerates that scene's MP3. All other audio files are reused from disk, cutting re-export time significantly for minor edits.

**Visual drift across scenes**
Two things are injected into every image prompt automatically: the global style string from the Visual Director (locking art style, lighting, and rendering aesthetic) and a character reference block extracted from the first scene each character appears in (locking physical appearance). Without these injections, diffusion models change character features and art style between frames.

**Ambiguous or incomplete input**
The Scriptwriter Agent's prompt instructs Gemini to never leave a field empty and to infer plausible story logic when the input is vague. A two-sentence input should still produce a coherent 5-scene breakdown. This is a prompt engineering decision, not a code one.

**LLM response unpredictability**
Both Gemini calls use JSON mode to enforce structured output. If the response still fails schema validation (wrong field type, missing key), the Orchestrator retries that single agent call once with the same input before failing. This handles the rare case of malformed output without re-running the entire pipeline.
