"""Voice (text-to-speech) providers for persona replies.

The conversation engine only ever produces text. How that text becomes sound is
decided per persona by `personas.voice_provider`:

  browser     (working)  — the frontend speaks with window.speechSynthesis.
                           The server does nothing; `synthesize` is never called.
  elevenlabs  (deferred) — server-side synthesis with a configured voice_id.
                           Off unless LEGACY_ENABLE_ELEVENLABS=1. Voice *cloning*
                           is not implemented: it needs a paid plan plus a
                           recorded consent (see consents.kind = 'voice_clone').

Adding a provider = subclass VoiceProvider, register it in _PROVIDERS, and add
a matching client in frontend/src/legacy/voice/.
"""
from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import Optional

from .http import ProviderError, post


class VoiceProvider(ABC):
    name: str
    label: str
    client_side: bool  # True = audio is produced in the browser
    status: str        # working | deferred

    @abstractmethod
    def available(self) -> bool: ...

    def synthesize(self, text: str, voice_config: dict) -> tuple[bytes, str]:
        """Return (audio_bytes, mime_type). Only for server-side providers."""
        raise ProviderError(f"{self.name} synthesises in the browser", retryable=False)


class BrowserVoice(VoiceProvider):
    name = "browser"
    label = "Browser voice (temporary, not their real voice)"
    client_side = True
    status = "working"

    def available(self) -> bool:
        return True


class ElevenLabsVoice(VoiceProvider):
    name = "elevenlabs"
    label = "ElevenLabs voice"
    client_side = False
    status = "deferred"

    def available(self) -> bool:
        return os.getenv("LEGACY_ENABLE_ELEVENLABS", "") == "1" and bool(os.getenv("ELEVENLABS_API_KEY", "").strip())

    def synthesize(self, text: str, voice_config: dict) -> tuple[bytes, str]:
        if not self.available():
            raise ProviderError("ElevenLabs voice is not enabled", retryable=False)
        voice_id: Optional[str] = voice_config.get("elevenlabs_voice_id")
        if not voice_id:
            raise ProviderError("No ElevenLabs voice_id configured for this persona", retryable=False)
        r = post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_64",
            headers={"xi-api-key": os.getenv("ELEVENLABS_API_KEY", "").strip()},
            json={"text": text, "model_id": os.getenv("LEGACY_ELEVENLABS_MODEL", "eleven_flash_v2_5")},
            timeout=60,
        )
        return r.content, "audio/mpeg"


_PROVIDERS = {p.name: p for p in (BrowserVoice(), ElevenLabsVoice())}


def get_voice(name: str) -> VoiceProvider:
    return _PROVIDERS.get(name) or _PROVIDERS["browser"]


def catalogue() -> list[dict]:
    return [
        {"name": p.name, "label": p.label, "client_side": p.client_side,
         "status": p.status, "available": p.available()}
        for p in _PROVIDERS.values()
    ]
