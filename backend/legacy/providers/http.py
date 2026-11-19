"""Small HTTP helper with retry on rate limits / transient errors."""
from __future__ import annotations

import time
from typing import Any

import requests

RETRY_STATUSES = {429, 500, 502, 503, 504}


class ProviderError(RuntimeError):
    """A provider call failed. `retryable` is False for auth/config problems."""

    def __init__(self, message: str, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


def post(url: str, *, attempts: int = 3, **kwargs: Any) -> requests.Response:
    kwargs.setdefault("timeout", 120)
    last = ""
    for i in range(attempts):
        try:
            r = requests.post(url, **kwargs)
        except requests.RequestException as exc:
            last = f"network error: {exc}"
            time.sleep(1.5 * (i + 1))
            continue
        if r.status_code < 400:
            return r
        last = f"HTTP {r.status_code}: {r.text[:300]}"
        if r.status_code not in RETRY_STATUSES or i == attempts - 1:
            break
        wait = r.headers.get("retry-after")
        try:
            delay = min(float(wait), 20.0) if wait else 2.0 * (i + 1)
        except ValueError:
            delay = 2.0 * (i + 1)
        time.sleep(delay)
    raise ProviderError(last, retryable=not last.startswith(("HTTP 401", "HTTP 403", "HTTP 400")))
