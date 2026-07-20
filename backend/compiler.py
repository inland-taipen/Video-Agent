"""
compiler.py — Background video compilation job

Pipeline:
1. Download scene images in parallel (ThreadPoolExecutor)
2. Generate per-scene TTS audio files (gTTS)
3. Build FFmpeg filter_complex:
   - zoompan for Ken Burns effect per scene
   - xfade crossfade transitions between scenes
   - amix / concat for audio tracks aligned to video
4. Output H.264/AAC .mp4
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, List, Optional

import requests
# gTTS kept as fallback when ElevenLabs key is not set
try:
    from gtts import gTTS as _gTTS
    _GTTS_AVAILABLE = True
except ImportError:
    _GTTS_AVAILABLE = False

from models import ExportRequest, StoryboardFrame

# ──────────────────────────────────────────────────────────────────────────────
# Ken Burns motion presets — maps camera_movement → zoompan expression
# ──────────────────────────────────────────────────────────────────────────────
KB_PRESETS = {
    "ZOOM IN":   "z='min(zoom+0.0015,1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
    "ZOOM OUT":  "z='if(eq(on,1),1.5,max(zoom-0.0015,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
    "PAN LEFT":  "z=1.2:x='if(gte(on,1),x+1.5,iw/2)':y='ih/2-(ih/zoom/2)'",
    "PAN RIGHT": "z=1.2:x='if(gte(on,1),max(x-1.5,0),0)':y='ih/2-(ih/zoom/2)'",
    "PAN UP":    "z=1.2:x='iw/2-(iw/zoom/2)':y='if(gte(on,1),y+1.5,ih/2)'",
    "PAN DOWN":  "z=1.2:x='iw/2-(iw/zoom/2)':y='if(gte(on,1),max(y-1.5,0),0)'",
    "STATIC":    "z=1.0:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
}

XFADE_MODES = {
    "FADE IN":   "fade",
    "CROSSFADE": "fadeblack",
    "CUT TO":    "fade",
    "DISSOLVE":  "fadeblack",
    "WIPE":      "wipeleft",
}

XFADE_DURATION = 0.5  # seconds
IMAGE_TIMEOUT  = 60
W, H, FPS      = 1024, 576, 25


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _download_media(url: str, dest: Path, scene_num: int, media_type: str) -> Path:
    """Download media; fall back to a coloured placeholder."""
    import base64 as _b64, re as _re

    if not url:
        return _placeholder_image(dest, scene_num)

    # ── Handle base64 data URLs (e.g. data:image/jpeg;base64,/9j/...)  ─────────
    # The frontend stores images as data URLs — we must decode them directly.
    if url.startswith("data:"):
        try:
            # Strip the header: "data:image/jpeg;base64,<payload>"
            match = _re.match(r"data:[^;]+;base64,(.+)", url, _re.DOTALL)
            if match:
                raw = _b64.b64decode(match.group(1))
                dest.write_bytes(raw)
                print(f"  [OK] Scene {scene_num}: decoded base64 image ({len(raw)//1024}KB)")
                return dest
        except Exception as exc:
            print(f"  [WARN] Scene {scene_num} base64 decode failed: {exc}")
        return _placeholder_image(dest, scene_num)

    # Convert relative frontend proxy URLs to absolute backend URLs
    if url.startswith("/"):
        url = f"http://127.0.0.1:8000{url}"

    try:
        r = requests.get(url, timeout=IMAGE_TIMEOUT, stream=True)
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(8192):
                f.write(chunk)
        return dest
    except Exception as exc:
        print(f"  [WARN] Scene {scene_num} image failed: {exc} — using placeholder")
        return _placeholder_image(dest, scene_num)


def _placeholder_image(dest: Path, scene_num: int) -> Path:
    """Create a dark gradient placeholder JPEG via Pillow."""
    try:
        from PIL import Image, ImageDraw, ImageFont
        img = Image.new("RGB", (W, H), color=(15, 15, 25))
        draw = ImageDraw.Draw(img)
        # gradient bands
        for i in range(H):
            lum = int(15 + 30 * (i / H))
            draw.line([(0, i), (W, i)], fill=(lum, lum, lum + 20))
        text = f"Scene {scene_num}"
        try:
            fnt = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 52)
        except Exception:
            fnt = ImageFont.load_default()
        draw.text((W // 2, H // 2), text, fill=(200, 200, 220), font=fnt, anchor="mm")
        img.save(dest, "JPEG", quality=90)
    except ImportError:
        # bare-minimum 1×1 JPEG
        dest.write_bytes(bytes([
            0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0x00,0x01,
            0x01,0x00,0x00,0x01,0x00,0x01,0x00,0x00,0xFF,0xD9
        ]))
    return dest


# ── ElevenLabs config ────────────────────────────────────────────────────────
# Sign up free at https://elevenlabs.io — 10,000 chars/month free tier
# Set ELEVENLABS_API_KEY in .env to enable premium voice
# Voice IDs: Rachel=21m00Tcm4TlvDq8ikWAM, Adam=pNInz6obpgDQGcFmaJgB,
#            Aria=9BWtsMINqrJLrRacOk9x, Sarah=EXAVITQu4vr4xnSDxMaL
_EL_API_KEY     = lambda: os.getenv("ELEVENLABS_API_KEY", "").strip()
_EL_VOICE_ID    = lambda: os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")  # Rachel
_EL_MODEL       = lambda: os.getenv("ELEVENLABS_MODEL", "eleven_multilingual_v2")
_EL_BASE        = "https://api.elevenlabs.io/v1"


def _elevenlabs_tts(text: str, dest: Path, voice_id: Optional[str] = None) -> Optional[Path]:
    """Generate MP3 using ElevenLabs API. Returns None on failure."""
    key = _EL_API_KEY()
    if not key:
        return None
    try:
        vid = voice_id or _EL_VOICE_ID()
        model = _EL_MODEL()
        url = f"{_EL_BASE}/text-to-speech/{vid}"
        payload = {
            "text": text,
            "model_id": model,
            "voice_settings": {
                "stability": 0.45,
                "similarity_boost": 0.75,
                "style": 0.20,
                "use_speaker_boost": True,
            },
        }
        r = requests.post(
            url,
            headers={"xi-api-key": key, "Content-Type": "application/json"},
            json=payload,
            timeout=60,
        )
        if r.status_code != 200:
            print(f"  [WARN] ElevenLabs {r.status_code}: {r.text[:200]}")
            return None
        dest.write_bytes(r.content)
        print(f"  [OK] ElevenLabs TTS ({len(r.content)//1024}KB)")
        return dest
    except Exception as exc:
        print(f"  [WARN] ElevenLabs TTS error: {exc}")
        return None


def _generate_tts(text: str, dest: Path, lang: str = "en", voice_id: Optional[str] = None) -> Optional[Path]:
    """Generate narration audio.
    Priority: ElevenLabs (premium) → gTTS (free fallback).
    Returns Path to MP3 or None if text is blank.
    """
    if not text.strip():
        return None

    # 1. ElevenLabs — best quality
    el_result = _elevenlabs_tts(text, dest, voice_id)
    if el_result:
        return el_result

    # 2. gTTS — free Google TTS fallback
    if _GTTS_AVAILABLE:
        try:
            tts = _gTTS(text=text, lang=lang, slow=False)
            tts.save(str(dest))
            print(f"  [INFO] gTTS fallback used")
            return dest
        except Exception as exc:
            print(f"  [WARN] gTTS failed: {exc}")

    return None


def _silent_audio(dest: Path, duration: float, ffmpeg: str) -> Path:
    """Generate a silent AAC audio file of given duration."""
    subprocess.run(
        [ffmpeg, "-y", "-f", "lavfi", "-i",
         f"anullsrc=r=44100:cl=mono:d={duration}",
         "-c:a", "aac", "-b:a", "64k", str(dest)],
        capture_output=True, check=False
    )
    return dest


# ──────────────────────────────────────────────────────────────────────────────
# Main compilation job
# ──────────────────────────────────────────────────────────────────────────────

def compile_video(
    request: ExportRequest,
    output_path: Path,
    ffmpeg_bin: str,
    progress_cb: Callable[[int, str], None],
) -> None:
    """
    Full pipeline: download → TTS → FFmpeg.
    progress_cb(percent, message) is called as work proceeds.
    """
    frames: List[StoryboardFrame] = request.frames
    n = len(frames)

    with tempfile.TemporaryDirectory(prefix="story2vid_") as tmp:
        tmp_dir = Path(tmp)
        progress_cb(2, "Downloading scene images…")

        # ── 1. Download images in parallel ─────────────────────────────────
        img_paths: List[Path] = [Path()] * n

        def _dl(idx: int, frame: StoryboardFrame) -> tuple[int, Path]:
            ext = ".mp4" if frame.media_type == "video" else ".jpg"
            dest = tmp_dir / f"media_{idx:03d}{ext}"
            return idx, _download_media(frame.media_url, dest, frame.scene.scene_number, frame.media_type)

        with ThreadPoolExecutor(max_workers=1) as pool:
            futures = {pool.submit(_dl, i, f): i for i, f in enumerate(frames)}
            done = 0
            for fut in as_completed(futures):
                idx, path = fut.result()
                img_paths[idx] = path
                done += 1
                progress_cb(2 + int(28 * done / n), f"Downloaded {done}/{n} images…")

        # ── 2. Generate TTS audio per scene ────────────────────────────────
        progress_cb(30, "Generating narration audio…")
        audio_paths: List[Optional[Path]] = []
        for i, frame in enumerate(frames):
            dest_mp3 = tmp_dir / f"audio_{i:03d}.mp3"
            dest_aac = tmp_dir / f"audio_{i:03d}.aac"
            narration = frame.scene.narration.strip()
            
            # Dynamically pick the best voice based on the scene's style
            style = (frame.scene.style or "").lower()
            if "documentary" in style or "photorealistic" in style:
                voice = "pNInz6obpgDQGcFmaJgB" # Adam (deep, authoritative)
            elif "noir" in style or "cinematic" in style:
                voice = "JBFqnCBsd6RMkjVDRZzb" # Marcus (gravelly, intense)
            elif "anime" in style:
                voice = "N2lVS1w4EtoT3dr4eOWO" # Callum (British, intense)
            elif "storybook" in style or "watercolor" in style:
                voice = "XB0fDUnXU5ywgM19yw7a" # Charlotte (gentle British female)
            else:
                voice = None # fallback to default

            mp3 = _generate_tts(narration, dest_mp3, voice_id=voice)
            if mp3 and mp3.exists():
                # convert mp3 → aac so ffmpeg can concat cleanly
                subprocess.run(
                    [ffmpeg_bin, "-y", "-i", str(mp3),
                     "-c:a", "aac", "-b:a", "64k", str(dest_aac)],
                    capture_output=True, check=False
                )
                audio_paths.append(dest_aac if dest_aac.exists() else None)
            else:
                audio_paths.append(None)
            progress_cb(30 + int(20 * (i + 1) / n), f"TTS {i+1}/{n}…")

        # ── 3. Build FFmpeg inputs & filter_complex ─────────────────────────
        progress_cb(50, "Building FFmpeg filter graph…")

        # Pad durations so xfade doesn't stutter
        durations: List[float] = []
        for frame in frames:
            d = float(frame.scene.duration) if frame.scene.duration > 0 else 3.0
            durations.append(d)

        cmd: List[str] = [ffmpeg_bin, "-y"]

        # Input media
        for idx, (img_path, dur) in enumerate(zip(img_paths, durations)):
            if frames[idx].media_type == "video":
                cmd += ["-stream_loop", "-1", "-t", str(dur + XFADE_DURATION), "-i", str(img_path)]
            else:
                # zoompan expects a single frame input, do not loop
                cmd += ["-i", str(img_path)]

        # Input audio files
        audio_input_indices: List[Optional[int]] = []
        for i, ap in enumerate(audio_paths):
            if ap and ap.exists():
                cmd += ["-i", str(ap)]
                audio_input_indices.append(n + len([x for x in audio_input_indices if x is not None]))
            else:
                audio_input_indices.append(None)

        # ── Video filter_complex ─────────────────────────────────────────────
        vf_parts: List[str] = []
        v_labels: List[str] = []

        for idx, (frame, dur, img_path) in enumerate(zip(frames, durations, img_paths)):
            label = f"kb{idx}"
            if frame.media_type == "video":
                vf_parts.append(
                    f"[{idx}:v]scale={W}:{H}:force_original_aspect_ratio=decrease,"
                    f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,"
                    f"setsar=1,format=yuv420p,fps={FPS}[{label}]"
                )
            else:
                mv = frame.scene.camera_movement.upper()
                kbp = KB_PRESETS.get(mv, KB_PRESETS["STATIC"])
                frames_count = int((dur + XFADE_DURATION) * FPS)
                kbp_full = f"zoompan={kbp}:d={frames_count}:s={W}x{H}:fps={FPS}"
                vf_parts.append(
                    f"[{idx}:v]scale={W}:{H}:force_original_aspect_ratio=decrease,"
                    f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,"
                    f"setsar=1,format=yuv420p,{kbp_full}[{label}]"
                )
            v_labels.append(label)

        # xfade chain
        xf_chain = ""
        prev_label = v_labels[0]
        accumulated_offset = 0.0
        for idx in range(1, n):
            accumulated_offset += durations[idx - 1]
            offset = max(accumulated_offset - XFADE_DURATION, 0.01)
            mode = XFADE_MODES.get(frames[idx].scene.transition.upper(), "fade")
            out_label = f"xf{idx}" if idx < n - 1 else "outv"
            xf_chain += (
                f"[{prev_label}][{v_labels[idx]}]"
                f"xfade=transition={mode}:duration={XFADE_DURATION}:offset={offset:.3f}"
                f"[{out_label}];"
            )
            prev_label = out_label
            accumulated_offset -= XFADE_DURATION  # account for the overlap

        if n == 1:
            vf_parts.append(f"[{v_labels[0]}]copy[outv]")
            xf_chain = ""

        video_filter = ";".join(vf_parts)
        if xf_chain:
            video_filter += ";" + xf_chain.rstrip(";")

        # ── Audio filter_complex ─────────────────────────────────────────────
        # Build per-scene silent-padded audio, then concat
        audio_parts: List[str] = []
        a_labels: List[str] = []
        actual_audio_inputs = [x for x in audio_input_indices if x is not None]

        # Re-derive audio input stream indices cleanly
        audio_stream_map: dict[int, int] = {}  # scene_idx → ffmpeg input idx
        ai = n  # images take inputs 0..n-1
        for i, ap in enumerate(audio_paths):
            if ap and ap.exists():
                audio_stream_map[i] = ai
                ai += 1

        for i, (frame, dur) in enumerate(zip(frames, durations)):
            a_label = f"a{i}"
            if i in audio_stream_map:
                si = audio_stream_map[i]
                # pad to scene duration with silence
                audio_parts.append(
                    f"[{si}:a]apad=whole_dur={dur:.3f},atrim=0:{dur:.3f}[{a_label}]"
                )
            else:
                # pure silence
                audio_parts.append(
                    f"anullsrc=r=44100:cl=mono,atrim=0:{dur:.3f},asetpts=PTS-STARTPTS[{a_label}]"
                )
            a_labels.append(a_label)

        total_audio_dur = sum(durations) - (n - 1) * XFADE_DURATION if n > 1 else durations[0]

        if a_labels:
            concat_inputs = "".join(f"[{l}]" for l in a_labels)
            audio_filter = (
                ";".join(audio_parts)
                + f";{concat_inputs}concat=n={n}:v=0:a=1[outa]"
            )
            video_filter += ";" + audio_filter
            map_args = ["-map", "[outv]", "-map", "[outa]"]
            acodec_args = ["-c:a", "aac", "-b:a", "128k"]
        else:
            map_args = ["-map", "[outv]"]
            acodec_args = []

        # ── Final FFmpeg command ─────────────────────────────────────────────
        cmd += [
            "-filter_complex", video_filter,
        ] + map_args + [
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-crf", "23",
            "-preset", "fast",
            "-movflags", "+faststart",
            "-r", str(FPS),
            "-t", str(total_audio_dur),
        ] + acodec_args + [str(output_path)]

        progress_cb(60, "Running FFmpeg…")
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(
                f"FFmpeg failed (exit {result.returncode}):\n{result.stderr[-1000:]}"
            )

        progress_cb(98, "Finalising…")
        size_mb = output_path.stat().st_size / (1024 * 1024)
        progress_cb(100, f"Done — {size_mb:.1f} MB")
