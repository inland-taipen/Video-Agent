"""Speech-to-text providers.

GroqWhisperSTT (working): normalises audio with FFmpeg to 16 kHz mono MP3,
splits long recordings into 10-minute chunks (Groq's free tier caps files at
25 MB), and stitches timestamped segments back together.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .. import config
from .http import ProviderError, post

CHUNK_SECONDS = 600


@dataclass
class Segment:
    start: Optional[float]
    end: Optional[float]
    text: str


@dataclass
class Transcript:
    text: str
    language: str
    provider: str
    duration: Optional[float] = None
    segments: list[Segment] = field(default_factory=list)


class STTUnavailable(RuntimeError):
    pass


class STTProvider(ABC):
    name: str

    @abstractmethod
    def available(self) -> bool: ...

    @abstractmethod
    def transcribe(self, audio_path: Path, language_hint: Optional[str] = None) -> Transcript: ...


def _ffmpeg() -> Optional[str]:
    return shutil.which("ffmpeg")


def probe_duration(path: Path) -> Optional[float]:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        return float(json.loads(out.stdout)["format"]["duration"])
    except (ValueError, KeyError, subprocess.SubprocessError, json.JSONDecodeError):
        return None


def _normalise(src: Path, workdir: Path) -> list[tuple[Path, float]]:
    """Return [(chunk_path, offset_seconds)]. Falls back to the original file without FFmpeg."""
    ffmpeg = _ffmpeg()
    if not ffmpeg:
        return [(src, 0.0)]
    norm = workdir / "norm.mp3"
    r = subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
         "-b:a", "32k", str(norm)],
        capture_output=True, text=True, timeout=1800,
    )
    if r.returncode != 0:
        raise ProviderError(f"Could not decode audio file: {r.stderr.strip()[:200]}", retryable=False)
    duration = probe_duration(norm) or 0
    if duration <= CHUNK_SECONDS + 30:
        return [(norm, 0.0)]
    pattern = workdir / "chunk_%03d.mp3"
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-i", str(norm), "-f", "segment",
         "-segment_time", str(CHUNK_SECONDS), "-c", "copy", str(pattern)],
        check=True, timeout=600,
    )
    chunks, offset = [], 0.0
    for p in sorted(workdir.glob("chunk_*.mp3")):
        chunks.append((p, offset))
        offset += probe_duration(p) or CHUNK_SECONDS
    return chunks


class GroqWhisperSTT(STTProvider):
    name = "groq-whisper"
    URL = "https://api.groq.com/openai/v1/audio/transcriptions"

    def available(self) -> bool:
        return bool(config.groq_key())

    def _one(self, path: Path, language_hint: Optional[str]) -> dict:
        data = {"model": config.whisper_model(), "response_format": "verbose_json", "temperature": "0"}
        if language_hint:
            data["language"] = language_hint.split("-")[0]
        with open(path, "rb") as fh:
            r = post(
                self.URL,
                headers={"Authorization": f"Bearer {config.groq_key()}"},
                data=data,
                files={"file": (path.name, fh, "audio/mpeg")},
                timeout=300,
            )
        return r.json()

    def transcribe(self, audio_path: Path, language_hint: Optional[str] = None) -> Transcript:
        if not self.available():
            raise STTUnavailable("GROQ_API_KEY is not set")
        with tempfile.TemporaryDirectory() as tmp:
            chunks = _normalise(audio_path, Path(tmp))
            segments: list[Segment] = []
            texts: list[str] = []
            language = ""
            for path, offset in chunks:
                data = self._one(path, language_hint)
                language = language or data.get("language", "")
                texts.append((data.get("text") or "").strip())
                for s in data.get("segments") or []:
                    t = (s.get("text") or "").strip()
                    if t:
                        segments.append(Segment(offset + float(s.get("start", 0)), offset + float(s.get("end", 0)), t))
        text = " ".join(t for t in texts if t).strip()
        if not text:
            raise ProviderError("Whisper returned an empty transcript (silent or unsupported audio?)", retryable=False)
        if not segments:
            segments = [Segment(None, None, text)]
        return Transcript(text=text, language=language, provider=self.name,
                          duration=probe_duration(audio_path), segments=segments)


def get_stt() -> STTProvider:
    return GroqWhisperSTT()


def transcribe_bytes_quick(data: bytes, filename: str, language_hint: Optional[str] = None) -> Transcript:
    """Transcribe a short clip (live conversation turn or the legacy story uploader)."""
    stt = get_stt()
    if not stt.available():
        raise STTUnavailable("GROQ_API_KEY is not set")
    suffix = Path(filename).suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as fh:
        fh.write(data)
        tmp = Path(fh.name)
    try:
        return stt.transcribe(tmp, language_hint)
    finally:
        tmp.unlink(missing_ok=True)
