"""File storage abstraction.

`LocalStorage` keeps files on disk under LEGACY_STORAGE_DIR with random,
unguessable keys. Files are only ever served through authenticated API routes,
never through a static mount. A cloud backend (Supabase Storage, S3, GCS)
implements the same four methods and is selected with LEGACY_STORAGE=<name>.
"""
from __future__ import annotations

import os
import re
from abc import ABC, abstractmethod
from pathlib import Path
from typing import BinaryIO, Optional

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
        if kind != "local":
            raise RuntimeError(f"Storage backend '{kind}' is not implemented yet (only 'local')")
        _backend = LocalStorage()
    return _backend
