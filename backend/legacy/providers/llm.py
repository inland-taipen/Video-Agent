"""LLM providers with blocking and streaming calls, plus ordered fallback.

Messages use a neutral format: [{"role": "user"|"assistant", "content": str}].
"""
from __future__ import annotations

import json
from abc import ABC, abstractmethod
from typing import Callable, Iterator, Optional

import requests

from .. import config
from .http import ProviderError, post

Messages = list[dict]


class LLMProvider(ABC):
    name: str

    @abstractmethod
    def available(self) -> bool: ...

    @abstractmethod
    def complete(self, system: str, messages: Messages, *, json_mode: bool = False,
                 max_tokens: int = 2048, temperature: float = 0.3) -> str: ...

    @abstractmethod
    def stream(self, system: str, messages: Messages, *, max_tokens: int = 400,
               temperature: float = 0.6) -> Iterator[str]: ...


class GroqLLM(LLMProvider):
    name = "groq"
    URL = "https://api.groq.com/openai/v1/chat/completions"

    def available(self) -> bool:
        return bool(config.groq_key())

    def _body(self, system: str, messages: Messages, **kw) -> dict:
        return {
            "model": config.groq_chat_model(),
            "messages": [{"role": "system", "content": system}, *messages],
            **kw,
        }

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {config.groq_key()}", "Content-Type": "application/json"}

    def complete(self, system, messages, *, json_mode=False, max_tokens=2048, temperature=0.3) -> str:
        body = self._body(system, messages, max_tokens=max_tokens, temperature=temperature)
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        r = post(self.URL, headers=self._headers(), json=body)
        return r.json()["choices"][0]["message"]["content"] or ""

    def stream(self, system, messages, *, max_tokens=400, temperature=0.6) -> Iterator[str]:
        body = self._body(system, messages, max_tokens=max_tokens, temperature=temperature, stream=True)
        try:
            r = requests.post(self.URL, headers=self._headers(), json=body, stream=True, timeout=60)
        except requests.RequestException as exc:
            raise ProviderError(f"Groq network error: {exc}")
        if r.status_code >= 400:
            raise ProviderError(f"Groq HTTP {r.status_code}: {r.text[:300]}")
        r.encoding = "utf-8"  # SSE responses omit a charset; requests would assume Latin-1
        for line in r.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                delta = json.loads(payload)["choices"][0]["delta"].get("content")
            except (ValueError, KeyError, IndexError):
                continue
            if delta:
                yield delta


class GeminiLLM(LLMProvider):
    name = "gemini"
    BASE = "https://generativelanguage.googleapis.com/v1beta/models"

    def available(self) -> bool:
        return bool(config.gemini_key())

    def _body(self, system: str, messages: Messages, *, max_tokens: int, temperature: float,
              json_mode: bool = False, fast: bool = False) -> dict:
        gen: dict = {"temperature": temperature, "maxOutputTokens": max_tokens}
        if json_mode:
            gen["responseMimeType"] = "application/json"
        if fast:
            gen["thinkingConfig"] = {"thinkingBudget": 0}  # low latency for live conversation
        return {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [
                {"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
                for m in messages
            ],
            "generationConfig": gen,
        }

    def _headers(self) -> dict:
        return {"x-goog-api-key": config.gemini_key(), "Content-Type": "application/json"}

    @staticmethod
    def _text(data: dict) -> str:
        try:
            parts = data["candidates"][0]["content"].get("parts", [])
        except (KeyError, IndexError):
            return ""
        return "".join(p.get("text", "") for p in parts if not p.get("thought"))

    def complete(self, system, messages, *, json_mode=False, max_tokens=8192, temperature=0.3) -> str:
        body = self._body(system, messages, max_tokens=max_tokens, temperature=temperature, json_mode=json_mode)
        r = post(f"{self.BASE}/{config.gemini_chat_model()}:generateContent", headers=self._headers(), json=body,
                 timeout=240)
        text = self._text(r.json())
        if not text:
            raise ProviderError(f"Gemini returned no text: {r.text[:200]}")
        return text

    def stream(self, system, messages, *, max_tokens=400, temperature=0.6) -> Iterator[str]:
        body = self._body(system, messages, max_tokens=max_tokens, temperature=temperature, fast=True)
        url = f"{self.BASE}/{config.gemini_chat_model()}:streamGenerateContent?alt=sse"
        try:
            r = requests.post(url, headers=self._headers(), json=body, stream=True, timeout=60)
        except requests.RequestException as exc:
            raise ProviderError(f"Gemini network error: {exc}")
        if r.status_code >= 400:
            raise ProviderError(f"Gemini HTTP {r.status_code}: {r.text[:300]}")
        r.encoding = "utf-8"  # SSE responses omit a charset; requests would assume Latin-1
        for line in r.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue
            try:
                text = self._text(json.loads(line[5:]))
            except ValueError:
                continue
            if text:
                yield text


_PROVIDERS: dict[str, Callable[[], LLMProvider]] = {"groq": GroqLLM, "gemini": GeminiLLM}


def providers(order: list[str]) -> list[LLMProvider]:
    out = []
    for name in order:
        factory = _PROVIDERS.get(name)
        if factory:
            p = factory()
            if p.available():
                out.append(p)
    return out


def complete_with_fallback(order: list[str], system: str, messages: Messages, **kw) -> tuple[str, str]:
    """Return (text, provider_name). Raises ProviderError if every provider fails."""
    errors = []
    for p in providers(order):
        try:
            text = p.complete(system, messages, **kw)
            if text.strip():
                return text, p.name
            errors.append(f"{p.name}: empty response")
        except Exception as exc:  # noqa: BLE001 — try the next provider
            errors.append(f"{p.name}: {exc}")
    raise ProviderError("; ".join(errors) or "No LLM provider configured")


def stream_with_fallback(order: list[str], system: str, messages: Messages,
                         **kw) -> tuple[Optional[str], Iterator[str]]:
    """Start a stream on the first provider that yields a token.

    Returns (provider_name, iterator). provider_name is None when every provider
    failed before producing output, in which case the iterator is empty.
    """
    for p in providers(order):
        it = p.stream(system, messages, **kw)
        try:
            first = next(it)
        except StopIteration:
            continue
        except Exception as exc:  # noqa: BLE001
            print(f"  [legacy] {p.name} stream failed, trying next: {exc}")
            continue

        def chain(first=first, it=it, name=p.name) -> Iterator[str]:
            yield first
            try:
                yield from it
            except Exception as exc:  # noqa: BLE001 — stream cut mid-way; keep what we have
                print(f"  [legacy] {name} stream interrupted: {exc}")

        return p.name, chain()
    return None, iter(())
