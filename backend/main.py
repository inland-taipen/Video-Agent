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
from fastapi.staticfiles import StaticFiles
from gtts import gTTS

from pydantic import BaseModel

from compiler import compile_video
from image_gen import fetch_scene_image
from models import (
    ExportRequest, ExportStatus, TTSRequest, TTSResponse,
    ValidateRequest, StoryValidationResult, StoryValidationError,
)

load_dotenv(Path(__file__).parent.parent / ".env", override=True)

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
    gemini_key = (
        os.getenv("GEMINI_IMAGE_KEY", "").strip()
        or os.getenv("GEMINI_API_KEY", "").strip()
    )
    return {
        "ok": True,
        "ffmpeg": FFMPEG_BIN,
        "image_providers": {
            "gemini_image": bool(gemini_key),
            "gemini_image_model": os.getenv("GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image"),
            "gemini_api_key": bool(os.getenv("GEMINI_API_KEY", "").strip()),
            "pollinations_key": bool(os.getenv("POLLINATIONS_API_KEY", "").strip()),
            "hf_token": bool(os.getenv("HF_TOKEN", "").strip()),
            "bfl_key": bool(os.getenv("BFL_API_KEY", "").strip()),
        },
        "video_providers": {
            "veo": bool(gemini_key),
            "veo_model": os.getenv("VEO_MODEL", "veo-3.0-generate-preview"),
        },
    }


# SECURITY: the old /api/config endpoint returned raw API keys to any caller.
# It has been removed. The frontend now calls /api/llm below, and the Gemini
# key stays on the server.

class LLMRequest(BaseModel):
    prompt: str
    json_mode: bool = True
    model: str = "gemini-2.5-flash"


def _call_gemini(prompt: str, model: str, json_mode: bool, key: str):
    import requests
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "topP": 0.95},
    }
    if json_mode:
        body["generationConfig"]["responseMimeType"] = "application/json"
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        json=body,
        timeout=120,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Gemini {r.status_code}: {r.text[:300]}")
    data = r.json()
    return data["candidates"][0]["content"]["parts"][0]["text"]


def _call_groq(prompt: str, json_mode: bool, key: str):
    import requests
    body = {
        "model": os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
        "top_p": 0.95,
    }
    _ = json_mode
    r = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=body,
        timeout=120,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Groq {r.status_code}: {r.text[:300]}")
    return r.json()["choices"][0]["message"]["content"]


def _call_aicredits(prompt: str, key: str):
    """Call AICredits OpenAI-compatible gateway (api.aicredits.in).

    Supports GPT-4o, Claude, Gemini, and 300+ models via UPI-paid credits.
    Uses gemini-2.5-flash by default (fast + cheap).
    """
    import requests
    model = os.getenv("AICREDITS_MODEL", "gemini-2.5-flash")
    r = requests.post(
        "https://api.aicredits.in/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.2,
            "top_p": 0.95,
        },
        timeout=120,
    )
    if r.status_code != 200:
        raise RuntimeError(f"AICredits {r.status_code}: {r.text[:300]}")
    return r.json()["choices"][0]["message"]["content"]


@app.post("/api/llm")
def llm_proxy(req: LLMRequest):
    """LLM proxy waterfall: AICredits → Groq → Gemini.

    1. AICredits (aicredits.in) — OpenAI-compatible, UPI payments in ₹
    2. Groq (Llama 3.3 70B) — fast free fallback
    3. Gemini (native endpoint) — Google fallback
    """
    aicredits_key = os.getenv("AICREDITS_API_KEY", "").strip()
    groq_key = os.getenv("GROQ_API_KEY", "").strip() or os.getenv("VITE_GROQ_API_KEY", "").strip()
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()

    errors = []

    # 1. AICredits — primary (OpenAI-compatible, INR billing)
    if aicredits_key:
        try:
            text = _call_aicredits(req.prompt, aicredits_key)
            if text:
                print(f"  [OK] AICredits served LLM request")
                return {"text": text, "provider": "aicredits"}
            errors.append("AICredits returned empty text")
        except Exception as exc:
            errors.append(str(exc))
            print(f"  [WARN] AICredits failed: {exc}")
    else:
        errors.append("AICREDITS_API_KEY not set")

    # 2. Groq — free fast fallback
    if groq_key:
        try:
            text = _call_groq(req.prompt, req.json_mode, groq_key)
            if text:
                print(f"  [WARN] Using Groq fallback")
                return {"text": text, "provider": "groq"}
            errors.append("Groq returned empty text")
        except Exception as exc:
            errors.append(str(exc))
    else:
        errors.append("GROQ_API_KEY not set")

    # 3. Gemini — last resort
    if gemini_key:
        try:
            text = _call_gemini(req.prompt, req.model, req.json_mode, gemini_key)
            if text:
                print(f"  [WARN] Using Gemini fallback")
                return {"text": text, "provider": "gemini"}
            errors.append("Gemini returned empty text")
        except Exception as exc:
            errors.append(str(exc))
    else:
        errors.append("GEMINI_API_KEY not set")

    raise HTTPException(502, "All LLM providers failed: " + " | ".join(e[:200] for e in errors))


# ─────────────────────────────────────────────────────────────────────────────
# Story Validation — deterministic, no LLM (V2.1)
# ─────────────────────────────────────────────────────────────────────────────

MIN_DURATION = 2
MAX_DURATION = 10
MAX_TOTAL_DURATION = 240  # 4 minutes
VALID_TRANSITIONS = {"FADE IN", "CUT TO", "CROSSFADE", "DISSOLVE", "WIPE"}

@app.post("/api/validate", response_model=StoryValidationResult)
def validate_story(req: ValidateRequest):
    """Deterministic story validation. No LLM calls.
    
    Checks: narration present, visual_description present, durations valid,
    total time under 4 min, transitions valid, characters referenced exist.
    """
    errors: list[StoryValidationError] = []
    warnings: list[str] = []
    total = 0

    char_names = set((req.characters or {}).keys())

    for scene in req.scenes:
        sn = scene.scene_number
        if not (scene.narration or "").strip():
            errors.append(StoryValidationError(
                scene_number=sn, field="narration",
                message=f"Scene {sn} has empty narration",
            ))
        if not (scene.visual_description or "").strip():
            errors.append(StoryValidationError(
                scene_number=sn, field="visual_description",
                message=f"Scene {sn} has empty visual_description",
            ))
        dur = scene.duration
        if dur < MIN_DURATION or dur > MAX_DURATION:
            errors.append(StoryValidationError(
                scene_number=sn, field="duration",
                message=f"Scene {sn} duration {dur} outside [{MIN_DURATION}, {MAX_DURATION}]",
            ))
        total += dur
        trans = (scene.transition or "").strip().upper()
        if trans and trans not in VALID_TRANSITIONS:
            warnings.append(f"Scene {sn}: unknown transition '{scene.transition}'")
        if char_names:
            for dl in scene.dialogue:
                sp = (dl.speaker or "").strip()
                if sp and sp not in char_names:
                    warnings.append(f"Scene {sn}: speaker '{sp}' not in characters")

    if total > MAX_TOTAL_DURATION:
        errors.append(StoryValidationError(
            scene_number=0, field="total_duration",
            message=f"Total {total}s exceeds max {MAX_TOTAL_DURATION}s",
        ))

    return StoryValidationResult(
        valid=len(errors) == 0,
        errors=errors,
        warnings=warnings,
    )


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
# Image generation — FLUX.1-schnell via HF Inference API (free tier)
# Falls back to Pollinations.ai if HF unavailable
# ─────────────────────────────────────────────────────────────────────────────

class ImagenRequest(BaseModel):
    prompt: str
    seed: int = 42
    aspect_ratio: str = "16:9"
    mode: str = "animated"

@app.post("/api/imagen")
async def imagen_generate(req: ImagenRequest):
    if not req.prompt.strip():
        raise HTTPException(400, "prompt is empty")
    try:
        data = fetch_scene_image(req.prompt.strip(), req.seed, width=1024, height=576, mode=req.mode)
    except Exception as exc:
        raise HTTPException(500, f"Image generation failed: {exc}")

    import base64
    b64 = base64.b64encode(data).decode()
    return JSONResponse({"dataUrl": f"data:image/jpeg;base64,{b64}"})


# ─────────────────────────────────────────────────────────────────────────────
# HuggingFace FLUX.1-schnell Image Generation
# Uses the existing HF_TOKEN — no new signup needed.
# Produces high-quality anime, cinematic, realistic images.
# ─────────────────────────────────────────────────────────────────────────────

class HFImageRequest(BaseModel):
    prompt: str
    seed: int = 42
    style: str = "default"  # maps to FLUX_STYLE_PROMPTS keys


@app.post("/api/hf-image")
async def hf_image_generate(req: HFImageRequest):
    """Generate via HuggingFace FLUX.1-schnell (free, uses existing HF_TOKEN).
    Enhances prompt with style-specific keywords for best results.
    Returns 503 if HF_TOKEN is not set.
    """
    if not req.prompt.strip():
        raise HTTPException(400, "prompt is empty")

    import base64
    from image_gen import _try_huggingface, FLUX_STYLE_PROMPTS

    hf_token = os.getenv("HF_TOKEN", "").strip()
    if not hf_token:
        raise HTTPException(503, "HF_TOKEN not set")

    style_suffix = FLUX_STYLE_PROMPTS.get(req.style, FLUX_STYLE_PROMPTS["default"])
    enhanced_prompt = f"{req.prompt.strip()}, {style_suffix}"

    raw = _try_huggingface(enhanced_prompt, width=1024, height=576)
    if raw:
        b64 = base64.b64encode(raw).decode()
        mime = "image/png" if raw[:4] == b'\x89PNG' else "image/jpeg"
        print(f"  [OK] HuggingFace FLUX image style={req.style}")
        return JSONResponse({"dataUrl": f"data:{mime};base64,{b64}", "provider": "hf/flux-schnell"})

    raise HTTPException(503, "HuggingFace FLUX generation failed")


# ─────────────────────────────────────────────────────────────────────────────
# FLUX Image Generation via fal.ai
# Best-in-class open-weights model — ideal for realistic anime & cinematic art.
# Models: flux/dev (quality), flux/schnell (speed)
# Sign up at https://fal.ai to get a free FAL_API_KEY
# ─────────────────────────────────────────────────────────────────────────────

class FluxImageRequest(BaseModel):
    prompt: str
    seed: int = 42
    aspect_ratio: str = "16:9"
    model: str = "dev"  # "dev" = quality, "schnell" = fast


def _call_flux(prompt: str, key: str, model: str, seed: int) -> bytes:
    """Call FLUX.1 via fal.ai REST API. Returns raw image bytes."""
    import requests as _req

    fal_model = f"fal-ai/flux/{model}"
    r = _req.post(
        f"https://fal.run/{fal_model}",
        headers={"Authorization": f"Key {key}", "Content-Type": "application/json"},
        json={
            "prompt": prompt,
            "image_size": "landscape_16_9",
            "num_inference_steps": 28 if model == "dev" else 4,
            "seed": seed,
            "num_images": 1,
            "enable_safety_checker": False,
        },
        timeout=120,
    )
    if r.status_code != 200:
        raise RuntimeError(f"FLUX/{model} {r.status_code}: {r.text[:300]}")

    data = r.json()
    images = data.get("images", [])
    if not images:
        raise RuntimeError(f"FLUX returned no images")

    # fal.ai returns a URL — fetch the actual image bytes
    img_url = images[0].get("url", "")
    if not img_url:
        raise RuntimeError("FLUX returned no image URL")
    img_r = _req.get(img_url, timeout=30)
    img_r.raise_for_status()
    return img_r.content


@app.post("/api/flux-image")
async def flux_image_generate(req: FluxImageRequest):
    """Generate a high-quality image via FLUX.1 (fal.ai).

    Uses FAL_API_KEY from env. Falls back to Gemini → HF/Pollinations.
    Best for: realistic anime, cinematic, documentary, fantasy styles.
    """
    if not req.prompt.strip():
        raise HTTPException(400, "prompt is empty")

    import base64

    fal_key = os.getenv("FAL_API_KEY", "").strip()

    if fal_key:
        for model in [req.model, "schnell"] if req.model == "dev" else [req.model]:
            try:
                raw = _call_flux(req.prompt.strip(), fal_key, model, req.seed)
                b64 = base64.b64encode(raw).decode()
                mime = "image/png" if raw[:4] == b'\x89PNG' else "image/jpeg"
                print(f"  [OK] FLUX image via fal.ai/{model}")
                return JSONResponse({"dataUrl": f"data:{mime};base64,{b64}", "provider": f"flux/{model}"})
            except Exception as exc:
                print(f"  [WARN] FLUX/{model}: {str(exc)[:120]}")
    else:
        print("  [INFO] No FAL_API_KEY — falling back to Gemini/HF/Pollinations")

    # Fallback to Gemini image
    gemini_key = (
        os.getenv("GEMINI_IMAGE_KEY", "").strip()
        or os.getenv("GEMINI_API_KEY", "").strip()
    )
    if gemini_key:
        for g_model in ["gemini-2.5-flash-image"]:
            try:
                raw = _call_gemini_image(req.prompt.strip(), gemini_key, g_model)
                b64 = base64.b64encode(raw).decode()
                mime = "image/png" if raw[:4] == b'\x89PNG' else "image/jpeg"
                return JSONResponse({"dataUrl": f"data:{mime};base64,{b64}", "provider": f"gemini/{g_model}"})
            except Exception as exc:
                print(f"  [WARN] Gemini fallback {g_model}: {str(exc)[:120]}")

    # Final fallback — Pollinations/HF
    try:
        data = fetch_scene_image(req.prompt.strip(), req.seed, width=1024, height=576, mode="animated")
        b64 = base64.b64encode(data).decode()
        return JSONResponse({"dataUrl": f"data:image/jpeg;base64,{b64}", "provider": "fallback"})
    except Exception as exc:
        raise HTTPException(500, f"All image providers failed: {exc}")


# ─────────────────────────────────────────────────────────────────────────────
# Stable Horde Image Generation
# 100% free, community GPU pool. No card needed.
# Sign up at https://stablehorde.net — use STABLE_HORDE_API_KEY
# ─────────────────────────────────────────────────────────────────────────────

# Best models per style — full list at https://stablehorde.net/models
HORDE_MODELS = {
    "anime":            ["Anime Pastel Dream", "Anything V5"],
    "realistic_anime":  ["DreamShaper", "Anything V5"],
    "cinematic":        ["DreamShaper", "Realistic Vision"],
    "documentary":      ["Realistic Vision", "ICBINP"],
    "fantasy":          ["DreamShaper", "Anything V5"],
    "default":          ["DreamShaper"],
}

class HordeImageRequest(BaseModel):
    prompt: str
    seed: int = 42
    aspect_ratio: str = "16:9"
    style: str = "default"


def _call_stable_horde(prompt: str, key: str, models: list, seed: int) -> bytes:
    """Submit to Stable Horde and poll until done (max 120s). Returns image bytes."""
    import requests as _req
    import time as _time
    import base64 as _b64

    headers = {
        "apikey": key,
        "Content-Type": "application/json",
        "Client-Agent": "story-visualizer:1.0",
    }

    # 1. Submit job
    body = {
        "prompt": prompt,
        "params": {
            "width": 1024,
            "height": 576,
            "steps": 25,
            "sampler_name": "k_euler_a",
            "n": 1,
            "seed": str(seed),
            "karras": True,
            "cfg_scale": 7,
        },
        "models": models,
        "nsfw": False,
        "censor_nsfw": True,
        "r2": True,
    }
    r = _req.post(
        "https://stablehorde.net/api/v2/generate/async",
        headers=headers, json=body, timeout=30,
    )
    if r.status_code not in (200, 202):
        raise RuntimeError(f"Horde submit {r.status_code}: {r.text[:300]}")

    job_id = r.json().get("id")
    if not job_id:
        raise RuntimeError("Horde returned no job ID")

    print(f"  [Horde] Job {job_id} submitted, polling...")

    # 2. Poll check endpoint until done (max 40 x 3s = 120s)
    for attempt in range(40):
        _time.sleep(3)
        check = _req.get(
            f"https://stablehorde.net/api/v2/generate/check/{job_id}",
            headers=headers, timeout=10,
        )
        if check.status_code != 200:
            raise RuntimeError(f"Horde check {check.status_code}")
        info = check.json()
        if info.get("faulted"):
            raise RuntimeError("Horde job faulted")
        if info.get("done"):
            break
        pos = info.get("queue_position", "?")
        if attempt % 5 == 0:
            print(f"  [Horde] Queue position: {pos}")
    else:
        raise RuntimeError("Horde timed out after 120s")

    # 3. Fetch result
    status = _req.get(
        f"https://stablehorde.net/api/v2/generate/status/{job_id}",
        headers=headers, timeout=15,
    )
    if status.status_code != 200:
        raise RuntimeError(f"Horde status {status.status_code}")

    generations = status.json().get("generations", [])
    if not generations:
        raise RuntimeError("Horde returned no generations")

    gen = generations[0]
    # r2=True means img is a URL, not base64
    img_url = gen.get("img", "")
    if img_url.startswith("http"):
        img_r = _req.get(img_url, timeout=30)
        img_r.raise_for_status()
        return img_r.content
    elif img_url:
        return _b64.b64decode(img_url)
    raise RuntimeError("Horde returned empty image")


@app.post("/api/horde-image")
async def horde_image_generate(req: HordeImageRequest):
    """Generate via Stable Horde (free community GPU pool).
    Returns 503 if no key is set or all providers fail — lets the
    frontend waterfall continue to Leonardo / Gemini / Pollinations.
    """
    if not req.prompt.strip():
        raise HTTPException(400, "prompt is empty")

    import base64

    horde_key = os.getenv("STABLE_HORDE_API_KEY", "").strip()
    models = HORDE_MODELS.get(req.style, HORDE_MODELS["default"])

    if not horde_key:
        # Signal to the frontend that Horde is not configured
        raise HTTPException(503, "STABLE_HORDE_API_KEY not set")

    try:
        raw = _call_stable_horde(req.prompt.strip(), horde_key, models, req.seed)
        b64 = base64.b64encode(raw).decode()
        mime = "image/png" if raw[:4] == b'\x89PNG' else "image/jpeg"
        print(f"  [OK] Stable Horde image style={req.style} models={models}")
        return JSONResponse({"dataUrl": f"data:{mime};base64,{b64}", "provider": f"horde/{req.style}"})
    except Exception as exc:
        print(f"  [WARN] Horde failed: {str(exc)[:120]}")
        # Return 503 so the frontend can fallback to Leonardo/Gemini
        raise HTTPException(503, f"Horde generation failed: {str(exc)[:200]}")



# ─────────────────────────────────────────────────────────────────────────────
# Leonardo AI Image Generation
# 150 free images/day forever on free tier. Best for anime + cinematic styles.
# Sign up at https://leonardo.ai -> User Settings -> API Access
# ─────────────────────────────────────────────────────────────────────────────

LEONARDO_MODELS = {
    "anime":     "e71a1c2f-4f80-4800-934f-2c68979d8cc8",  # Leonardo Anime XL
    "cinematic": "aa77f04e-3eec-4034-9c07-d0f619684628",  # Leonardo Kino XL
    "default":   "de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3",  # Leonardo Phoenix 1.0
    "flux":      "b2614463-296c-462a-9586-aafdb8f00e36",  # FLUX Dev (via Leonardo)
}

class LeonardoImageRequest(BaseModel):
    prompt: str
    seed: int = 42
    aspect_ratio: str = "16:9"
    style: str = "default"


def _call_leonardo(prompt: str, key: str, model_id: str, seed: int) -> bytes:
    """Call Leonardo AI REST API. Polls until complete (max 60s). Returns image bytes."""
    import requests as _req
    import time as _time

    headers = {
        "accept": "application/json",
        "content-type": "application/json",
        "authorization": f"Bearer {key}",
    }
    body = {
        "modelId": model_id,
        "prompt": prompt,
        "num_images": 1,
        "width": 1024,
        "height": 576,
        "seed": seed,
        "guidance_scale": 7,
    }
    r = _req.post(
        "https://cloud.leonardo.ai/api/rest/v1/generations",
        headers=headers, json=body, timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Leonardo submit {r.status_code}: {r.text[:300]}")

    gen_id = r.json()["sdGenerationJob"]["generationId"]

    for _ in range(20):
        _time.sleep(3)
        poll = _req.get(
            f"https://cloud.leonardo.ai/api/rest/v1/generations/{gen_id}",
            headers=headers, timeout=15,
        )
        if poll.status_code != 200:
            raise RuntimeError(f"Leonardo poll {poll.status_code}: {poll.text[:200]}")
        gen = poll.json().get("generations_by_pk", {})
        status = gen.get("status", "PENDING")
        if status == "COMPLETE":
            imgs = gen.get("generated_images", [])
            if not imgs:
                raise RuntimeError("Leonardo returned no images")
            img_r = _req.get(imgs[0]["url"], timeout=30)
            img_r.raise_for_status()
            return img_r.content
        elif status == "FAILED":
            raise RuntimeError("Leonardo generation failed")

    raise RuntimeError("Leonardo timed out after 60s")


@app.post("/api/leonardo-image")
async def leonardo_image_generate(req: LeonardoImageRequest):
    """Generate via Leonardo AI (150 free/day). Routes anime to Anime XL,
    cinematic to Kino XL, everything else to Phoenix 1.0.
    Falls back: FLUX -> Gemini -> Pollinations.
    """
    if not req.prompt.strip():
        raise HTTPException(400, "prompt is empty")

    import base64

    leo_key = os.getenv("LEONARDO_API_KEY", "").strip()
    if leo_key:
        model_id = LEONARDO_MODELS.get(req.style, LEONARDO_MODELS["default"])
        try:
            raw = _call_leonardo(req.prompt.strip(), leo_key, model_id, req.seed)
            b64 = base64.b64encode(raw).decode()
            mime = "image/png" if raw[:4] == b'\x89PNG' else "image/jpeg"
            print(f"  [OK] Leonardo image style={req.style}")
            return JSONResponse({"dataUrl": f"data:{mime};base64,{b64}", "provider": f"leonardo/{req.style}"})
        except Exception as exc:
            print(f"  [WARN] Leonardo failed: {str(exc)[:120]}")
    else:
        print("  [INFO] No LEONARDO_API_KEY — skipping Leonardo")

    # Fallback chain: FLUX -> Gemini -> Pollinations
    fal_key = os.getenv("FAL_API_KEY", "").strip()
    if fal_key:
        try:
            raw = _call_flux(req.prompt.strip(), fal_key, "schnell", req.seed)
            b64 = base64.b64encode(raw).decode()
            mime = "image/png" if raw[:4] == b'\x89PNG' else "image/jpeg"
            return JSONResponse({"dataUrl": f"data:{mime};base64,{b64}", "provider": "flux/schnell"})
        except Exception as exc:
            print(f"  [WARN] FLUX fallback: {str(exc)[:120]}")

    gemini_key = (os.getenv("GEMINI_IMAGE_KEY", "").strip() or os.getenv("GEMINI_API_KEY", "").strip())
    if gemini_key:
        try:
            raw = _call_gemini_image(req.prompt.strip(), gemini_key, "gemini-2.5-flash-image")
            b64 = base64.b64encode(raw).decode()
            mime = "image/png" if raw[:4] == b'\x89PNG' else "image/jpeg"
            return JSONResponse({"dataUrl": f"data:{mime};base64,{b64}", "provider": "gemini"})
        except Exception as exc:
            print(f"  [WARN] Gemini fallback: {str(exc)[:120]}")

    try:
        data = fetch_scene_image(req.prompt.strip(), req.seed, width=1024, height=576, mode="animated")
        b64 = base64.b64encode(data).decode()
        return JSONResponse({"dataUrl": f"data:image/jpeg;base64,{b64}", "provider": "fallback"})
    except Exception as exc:
        raise HTTPException(500, f"All image providers failed: {exc}")


# ─────────────────────────────────────────────────────────────────────────────
# Gemini Image Generation (documentary mode)
# Cascades through available image models; falls back to HF/Pollinations.
# ─────────────────────────────────────────────────────────────────────────────

class GeminiImageRequest(BaseModel):
    prompt: str
    seed: int = 42
    aspect_ratio: str = "16:9"
    mode: str = "documentary"

# Primary model (can be overridden via env); cascade tries these in order
GEMINI_IMAGE_MODEL = os.getenv("GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image")
GEMINI_IMAGE_MODEL_CASCADE = [
    GEMINI_IMAGE_MODEL,
    "gemini-2.5-flash-image",
    "gemini-2.0-flash-preview-image-generation",  # legacy fallback
]


# Mode-specific prompt prefixes for Gemini image generation.
# These are prepended to every prompt to steer the model's default style.
# Documentary uses aggressive photorealism guards because Gemini's image
# models default to illustrated/artistic styles without explicit instruction.
GEMINI_IMAGE_MODE_PREFIX: dict[str, str] = {
    "documentary": (
        "REAL PHOTOGRAPH ONLY. This must be a hyper-realistic, photographic image. "
        "Shoot as if taken by a professional nature or documentary photographer with a "
        "DSLR camera. National Geographic quality, BBC Earth style. "
        "NO illustration, NO painting, NO drawing, NO animation, NO cartoon, "
        "NO digital art, NO artistic style whatsoever. Pure photography. "
    ),
    "cinematic": (
        "Analog 35mm film photograph, cinematic still frame. "
        "High-contrast chiaroscuro lighting, photorealistic, film grain, "
        "moody noir atmosphere. NO illustration, NO animation, NO cartoon. "
    ),
    "animated": (
        "Anime illustration, Studio Ghibli style, 2D cel-shaded art. "
        "Vibrant colors, expressive characters, masterpiece anime artwork. "
        "NOT a photograph, NOT photorealistic. Pure anime illustration style. "
    ),
    "storybook": (
        "Children's picture book illustration. Soft watercolor painting, "
        "Beatrix Potter style, warm pastel colors, hand-painted look. "
        "Cozy and whimsical. NOT a photograph, NOT photorealistic. Pure illustration. "
    ),
}


def _call_gemini_image(prompt: str, key: str, model: str) -> bytes:
    """Call Gemini generateContent with responseModalities IMAGE.
    Returns raw image bytes. Raises RuntimeError on any failure.
    """
    import requests as _req
    import base64 as _b64

    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["IMAGE", "TEXT"],
            "temperature": 1.0,
        },
    }
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models"
        f"/{model}:generateContent"
    )
    r = _req.post(
        url,
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        json=body,
        timeout=90,   # image generation can take 20-60s
    )
    if r.status_code != 200:
        raise RuntimeError(f"Gemini {r.status_code} ({model}): {r.text[:300]}")

    data = r.json()
    for candidate in data.get("candidates", []):
        for part in candidate.get("content", {}).get("parts", []):
            if "inlineData" in part:
                return _b64.b64decode(part["inlineData"]["data"])
    raise RuntimeError(f"No image data in response (model={model})")


@app.post("/api/gemini-image")
async def gemini_image_generate(req: GeminiImageRequest):
    """Generate an image via Gemini's image model.

    Applies a mode-specific prompt prefix to enforce style:
    - documentary → hard photorealism guard (NO illustration)
    - cinematic   → analog film photography
    - animated    → anime/Studio Ghibli illustration
    - storybook   → watercolor children's book illustration

    Key resolution: GEMINI_IMAGE_KEY preferred; falls back to GEMINI_API_KEY.
    Model cascade: tries GEMINI_IMAGE_MODEL_CASCADE in order.
    Final fallback: HF/Pollinations pipeline.
    """
    if not req.prompt.strip():
        raise HTTPException(400, "prompt is empty")

    import base64

    gemini_key = (
        os.getenv("GEMINI_IMAGE_KEY", "").strip()
        or os.getenv("GEMINI_API_KEY", "").strip()
    )

    # Prepend mode-specific style prefix to steer Gemini's output
    mode_prefix = GEMINI_IMAGE_MODE_PREFIX.get(req.mode, "")
    final_prompt = f"{mode_prefix}{req.prompt.strip()}"
    print(f"  [Gemini Image] mode={req.mode} prompt_preview={final_prompt[:120]}...")

    if gemini_key:
        for model in GEMINI_IMAGE_MODEL_CASCADE:
            try:
                raw = _call_gemini_image(final_prompt, gemini_key, model)
                b64 = base64.b64encode(raw).decode()
                mime = "image/png" if raw[:4] == b'\x89PNG' else "image/jpeg"
                print(f"  [OK] Gemini image via {model} (mode={req.mode})")
                return JSONResponse({"dataUrl": f"data:{mime};base64,{b64}", "provider": f"gemini/{model}"})
            except Exception as exc:
                msg = str(exc)
                if "401" in msg or "UNAUTHENTICATED" in msg:
                    print(
                        f"  [WARN] {model}: 401 — key may be browser-restricted. "
                        "Add GEMINI_IMAGE_KEY=AIza... to .env"
                    )
                    break   # no point trying other models with same key
                elif "429" in msg:
                    print(f"  [WARN] {model}: quota exceeded, trying next model")
                else:
                    print(f"  [WARN] {model}: {msg[:120]}")
    else:
        print("  [INFO] No Gemini key — using HF/Pollinations for images")

    # Final fallback
    try:
        data = fetch_scene_image(req.prompt.strip(), req.seed, width=1024, height=576, mode=req.mode)
        b64 = base64.b64encode(data).decode()
        return JSONResponse({"dataUrl": f"data:image/jpeg;base64,{b64}", "provider": "fallback"})
    except Exception as exc:
        raise HTTPException(500, f"All image providers failed: {exc}")

# ─────────────────────────────────────────────────────────────────────────────
# Veo Video Generation
# Uses the same GEMINI_API_KEY / GEMINI_IMAGE_KEY from env.
# Generates 10-second (default) video clips via Gemini's Veo 3 model.
# ─────────────────────────────────────────────────────────────────────────────

VEO_MODEL_DEFAULT = os.getenv("VEO_MODEL", "veo-3.0-generate-preview")
VEO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

class VeoRequest(BaseModel):
    prompt: str
    duration_seconds: int = 30   # up to 30 seconds
    aspect_ratio: str = "16:9"   # "16:9" or "9:16"


def _submit_veo_job(prompt: str, key: str, model: str, duration: int, aspect: str) -> str:
    """Submit a Veo generation job. Returns the operation name."""
    import requests as _req

    # Clamp duration to supported range
    duration = max(5, min(duration, 30))

    url = f"{VEO_BASE_URL}/models/{model}:predictLongRunning"
    body = {
        "instances": [{
            "prompt": prompt,
        }],
        "parameters": {
            "durationSeconds": duration,
            "aspectRatio": aspect,
            "sampleCount": 1,
        },
    }

    r = _req.post(
        url,
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        json=body,
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Veo submit {r.status_code}: {r.text[:400]}")

    data = r.json()
    op_name = data.get("name")
    if not op_name:
        raise RuntimeError(f"Veo: no operation name in response: {data}")
    return op_name


def _poll_veo_job(op_name: str, key: str, timeout_s: int = 360) -> bytes:
    """Poll Veo operation until done. Returns raw video bytes."""
    import requests as _req
    import base64 as _b64
    import time as _time

    url = f"{VEO_BASE_URL}/{op_name}"
    deadline = _time.time() + timeout_s
    poll_interval = 15  # seconds between polls

    while _time.time() < deadline:
        _time.sleep(poll_interval)
        r = _req.get(
            url,
            headers={"x-goog-api-key": key},
            timeout=30,
        )
        if r.status_code != 200:
            raise RuntimeError(f"Veo poll {r.status_code}: {r.text[:300]}")

        data = r.json()
        done = data.get("done", False)
        print(f"  [Veo] Polling {op_name[-20:]}: done={done}")

        if done:
            # Extract video bytes from response
            response = data.get("response", {})
            generated = response.get("generatedSamples") or response.get("generated_videos", [])

            # Try generatedSamples path (Vertex-style)
            if generated:
                sample = generated[0]
                video = sample.get("video", sample.get("videoUri", sample))
                if isinstance(video, dict):
                    b64 = video.get("bytesBase64Encoded", "")
                    if b64:
                        return _b64.b64decode(b64)
                    uri = video.get("uri", "")
                    if uri.startswith("http"):
                        vr = _req.get(uri, timeout=60)
                        vr.raise_for_status()
                        return vr.content
                elif isinstance(video, str):
                    if video.startswith("http"):
                        vr = _req.get(video, timeout=60)
                        vr.raise_for_status()
                        return vr.content
                    # Possibly base64
                    try:
                        return _b64.b64decode(video)
                    except Exception:
                        pass

            # Fallback: try direct bytes in response
            if "videoBytes" in response:
                return _b64.b64decode(response["videoBytes"])

            raise RuntimeError(f"Veo done but no video data found: {str(data)[:400]}")

        # Check for error state
        error = data.get("error")
        if error:
            raise RuntimeError(f"Veo job failed: {error.get('message', str(error))}")

    raise RuntimeError(f"Veo timed out after {timeout_s}s")


@app.post("/api/veo")
async def veo_generate(req: VeoRequest):
    """Generate a short video clip via Google Veo 3.

    Uses GEMINI_IMAGE_KEY preferred, falls back to GEMINI_API_KEY.
    Returns {dataUrl, provider, durationSeconds} on success.
    Returns 503 if no key is set.
    """
    if not req.prompt.strip():
        raise HTTPException(400, "prompt is empty")

    gemini_key = (
        os.getenv("GEMINI_IMAGE_KEY", "").strip()
        or os.getenv("GEMINI_API_KEY", "").strip()
    )
    if not gemini_key:
        raise HTTPException(503, "No Gemini API key set (GEMINI_API_KEY or GEMINI_IMAGE_KEY required for Veo)")

    model = os.getenv("VEO_MODEL", VEO_MODEL_DEFAULT)
    duration = max(5, min(req.duration_seconds, 10))

    print(f"  [Veo] Generating {duration}s video: {req.prompt[:80]}...")

    import base64
    try:
        op_name = _submit_veo_job(req.prompt.strip(), gemini_key, model, duration, req.aspect_ratio)
        print(f"  [Veo] Operation: {op_name}")
        video_bytes = _poll_veo_job(op_name, gemini_key)
        b64 = base64.b64encode(video_bytes).decode()
        print(f"  [OK] Veo video generated ({len(video_bytes)} bytes)")
        return JSONResponse({
            "dataUrl": f"data:video/mp4;base64,{b64}",
            "provider": f"veo/{model}",
            "durationSeconds": duration,
        })
    except Exception as exc:
        msg = str(exc)
        print(f"  [ERROR] Veo failed: {msg}")
        raise HTTPException(500, f"Veo generation failed: {msg[:400]}")


# ─────────────────────────────────────────────────────────────────────────────
# TTS endpoint — synthesise one scene's narration
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/tts", response_model=TTSResponse)
async def tts(req: TTSRequest):
    if not req.text.strip():
        raise HTTPException(400, "text is empty")

    # Storytelling narrator: warm voice, slightly slower for narration pacing.
    # Override per request (req.voice) or via env. Good options:
    #   en-US-JennyNeural (warm US female)   en-US-AnaNeural (child-like, kids' stories)
    #   en-GB-SoniaNeural (British)          en-IN-NeerjaNeural (Indian English)
    #   hi-IN-SwaraNeural / hi-IN-MadhurNeural (Hindi)
    voice = (req.voice or os.getenv("TTS_VOICE", "en-US-JennyNeural")).strip()
    rate = (req.rate or os.getenv("TTS_RATE", "-8%")).strip()
    pitch = (req.pitch or os.getenv("TTS_PITCH", "+0Hz")).strip()

    text_hash = hashlib.md5(f"{req.text}_{voice}_{rate}_{pitch}".encode()).hexdigest()[:12]
    fname = f"scene_{req.scene_number}_{text_hash}.mp3"
    dest = TTS_DIR / fname

    if not dest.exists():
        try:
            import asyncio
            from compiler import _generate_tts
            # _generate_tts is synchronous and uses requests, so run it in a thread
            result = await asyncio.to_thread(_generate_tts, req.text.strip(), dest, req.lang)
            if not result or not dest.exists():
                raise HTTPException(500, "TTS generation returned empty")
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
# Frontend Static Files (Fallback)
# ─────────────────────────────────────────────────────────────────────────────
# Serve built frontend — MUST be last so all /api/* routes are registered first.
# Docker: Dockerfile copies frontend/dist -> /app/frontend_dist/
_FRONTEND_DIST = Path(__file__).parent.parent / "frontend_dist"   # Docker path
_FRONTEND_DIST_DEV = Path(__file__).parent.parent / "frontend" / "dist"  # legacy

_dist = _FRONTEND_DIST if _FRONTEND_DIST.exists() else (_FRONTEND_DIST_DEV if _FRONTEND_DIST_DEV.exists() else None)
if _dist:
    print(f"  [INFO] Serving frontend from {_dist}")
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
