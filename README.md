# Stories by Oldies — Story → Storyboard Video

A complete end-to-end AI-powered pipeline that transforms short stories into cinematic storyboard videos.

---

## Architecture

```
Story Text → [Gemini Scriptwriter] → Scene JSON
           → [Gemini Visual Director] → Enriched Scenes (shot type, camera movement, duration)
           → [Storyboard Agent] → Pollinations.ai image URLs + seeds
           → [Canvas Player] → Ken Burns animation + SpeechSynthesis narration
           → [FastAPI Backend] → gTTS audio + FFmpeg compilation → MP4 download
```

## Quick Start

**Prerequisites:** Python 3.9+, Node 18+, FFmpeg, Gemini API key

```bash
# 1. Clone and enter project
cd story-visualizer-agent

# 2. Launch everything (backend + frontend)
./start.sh
```

Then open **http://localhost:5173** in your browser.

---

## Manual Start

**Backend (FastAPI)**
```bash
cd backend
pip install -r requirements.txt
mkdir -p outputs/exports outputs/tts
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

**Frontend (React + Vite)**
```bash
cd frontend
npm install
npm run dev
```

---

## Features

| Feature | Technology |
|---|---|
| AI Scene Breakdown | Google Gemini (auto-discovers best model) |
| Visual Director | Google Gemini (shot type, camera movement, duration) |
| Image Generation | Pollinations.ai (free, seeded, deterministic) |
| Ken Burns Player | HTML5 Canvas + requestAnimationFrame |
| Narration Audio | Web Speech Synthesis API (browser) |
| Voice Input | Web Speech Recognition API (Chrome/Edge) |
| TTS Narration Export | gTTS (Google TTS, no key needed) |
| Video Compilation | FFmpeg (H.264 + AAC, xfade transitions, zoompan) |
| Style Presets | 7 presets: Cinematic, Anime, Watercolor, Noir, Sci-Fi, Fantasy, Documentary |

---

## API Reference (Backend)

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Server status + FFmpeg path |
| `/api/export` | POST | Queue video compilation job → `task_id` |
| `/api/export/status/{id}` | GET | Poll job progress (0–100) |
| `/api/export/download/{id}` | GET | Download compiled MP4 |
| `/api/tts` | POST | Synthesise narration MP3 for one scene |
| `/api/tts/audio/{fname}` | GET | Serve TTS MP3 |

---

## Project Structure

```
story-visualizer-agent/
├── backend/
│   ├── main.py           # FastAPI app + API endpoints
│   ├── compiler.py       # FFmpeg + gTTS compilation pipeline
│   ├── models.py         # Pydantic schemas
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── agents/
│       │   ├── gemini.ts        # Gemini API caller + model discovery
│       │   ├── scriptwriter.ts  # Agent 1: story → scenes
│       │   ├── visualDirector.ts# Agent 2: enrich with camera metadata
│       │   ├── storyboard.ts    # Agent 3: build image URLs
│       │   └── orchestrator.ts  # Pipeline coordinator
│       ├── components/
│       │   ├── InputPanel.tsx   # Story input, style, seed, voice
│       │   ├── PipelineStatus.tsx # Live agent progress tracker
│       │   ├── StoryboardGrid.tsx # Scene cards with lazy images
│       │   ├── CanvasPlayer.tsx  # Ken Burns player + controls
│       │   └── ExportPanel.tsx  # MP4 export + download
│       ├── App.tsx
│       ├── types.ts
│       └── index.css       # Full dark cinematic design system
├── start.sh               # Launch both servers
├── beta_story2vid.py      # Original CLI script (preserved)
└── .env                   # GEMINI_API_KEY
```

---

## Determinism

- **Images**: `seed = global_seed + scene_number` → same story + seed = same images always
- **LLM**: `temperature = 0.2` + JSON mode → consistent structured output
- **Video cache**: Storyboard JSON is SHA-256 hashed; same export skips recompilation

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `address already in use` on port 8000 | `lsof -ti :8000 \| xargs kill -9` |
| Images loading slowly | Pollinations.ai can take 20–60s; normal behaviour |
| Voice input not working | Chrome/Edge only; Firefox doesn't support WebSpeech |
| Export fails | Check backend is running at `http://localhost:8000/api/health` |
| Gemini API error | Verify `GEMINI_API_KEY` in `.env` and your quota |
