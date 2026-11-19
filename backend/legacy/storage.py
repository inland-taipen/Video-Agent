"""File storage abstraction.

`LocalStorage` keeps files on disk under LEGACY_STORAGE_DIR with random,
unguessable keys. Files are only ever served through authenticated API routes,
never through a static mount. A cloud backend (Supabase Storage, S3, GCS)
implements the same four methods and is selected with LEGACY_STORAGE=<name>
(`supabase` is implemented below).
"""
from __future__ import annotations

import os
import re
from abc import ABC, abstractmethod
from pathlib import Path
from typing import BinaryIO, Optional

import requests

from . import config, db


class StorageBackend(ABC):
    name: str

    @abstractmethod
    def put(self, key: str, data: BinaryIO) -> int:
        """Store a stream under `key`; return bytes written."""

    @abstractmethod
    def local_path(self, key: str) -> Path:
        """Return a local filesystem path for reading (download to temp for cloud backends)."""

    @abstractmethod
    def exists(self, key: str) -> bool: ...

    @abstractmethod
    def delete(self, key: str) -> None: ...


class LocalStorage(StorageBackend):
    name = "local"

    def __init__(self, root: Optional[Path] = None):
        self.root = (root or config.storage_root()).resolve()

    def _path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root not in p.parents:
            raise ValueError("Invalid storage key")
        return p

    def put(self, key: str, data: BinaryIO) -> int:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        written = 0
        tmp = path.with_suffix(path.suffix + ".part")
        with open(tmp, "wb") as fh:
            while chunk := data.read(1024 * 1024):
                written += len(chunk)
                if written > config.MAX_UPLOAD_BYTES:
                    fh.close()
                    tmp.unlink(missing_ok=True)
                    raise ValueError(f"File exceeds {config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit")
                fh.write(chunk)
        os.replace(tmp, path)
        return written

    def local_path(self, key: str) -> Path:
        return self._path(key)

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)


class SupabaseStorage(StorageBackend):
    """Files in a private Supabase Storage bucket, with a local read-through cache.

    Uploads are written to the cache first (enforcing the size limit while
    streaming), then sent to the bucket. Reads download into the cache on demand,
    because FFmpeg and FileResponse need a real path. The cache is disposable:
    on Render it is wiped on redeploy and refilled from the bucket.
    """
    name = "supabase"

    def __init__(self) -> None:
        self.base = config.supabase_url()
        self.key = config.supabase_service_key()
        self.bucket = config.storage_bucket()
        if not self.base or not self.key:
            raise RuntimeError("LEGACY_STORAGE=supabase needs SUPABASE_URL and SUPABASE_SECRET_KEY")
        self.cache = LocalStorage(config.cache_root())
        self._bucket_ready = False

    def _headers(self, **extra: str) -> dict:
        return {"Authorization": f"Bearer {self.key}", "apikey": self.key, **extra}

    def _url(self, key: str) -> str:
        self.cache._path(key)  # same key validation as local storage
        return f"{self.base}/storage/v1/object/{self.bucket}/{key}"

    def _ensure_bucket(self) -> None:
        if self._bucket_ready:
            return
        r = requests.post(f"{self.base}/storage/v1/bucket", headers=self._headers(),
                          json={"id": self.bucket, "name": self.bucket, "public": False}, timeout=30)
        if r.status_code >= 400 and "already exists" not in r.text.lower() and r.status_code != 409:
            raise RuntimeError(f"Could not create storage bucket '{self.bucket}': HTTP {r.status_code} {r.text[:200]}")
        self._bucket_ready = True

    def put(self, key: str, data: BinaryIO) -> int:
        written = self.cache.put(key, data)  # enforces MAX_UPLOAD_BYTES
        self._ensure_bucket()
        with open(self.cache.local_path(key), "rb") as fh:
            r = requests.post(self._url(key), data=fh, timeout=600,
                              headers=self._headers(**{"Content-Type": "application/octet-stream", "x-upsert": "true"}))
        if r.status_code >= 400:
            self.cache.delete(key)
            raise RuntimeError(f"Storage upload failed: HTTP {r.status_code} {r.text[:200]}")
        return written

    def local_path(self, key: str) -> Path:
        path = self.cache.local_path(key)
        if path.exists():
            return path
        with requests.get(self._url(key), headers=self._headers(), stream=True, timeout=600) as r:
            if r.status_code == 404 or (r.status_code == 400 and "not found" in r.text.lower()):
                raise FileNotFoundError(key)
            if r.status_code >= 400:
                raise RuntimeError(f"Storage download failed: HTTP {r.status_code} {r.text[:200]}")
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(path.suffix + ".part")
            with open(tmp, "wb") as fh:
                for chunk in r.iter_content(1024 * 1024):
                    fh.write(chunk)
            os.replace(tmp, path)
        return path

    def exists(self, key: str) -> bool:
        if self.cache.exists(key):
            return True
        r = requests.head(self._url(key), headers=self._headers(), timeout=30)
        return r.status_code == 200

    def delete(self, key: str) -> None:
        self.cache.delete(key)
        r = requests.delete(f"{self.base}/storage/v1/object/{self.bucket}", headers=self._headers(),
                            json={"prefixes": [key]}, timeout=30)
        if r.status_code >= 400 and r.status_code != 404:
            raise RuntimeError(f"Storage delete failed: HTTP {r.status_code} {r.text[:200]}")


def make_key(persona_id: str, kind: str, filename: str) -> str:
    ext = Path(filename or "").suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,5}", ext or ""):
        ext = ""
    return f"personas/{persona_id}/{kind}/{db.new_id()}{ext}"


_backend: Optional[StorageBackend] = None


def get_storage() -> StorageBackend:
    global _backend
    if _backend is None:
        kind = os.getenv("LEGACY_STORAGE", "local").strip()
        if kind == "supabase":
            _backend = SupabaseStorage()
        elif kind == "local":
            _backend = LocalStorage()
        else:
            raise RuntimeError(f"Unknown LEGACY_STORAGE '{kind}' (use 'local' or 'supabase')")
    return _backend
