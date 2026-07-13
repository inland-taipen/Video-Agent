"""
image_gen.py — Free-tier image generation with fallbacks.

Tries (in order):
1. Pollinations gen API (optional POLLINATIONS_API_KEY — free at enter.pollinations.ai)
2. Pollinations legacy image API (rate-limited; sequential requests with backoff)
3. Hugging Face Inference (optional HF_TOKEN — free tier at huggingface.co)
4. Local placeholder JPEG
"""
from __future__ import annotations

import hashlib
import io
import os
import threading
import time
import urllib.parse
from pathlib import Path
from typing import List, Literal

import requests

IMAGE_CACHE_DIR = Path(os.getenv("IMAGE_CACHE_DIR", "outputs/images"))
IMAGE_CACHE_DIR.mkdir(parents=True, exist_ok=True)

W, H = 1024, 576
IMAGE_TIMEOUT = 120

_poll_lock = threading.Lock()
_last_pollination_request = 0.0

GenerationMode = Literal["animated", "documentary"]


def _rate_limit_pollinations(has_key: bool) -> None:
    global _last_pollination_request
    min_interval = 4 if has_key else 16
    with _poll_lock:
        elapsed = time.time() - _last_pollination_request
        if elapsed < min_interval:
            time.sleep(min_interval - elapsed)
        _last_pollination_request = time.time()


# ── Style guards ─────────────────────────────────────────────────────────────
# Each guard is injected into EVERY image prompt regardless of provider.
# This ensures visual consistency and content safety across the pipeline.

_ANIMATED_PREFIX = os.getenv(
    "IMAGE_STYLE_PREFIX",
    "high quality anime, studio ghibli style, vibrant colors, beautifully drawn, family-friendly, ",
)
_ANIMATED_SUFFIX = os.getenv(
    "IMAGE_STYLE_SUFFIX",
    ", no text, no watermark, no gore, no weapons, no horror, safe for children",
)

_DOCUMENTARY_PREFIX = (
    "photorealistic, professional nature photography, BBC Earth style, "
    "National Geographic quality, ultra detailed, natural lighting, "
)
_DOCUMENTARY_SUFFIX = (
    ", 8K, cinematic, no text, no watermark, no gore, no violence, "
    "no horror, safe for all audiences, beautiful, educational"
)

_STORYBOOK_PREFIX = (
    "children's storybook illustration, soft watercolor painting, Beatrix Potter style, "
    "warm pastel colors, hand-painted, cozy and whimsical, gentle illustration, "
)
_STORYBOOK_SUFFIX = (
    ", family-friendly, soft warm light, beautifully illustrated, "
    "no text, no watermark, no violence, no horror, safe for all ages"
)

# Legacy alias kept for backwards compatibility (env override still works)
STYLE_GUARD_PREFIX = _ANIMATED_PREFIX
STYLE_GUARD_SUFFIX = _ANIMATED_SUFFIX


def _guarded(prompt: str, mode: GenerationMode = "animated") -> str:
    """Wrap prompt with mode-appropriate style tokens and safety filters."""
    if mode == "documentary":
        return f"{_DOCUMENTARY_PREFIX}{prompt}{_DOCUMENTARY_SUFFIX}"
    if mode == "storybook":
        return f"{_STORYBOOK_PREFIX}{prompt}{_STORYBOOK_SUFFIX}"
    return f"{_ANIMATED_PREFIX}{prompt}{_ANIMATED_SUFFIX}"


def _pollinations_urls(prompt: str, seed: int, width: int, height: int, api_key: str) -> List[str]:
    encoded = urllib.parse.quote(prompt, safe="")
    urls: List[str] = []
    if api_key:
        urls.append(
            f"https://gen.pollinations.ai/image/{encoded}"
            f"?width={width}&height={height}&seed={seed}&nologo=true&safe=true&key={api_key}"
        )
    # enhance=true removed: Pollinations' prompt rewriter drifts content off-style.
    # safe=true enables their strict NSFW filter (returns an error instead of an image).
    urls.append(
        f"https://image.pollinations.ai/prompt/{encoded}"
        f"?width={width}&height={height}&seed={seed}&nologo=true&safe=true&model=flux"
    )
    return urls


def _try_pollinations(prompt: str, seed: int, width: int, height: int) -> bytes | None:
    api_key = os.getenv("POLLINATIONS_API_KEY", "").strip()
    for url in _pollinations_urls(prompt, seed, width, height, api_key):
        _rate_limit_pollinations(bool(api_key))
        try:
            r = requests.get(url, timeout=IMAGE_TIMEOUT)
            content_type = r.headers.get("content-type", "")
            if r.status_code == 200 and content_type.startswith("image"):
                return r.content
            print(f"  [WARN] Pollinations {r.status_code}: {r.text[:200]}")
        except Exception as exc:
            print(f"  [WARN] Pollinations request failed: {exc}")
    return None


def _try_huggingface(prompt: str, width: int, height: int) -> bytes | None:
    token = os.getenv("HF_TOKEN", "").strip()
    if not token:
        return None
    try:
        r = requests.post(
            "https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell",
            headers={"Authorization": f"Bearer {token}"},
            json={"inputs": prompt, "parameters": {"width": width, "height": height}},
            timeout=IMAGE_TIMEOUT,
        )
        if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
            return r.content
        print(f"  [WARN] HuggingFace {r.status_code}: {r.text[:200]}")
    except Exception as exc:
        print(f"  [WARN] HuggingFace request failed: {exc}")
    return None


def _placeholder_bytes(seed: int, width: int, height: int) -> bytes:
    try:
        from PIL import Image, ImageDraw

        hue = (seed * 37) % 360
        img = Image.new("RGB", (width, height), color=(15, 15, 25))
        draw = ImageDraw.Draw(img)
        for i in range(0, width, 40):
            shade = int(30 + (i / width) * 40)
            draw.line([(i, 0), (i, height)], fill=(shade, shade, shade + 20), width=1)
        draw.text((24, height // 2 - 10), f"Scene placeholder (seed {seed})", fill=(180, 180, 200))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        return buf.getvalue()
    except Exception:
        # Minimal valid JPEG header fallback
        return (
            b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
            b"\xff\xd9"
        )


def fetch_scene_image(
    prompt: str,
    seed: int,
    width: int = W,
    height: int = H,
    mode: GenerationMode = "animated",
) -> bytes:
    """Fetch or generate a scene image.

    Args:
        prompt: Raw image prompt from the Prompt Compiler.
        seed:   Deterministic seed for reproducibility.
        width:  Output width in pixels.
        height: Output height in pixels.
        mode:   'animated' (anime guard) or 'documentary' (photorealistic guard).
    """
    prompt = _guarded(prompt, mode)
    cache_key = hashlib.sha256(f"{prompt}|{seed}|{width}|{height}".encode()).hexdigest()[:20]
    cache_path = IMAGE_CACHE_DIR / f"{cache_key}.jpg"
    if cache_path.exists() and cache_path.stat().st_size > 500:
        return cache_path.read_bytes()

    data = _try_pollinations(prompt, seed, width, height)
    if data is None:
        data = _try_huggingface(prompt, width, height)
    if data is None:
        print(f"  [WARN] All image providers failed for seed {seed} — using placeholder")
        data = _placeholder_bytes(seed, width, height)

    cache_path.write_bytes(data)
    return data

