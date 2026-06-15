#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
beta_story2vid.py – Story-to-Storyboard Video Pipeline
Uses Gemini REST API (auto-discovers available model) + Pollinations.ai + FFmpeg
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
import urllib.parse
from pathlib import Path
from typing import List, Optional

import requests

# ---------------------------------------------------------------------------
# Load environment variables from .env file
# ---------------------------------------------------------------------------
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv not installed – rely on environment variables

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
POLLINATIONS_URL = (
    "https://image.pollinations.ai/prompt/{prompt}"
    "?width=1024&height=576&seed={seed}&nologo=true"
)
DEFAULT_SEED = 42
IMAGE_TIMEOUT_SECONDS = 60

# ---------------------------------------------------------------------------
# Model discovery – finds first working Gemini model for your API key
# ---------------------------------------------------------------------------
def get_available_model(api_key: str) -> str:
    """
    Query Gemini API for available models and return the first one that supports generateContent.
    Returns full model name (e.g., "models/gemini-2.0-flash").
    """
    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        models = response.json()
        for model in models.get("models", []):
            if "generateContent" in model.get("supportedGenerationMethods", []):
                model_name = model["name"]  # e.g., "models/gemini-2.0-flash"
                print(f"  ✓ Auto-selected model: {model_name}")
                return model_name
    except Exception as e:
        print(f"  [WARN] Could not fetch model list: {e}")

    # Fallback – try common model names
    fallbacks = [
        "models/gemini-2.0-flash",
        "models/gemini-1.5-flash",
        "gemini-2.0-flash",
        "gemini-1.5-flash",
    ]
    for fb in fallbacks:
        print(f"  [WARN] Using fallback model: {fb}")
        return fb

    raise RuntimeError("No Gemini model available – check your API key and internet connection.")


# ---------------------------------------------------------------------------
# Scene schema and prompts
# ---------------------------------------------------------------------------
SCENE_SCHEMA_DESCRIPTION = """
Return ONLY a valid JSON array (no markdown, no prose) where each element has:
{
  "scene_number": <integer starting at 1>,
  "setting": "<INT/EXT. LOCATION - TIME>",
  "narration": "<voiceover text for this scene>",
  "dialogue": [{"speaker": "<name>", "line": "<spoken text>"}],
  "transition": "<FADE IN | CUT TO | CROSSFADE>",
  "visual_description": "<concrete, camera-level description of what is visible>"
}
"""

INITIAL_PROMPT_TEMPLATE = """\
You are a professional screenwriter. Break the following story into 4-8 cinematic scenes.
{schema}

Story:
\"\"\"
{story}
\"\"\"
"""

RETRY_PROMPT_TEMPLATE = """\
Your previous response was not valid JSON. Return ONLY the JSON array, with absolutely no
surrounding text, no markdown code fences, and no explanation.
{schema}

Story:
\"\"\"
{story}
\"\"\"
"""

# ---------------------------------------------------------------------------
# Gemini REST API call (uses auto-discovered model)
# ---------------------------------------------------------------------------
def call_gemini_rest(story: str, api_key: str, model_name: str, retry: bool = False) -> str:
    """Call Gemini via REST API and return raw text response."""
    template = RETRY_PROMPT_TEMPLATE if retry else INITIAL_PROMPT_TEMPLATE
    prompt = template.format(schema=SCENE_SCHEMA_DESCRIPTION, story=story)

    payload = {
        "contents": [{
            "parts": [{"text": prompt}]
        }],
        "generationConfig": {
            "temperature": 0.0,
            "topP": 0.95,
            "topK": 40
        }
    }

    # Construct URL: https://generativelanguage.googleapis.com/v1beta/{model_name}:generateContent?key=...
    url = f"https://generativelanguage.googleapis.com/v1beta/{model_name}:generateContent?key={api_key}"
    headers = {"Content-Type": "application/json"}

    print(f"  → Calling Gemini {model_name}{' [RETRY]' if retry else ''}…")
    response = requests.post(url, json=payload, headers=headers, timeout=30)
    response.raise_for_status()

    data = response.json()
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        return text
    except (KeyError, IndexError) as e:
        raise RuntimeError(f"Unexpected Gemini response format: {data}") from e

# ---------------------------------------------------------------------------
# Extract JSON from text
# ---------------------------------------------------------------------------
def extract_json_array(text: str) -> Optional[List]:
    cleaned = re.sub(r"```(?:json)?", "", text, flags=re.IGNORECASE).strip()
    cleaned = cleaned.replace("```", "").strip()
    try:
        data = json.loads(cleaned)
        if isinstance(data, list):
            return data
    except json.JSONDecodeError:
        pass

    match = re.search(r"\[.*\]", cleaned, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group(0))
            if isinstance(data, list):
                return data
        except json.JSONDecodeError:
            pass
    return None

# ---------------------------------------------------------------------------
# Story to scenes
# ---------------------------------------------------------------------------
def story_to_scenes(story: str, api_key: str, model_name: str) -> List[dict]:
    """Convert story to list of scene dicts using Gemini REST API."""
    raw_text = call_gemini_rest(story, api_key, model_name, retry=False)
    scenes_raw = extract_json_array(raw_text)

    if scenes_raw is None:
        print("  [WARN] Invalid JSON from Gemini – retrying with stricter prompt…")
        raw_text = call_gemini_rest(story, api_key, model_name, retry=True)
        scenes_raw = extract_json_array(raw_text)

    if scenes_raw is None:
        raise RuntimeError(
            "Gemini returned invalid JSON twice. Raw response:\n" + raw_text[:500]
        )

    scenes = []
    for raw in scenes_raw:
        scenes.append({
            "scene_number": int(raw.get("scene_number", 0)),
            "setting": str(raw.get("setting", "EXT. UNKNOWN - DAY")),
            "narration": str(raw.get("narration", "")),
            "dialogue": raw.get("dialogue", []),
            "transition": str(raw.get("transition", "CUT TO")),
            "visual_description": str(raw.get("visual_description", "")),
        })
    print(f"  ✓ {len(scenes)} scenes parsed.")
    return scenes

# ---------------------------------------------------------------------------
# Image generation (Pollinations.ai)
# ---------------------------------------------------------------------------
def build_image_url(visual_description: str, seed: int) -> str:
    encoded = urllib.parse.quote(visual_description, safe="")
    return POLLINATIONS_URL.format(prompt=encoded, seed=seed)

def download_image(url: str, dest_path: Path, scene_number: int) -> Path:
    try:
        print(f"  → Fetching image for scene {scene_number}…")
        response = requests.get(url, timeout=IMAGE_TIMEOUT_SECONDS, stream=True)
        response.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
        size_kb = dest_path.stat().st_size // 1024
        print(f"  ✓ Scene {scene_number} image saved ({size_kb} KB).")
        return dest_path
    except Exception as exc:
        print(f"  [WARN] Image download failed for scene {scene_number}: {exc}")
        return _create_fallback_image(dest_path, scene_number)

def _create_fallback_image(dest_path: Path, scene_number: int) -> Path:
    try:
        from PIL import Image, ImageDraw, ImageFont
        img = Image.new("RGB", (1024, 576), color=(20, 20, 30))
        draw = ImageDraw.Draw(img)
        label = f"Scene {scene_number}\n[Image unavailable]"
        try:
            font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 48)
        except Exception:
            font = ImageFont.load_default()
        draw.text((512, 288), label, fill=(200, 200, 200), font=font, anchor="mm")
        img.save(dest_path, "JPEG")
        print(f"  ✓ Fallback image created for scene {scene_number} (Pillow).")
    except ImportError:
        # Minimal dark JPEG (1x1 black pixel)
        MINIMAL_JPEG = bytes([
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,
            0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB,
            0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07,
            0x07, 0x07, 0x09, 0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B,
            0x0B, 0x0C, 0x19, 0x12, 0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E,
            0x1D, 0x1A, 0x1C, 0x1C, 0x20, 0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C,
            0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29, 0x2C, 0x30, 0x31, 0x34, 0x34,
            0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32, 0x3C, 0x2E, 0x33, 0x34,
            0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01,
            0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00, 0x01, 0x05,
            0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
            0x09, 0x0A, 0x0B, 0xFF, 0xC4, 0x00, 0xB5, 0x10, 0x00, 0x02, 0x01,
            0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00,
            0x01, 0x7D, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21,
            0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32,
            0x81, 0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1,
            0xF0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18,
            0x19, 0x1A, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x34, 0x35, 0x36,
            0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
            0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64,
            0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77,
            0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8A,
            0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3,
            0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5,
            0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7,
            0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9,
            0xDA, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA,
            0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFF,
            0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xFB, 0xD3,
            0xFF, 0xD9,
        ])
        with open(dest_path, "wb") as f:
            f.write(MINIMAL_JPEG)
        print(f"  ✓ Minimal fallback image created for scene {scene_number}.")
    return dest_path

def generate_images(scenes: List[dict], output_dir: Path, global_seed: int) -> List[Path]:
    image_paths = []
    for scene in scenes:
        n = scene["scene_number"]
        seed = global_seed + n
        url = build_image_url(scene["visual_description"], seed)
        dest = output_dir / f"scene_{n:03d}.jpg"
        path = download_image(url, dest, n)
        image_paths.append(path)
    return image_paths

# ---------------------------------------------------------------------------
# FFmpeg video compilation
# ---------------------------------------------------------------------------
def check_ffmpeg() -> str:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path:
        return ffmpeg_path
    print("\n[ERROR] FFmpeg not found.\n")
    sys.exit(1)

def compute_duration(scene: dict) -> int:
    return 4 if scene.get("dialogue") else 2

def compile_video(scenes, image_paths, output_path, ffmpeg_bin):
    inputs = []
    filter_parts = []
    stream_labels = []
    for idx, (scene, img_path) in enumerate(zip(scenes, image_paths)):
        duration = compute_duration(scene)
        inputs += ["-loop", "1", "-t", str(duration), "-i", str(img_path)]
        label = f"v{idx}"
        filter_parts.append(
            f"[{idx}:v]"
            f"scale=1024:576:force_original_aspect_ratio=decrease,"
            f"pad=1024:576:(ow-iw)/2:(oh-ih)/2:color=black,"
            f"setsar=1[{label}]"
        )
        stream_labels.append(f"[{label}]")
    n = len(scenes)
    concat_filter = "".join(filter_parts) + "".join(stream_labels) + f"concat=n={n}:v=1:a=0[outv]"
    cmd = [ffmpeg_bin, "-y"] + inputs + [
        "-filter_complex", concat_filter,
        "-map", "[outv]",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-crf", "23",
        "-preset", "fast",
        "-movflags", "+faststart",
        str(output_path)
    ]
    print("\n  → Running FFmpeg...")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg failed: {result.stderr[-500:]}")
    size_mb = output_path.stat().st_size / (1024*1024)
    print(f"  ✓ Video compiled: {output_path} ({size_mb:.2f} MB)")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def print_banner():
    print(r"""
  ╔══════════════════════════════════════════════════════╗
  ║         STORY → STORYBOARD VIDEO  (beta)            ║
  ║   Gemini REST API  ×  Pollinations.ai  ×  FFmpeg    ║
  ╚══════════════════════════════════════════════════════╝
    """)

def print_scene_summary(scenes):
    print("\n── Scene Breakdown ─────────────────────────────────")
    for s in scenes:
        n = s["scene_number"]
        setting = s["setting"]
        transition = s["transition"]
        has_dialogue = "🗣 " if s["dialogue"] else "   "
        dur = compute_duration(s)
        print(f"  {n:2d}. [{transition:10s}] {has_dialogue}{setting}  ({dur}s)")
    print("────────────────────────────────────────────────────\n")

def read_story_from_stdin() -> str:
    print("Paste or type your story below.")
    print("When done, press Ctrl+D (macOS/Linux) or Ctrl+Z+Enter (Windows).\n")
    print("─" * 60)
    lines = []
    try:
        while True:
            lines.append(input())
    except EOFError:
        pass
    story = "\n".join(lines).strip()
    print("─" * 60)
    return story

def parse_args():
    parser = argparse.ArgumentParser(description="Convert a short story into a silent storyboard MP4 video.")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--output", type=str, default="outputs/output.mp4")
    parser.add_argument("--keep-images", action="store_true")
    return parser.parse_args()

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print_banner()
    args = parse_args()

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        print("[ERROR] GEMINI_API_KEY environment variable not set.")
        sys.exit(1)

    # Auto-discover available Gemini model
    model_name = get_available_model(api_key)
    print(f"  ✓ Using model: {model_name}")

    ffmpeg_bin = check_ffmpeg()
    print(f"  ✓ FFmpeg found: {ffmpeg_bin}")

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img_dir = output_path.parent / "_scenes_tmp"
    img_dir.mkdir(parents=True, exist_ok=True)

    print(f"  ✓ Global seed: {args.seed}\n")

    story = read_story_from_stdin()
    if not story:
        print("[ERROR] No story provided.")
        sys.exit(1)

    print(f"\n  Story received: {len(story.split())} words.\n")

    print("[Step 1/3] Analysing story with Gemini…")
    try:
        scenes = story_to_scenes(story, api_key, model_name)
    except Exception as e:
        print(f"[ERROR] {e}")
        sys.exit(1)

    print_scene_summary(scenes)

    print("[Step 2/3] Generating scene images via Pollinations.ai…")
    image_paths = generate_images(scenes, img_dir, args.seed)

    print("\n[Step 3/3] Compiling video with FFmpeg…")
    try:
        compile_video(scenes, image_paths, output_path, ffmpeg_bin)
    except RuntimeError as e:
        print(f"[ERROR] {e}")
        sys.exit(1)

    if not args.keep_images:
        shutil.rmtree(img_dir, ignore_errors=True)
        print("  ✓ Temporary images cleaned up.")
    else:
        print(f"  ✓ Scene images kept in: {img_dir}")

    print(f"\n✅ Done! Video saved to: {output_path.resolve()}\n")

if __name__ == "__main__":
    main()