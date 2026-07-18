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
import time
from pathlib import Path
from typing import Literal

GenerationMode = Literal["animated", "documentary", "storybook", "cinematic"]

import requests

IMAGE_CACHE_DIR = Path(os.getenv("IMAGE_CACHE_DIR", "outputs/images"))
IMAGE_CACHE_DIR.mkdir(parents=True, exist_ok=True)

W, H = 1024, 576
IMAGE_TIMEOUT = 120



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

# Anime style suffixes optimized for FLUX
FLUX_STYLE_PROMPTS: dict[str, str] = {
    "anime":          "anime style, cel shaded, vibrant colors, Studio Ghibli, expressive characters, beautiful backgrounds, masterpiece",
    "realistic_anime": "hyper-realistic anime, Makoto Shinkai quality, ultra-detailed, photorealistic textures, cinematic lighting, 8K, masterpiece",
    "cinematic":      "cinematic photography, dramatic lighting, shallow depth of field, film grain, anamorphic lens",
    "documentary":    "documentary photography, BBC Earth style, natural lighting, National Geographic quality, photorealistic",
    "fantasy":        "epic fantasy concept art, magical lighting, highly detailed, artstation quality, dramatic",
    "noir":           "film noir, high contrast black and white, dramatic shadows, rain-slicked streets, moody",
    "default":        "high quality, detailed, beautiful, 8K",
}

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

# M87 — analog film LoRA (apache-2.0)
# Backed by the HF Inference API; requires HF_TOKEN.
M87_MODEL = "mgwr/M87"

_M87_PREFIX = (
    "analog film photography, 35mm film grain, high contrast, chiaroscuro lighting, "
    "dramatic shadows, moody atmosphere, cinematic composition, photorealistic, "
)
_M87_SUFFIX = (
    ", shallow depth of field, desaturated color grading, no text, no watermark"
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
    if mode == "cinematic":
        return f"{_M87_PREFIX}{prompt}{_M87_SUFFIX}"
    return f"{_ANIMATED_PREFIX}{prompt}{_ANIMATED_SUFFIX}"



def _try_huggingface(prompt: str, width: int, height: int, model: str = "krea/Krea-2-Turbo") -> bytes | None:
    token = os.getenv("HF_TOKEN", "").strip()
    if not token:
        return None
    try:
        r = requests.post(
            f"https://router.huggingface.co/hf-inference/models/{model}",
            headers={"Authorization": f"Bearer {token}"},
            json={"inputs": prompt, "parameters": {"width": width, "height": height}},
            timeout=IMAGE_TIMEOUT,
        )
        if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
            return r.content
        print(f"  [WARN] HuggingFace/{model} {r.status_code}: {r.text[:200]}")
    except Exception as exc:
        print(f"  [WARN] HuggingFace request failed: {exc}")
    return None


def _try_m87(prompt: str, width: int, height: int) -> bytes | None:
    """Generate via M87 analog film LoRA on HF Inference. Falls back to None."""
    result = _try_huggingface(prompt, width, height, model=M87_MODEL)
    if result:
        print(f"  [OK] M87 cinematic image generated ({len(result)} bytes)")
    return result


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


def _try_pollinations(prompt: str, seed: int, width: int, height: int) -> bytes | None:
    """Generate via Pollinations gen API — free, no key needed, fast.

    Model is configurable via POLLINATIONS_MODEL env var.
    Defaults to nanobanana-2 (fast, high quality).
    """
    import urllib.parse
    model = os.getenv("POLLINATIONS_MODEL", "nanobanana-2")
    encoded = urllib.parse.quote(prompt)
    url = (
        f"https://image.pollinations.ai/prompt/{encoded}"
        f"?model={model}&width={width}&height={height}&seed={seed}&nologo=true"
    )
    try:
        r = requests.get(url, timeout=IMAGE_TIMEOUT)
        if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
            print(f"  [OK] Pollinations/{model} image generated ({len(r.content)} bytes)")
            return r.content
        print(f"  [WARN] Pollinations/{model} {r.status_code}: {r.text[:200]}")
    except Exception as exc:
        print(f"  [WARN] Pollinations request failed: {exc}")
    return None


def _try_bfl(prompt: str, width: int, height: int) -> bytes | None:
    """Generate via Black Forest Labs official FLUX API (flux-dev model).

    Submits a job, polls for Ready status, downloads the image URL.
    Requires BFL_API_KEY in environment.
    """
    api_key = os.getenv("BFL_API_KEY", "").strip()
    if not api_key:
        return None
    try:
        headers = {
            "accept": "application/json",
            "x-key": api_key,
            "Content-Type": "application/json",
        }
        # Submit generation request using flux-dev (cheapest tier)
        resp = requests.post(
            "https://api.bfl.ai/v1/flux-dev",
            headers=headers,
            json={"prompt": prompt, "width": width, "height": height},
            timeout=30,
        )
        if resp.status_code != 200:
            print(f"  [WARN] BFL submit {resp.status_code}: {resp.text[:200]}")
            return None

        data = resp.json()
        polling_url = data.get("polling_url")
        if not polling_url:
            print(f"  [WARN] BFL: no polling_url in response: {data}")
            return None

        # Poll until Ready
        deadline = time.time() + IMAGE_TIMEOUT
        while time.time() < deadline:
            time.sleep(1.5)
            poll = requests.get(polling_url, headers=headers, timeout=15).json()
            status = poll.get("status", "")
            if status == "Ready":
                img_url = poll.get("result", {}).get("sample")
                if not img_url:
                    print(f"  [WARN] BFL Ready but no sample URL")
                    return None
                img_resp = requests.get(img_url, timeout=30)
                if img_resp.status_code == 200:
                    print(f"  [OK] BFL FLUX image generated ({len(img_resp.content)} bytes)")
                    return img_resp.content
            elif status in ("Error", "Failed"):
                print(f"  [WARN] BFL generation failed: {poll}")
                return None
        print("  [WARN] BFL timed out")
    except Exception as exc:
        print(f"  [WARN] BFL request failed: {exc}")
    return None


def fetch_scene_image(
    prompt: str,
    seed: int,
    width: int = W,
    height: int = H,
    mode: GenerationMode = "animated",
) -> bytes:
    """Fetch or generate a scene image.

    Routes by mode:
      - 'cinematic'   → Pollinations FLUX (primary) → M87 HF (fallback)
      - 'animated'    → Pollinations FLUX (primary) → Krea-2-Turbo HF (fallback)
      - 'documentary' → Pollinations FLUX (primary) → Krea-2-Turbo HF (fallback)
      - 'storybook'   → Pollinations FLUX (primary) → Krea-2-Turbo HF (fallback)

    Args:
        prompt: Raw image prompt from the Prompt Compiler.
        seed:   Deterministic seed for reproducibility.
        width:  Output width in pixels.
        height: Output height in pixels.
        mode:   Generation mode (controls style guards).
    """
    prompt = _guarded(prompt, mode)
    cache_key = hashlib.sha256(f"{prompt}|{seed}|{width}|{height}".encode()).hexdigest()[:20]
    cache_path = IMAGE_CACHE_DIR / f"{cache_key}.jpg"
    if cache_path.exists() and cache_path.stat().st_size > 500:
        return cache_path.read_bytes()

    # Primary: BFL official FLUX API (if key configured)
    data = _try_bfl(prompt, width, height)

    # Fallback: Pollinations FLUX — free, no key, always available
    if data is None:
        data = _try_pollinations(prompt, seed, width, height)

    if data is None:
        print(f"  [WARN] All providers failed for seed {seed} — using placeholder")
        data = _placeholder_bytes(seed, width, height)

    cache_path.write_bytes(data)
    return data

