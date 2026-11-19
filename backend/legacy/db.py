"""SQLite data layer. One connection per call; WAL mode so the background
ingestion thread and request handlers don't block each other."""
from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from . import config

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()
_initialised: set[str] = set()


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex


def _connect() -> sqlite3.Connection:
    path = str(config.db_path())
    conn = sqlite3.connect(path, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    if path not in _initialised:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(_SCHEMA)
        _initialised.add(path)
    return conn


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def one(sql: str, params: tuple = ()) -> Optional[dict]:
    with tx() as c:
        row = c.execute(sql, params).fetchone()
        return dict(row) if row else None


def all_rows(sql: str, params: tuple = ()) -> list[dict]:
    with tx() as c:
        return [dict(r) for r in c.execute(sql, params).fetchall()]


def execute(sql: str, params: tuple = ()) -> None:
    with tx() as c:
        c.execute(sql, params)


def insert(table: str, row: dict[str, Any]) -> None:
    cols = ", ".join(row)
    qs = ", ".join("?" for _ in row)
    with tx() as c:
        c.execute(f"INSERT INTO {table} ({cols}) VALUES ({qs})", tuple(row.values()))


def update(table: str, key: str, key_val: Any, fields: dict[str, Any]) -> None:
    if not fields:
        return
    sets = ", ".join(f"{k} = ?" for k in fields)
    with tx() as c:
        c.execute(f"UPDATE {table} SET {sets} WHERE {key} = ?", (*fields.values(), key_val))


def jload(value: Optional[str], default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default
