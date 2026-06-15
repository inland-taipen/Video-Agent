"""
main.py — FastAPI backend for Story Visualizer Agent

Endpoints:
  POST  /api/export            → queue compilation job, return task_id
  GET   /api/export/status/{id}→ {status, progress, message, download_url}
  GET   /api/export/download/{id}→ stream MP4
  POST  /api/tts               → synthesise narration MP3 for one scene
  GET   /api/health            → {ok: true}
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Dict, Optional

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from gtts import gTTS

from compiler import compile_video
from image_gen import fetch_scene_image
from models import ExportRequest, ExportStatus, TTSRequest, TTSResponse

load_dotenv()

# ─────────────────────────────────────────────────────────────────────────────
app = FastAPI(title="Story Visualizer API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FFMPEG_BIN = shutil.which("ffmpeg") or "ffmpeg"
EXPORT_DIR = Path(os.getenv("EXPORT_DIR", "outputs/exports"))
EXPORT_DIR.mkdir(parents=True, exist_ok=True)

TTS_DIR = Path(os.getenv("TTS_DIR", "outputs/tts"))
TTS_DIR.mkdir(parents=True, exist_ok=True)

# In-memory job store (fine for single-process server)
_jobs: Dict[str, ExportStatus] = {}
_job_lock = threading.Lock()


# ─────────────────────────────────────────────────────────────────────────────
# Health
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "ffmpeg": FFMPEG_BIN,
        "image_providers": {
            "pollinations_key": bool(os.getenv("POLLINATIONS_API_KEY", "").strip()),
            "hf_token": bool(os.getenv("HF_TOKEN", "").strip()),
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# Image generation — proxies free-tier providers (Pollinations / HuggingFace)
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/image")
async def generate_image(prompt: str, seed: int = 42, width: int = 1024, height: int = 576):
    if not prompt.strip():
        raise HTTPException(400, "prompt is empty")
    width = max(256, min(width, 1920))
    height = max(256, min(height, 1080))
    try:
        data = fetch_scene_image(prompt.strip(), seed, width, height)
    except Exception as exc:
        raise HTTPException(500, f"Image generation failed: {exc}")
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


# ─────────────────────────────────────────────────────────────────────────────
# TTS endpoint — synthesise one scene's narration
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/tts", response_model=TTSResponse)
async def tts(req: TTSRequest):
    if not req.text.strip():
        raise HTTPException(400, "text is empty")

    text_hash = hashlib.md5(f"{req.text}_{req.lang}".encode()).hexdigest()[:12]
    fname = f"scene_{req.scene_number}_{text_hash}.mp3"
    dest = TTS_DIR / fname

    if not dest.exists():
        try:
            tts_obj = gTTS(text=req.text, lang=req.lang, slow=False)
            tts_obj.save(str(dest))
        except Exception as exc:
            raise HTTPException(500, f"TTS failed: {exc}")

    return TTSResponse(
        scene_number=req.scene_number,
        audio_url=f"/api/tts/audio/{fname}",
    )


@app.get("/api/tts/audio/{fname}")
async def tts_audio(fname: str):
    dest = TTS_DIR / fname
    if not dest.exists():
        raise HTTPException(404, "Audio file not found")
    return FileResponse(str(dest), media_type="audio/mpeg")


# ─────────────────────────────────────────────────────────────────────────────
# Export endpoints
# ─────────────────────────────────────────────────────────────────────────────

def _storyboard_hash(request: ExportRequest) -> str:
    payload = json.dumps(
        [f.dict() for f in request.frames],
        sort_keys=True, default=str
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _run_compilation(task_id: str, request: ExportRequest, out_path: Path) -> None:
    def progress(pct: int, msg: str):
        with _job_lock:
            job = _jobs[task_id]
            job.progress = pct
            job.message = msg
            if pct >= 100:
                job.status = "completed"
                job.download_url = f"/api/export/download/{task_id}"
            else:
                job.status = "running"

    with _job_lock:
        _jobs[task_id].status = "running"

    try:
        compile_video(request, out_path, FFMPEG_BIN, progress)
    except Exception as exc:
        with _job_lock:
            job = _jobs[task_id]
            job.status = "failed"
            job.error = str(exc)
            job.progress = 0
            job.message = "Compilation failed"
        print(f"[ERROR] Task {task_id}: {exc}")


@app.post("/api/export", response_model=ExportStatus)
async def export_video(request: ExportRequest, background_tasks: BackgroundTasks):
    if not request.frames:
        raise HTTPException(400, "frames list is empty")

    sb_hash = request.storyboard_hash or _storyboard_hash(request)
    cached_path = EXPORT_DIR / f"{sb_hash}.mp4"

    # Cache hit
    if cached_path.exists() and cached_path.stat().st_size > 1000:
        task_id = f"cached_{sb_hash}"
        status = ExportStatus(
            task_id=task_id,
            status="completed",
            progress=100,
            message="Served from cache",
            download_url=f"/api/export/download/{task_id}",
        )
        with _job_lock:
            _jobs[task_id] = status
        return status

    # New job
    task_id = str(uuid.uuid4())
    out_path = EXPORT_DIR / f"{task_id}.mp4"

    job = ExportStatus(task_id=task_id, status="queued", progress=0, message="Queued…")
    with _job_lock:
        _jobs[task_id] = job

    background_tasks.add_task(_run_compilation, task_id, request, out_path)
    return job


@app.get("/api/export/status/{task_id}", response_model=ExportStatus)
async def export_status(task_id: str):
    with _job_lock:
        job = _jobs.get(task_id)
    if not job:
        raise HTTPException(404, "Task not found")
    return job


@app.get("/api/export/download/{task_id}")
async def export_download(task_id: str):
    with _job_lock:
        job = _jobs.get(task_id)
    if not job:
        raise HTTPException(404, "Task not found")
    if job.status != "completed":
        raise HTTPException(400, f"Job not completed (status={job.status})")

    # Cached file path uses hash prefix
    if task_id.startswith("cached_"):
        sb_hash = task_id[len("cached_"):]
        out_path = EXPORT_DIR / f"{sb_hash}.mp4"
    else:
        out_path = EXPORT_DIR / f"{task_id}.mp4"

    if not out_path.exists():
        raise HTTPException(404, "Video file not found on disk")

    return FileResponse(
        str(out_path),
        media_type="video/mp4",
        filename="story_video.mp4",
        headers={"Content-Disposition": "attachment; filename=story_video.mp4"},
    )


# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
