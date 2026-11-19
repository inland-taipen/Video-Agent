"""Data layer with two backends behind the same tiny API.

* Postgres (Supabase or any host) when DATABASE_URL / LEGACY_DATABASE_URL is set —
  use this in production so data survives redeploys.
* SQLite file under LEGACY_DATA_DIR otherwise — local development and tests.

Callers write SQLite-style SQL (`?` placeholders, `INSERT OR IGNORE`); `_pg_sql`
rewrites it for Postgres, so the rest of the code doesn't care which is active.
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from . import config

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()
_initialised: set[str] = set()
_lock = threading.Lock()
_pools: dict[str, Any] = {}


def now() -> str:
    # Microseconds so rows created in the same second still sort in insertion order.
    # (Older second-precision values sort before same-second fractional ones: "+" < ".")
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def new_id() -> str:
    return uuid.uuid4().hex


def backend_name() -> str:
    return "postgres" if config.database_url() else "sqlite"


def order_tiebreak() -> str:
    """Extra ORDER BY column for rows with equal created_at (SQLite's implicit rowid; Postgres has none)."""
    return "id" if config.database_url() else "rowid"


# ── SQL translation ──────────────────────────────────────────────────────────

_INSERT_OR_IGNORE = re.compile(r"^\s*INSERT\s+OR\s+IGNORE\s+INTO", re.IGNORECASE)
_GROUP_CONCAT = re.compile(r"\bgroup_concat\(", re.IGNORECASE)  # always called with a separator here


def _pg_sql(sql: str) -> str:
    out = _GROUP_CONCAT.sub("string_agg(", sql.replace("%", "%%").replace("?", "%s"))
    if _INSERT_OR_IGNORE.match(out):
        out = _INSERT_OR_IGNORE.sub("INSERT INTO", out, count=1).rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
    return out


def _pg_schema() -> str:
    return "\n".join(l for l in _SCHEMA.splitlines() if not l.strip().upper().startswith("PRAGMA"))


class _PgConn:
    """Gives a psycopg connection the sqlite3-style `execute(sql, params)` callers use."""

    def __init__(self, conn: Any):
        self._conn = conn

    def execute(self, sql: str, params: tuple = ()) -> Any:
        return self._conn.execute(_pg_sql(sql), tuple(params))

    def executemany(self, sql: str, seq: Any) -> Any:
        cur = self._conn.cursor()
        cur.executemany(_pg_sql(sql), [tuple(p) for p in seq])
        return cur


# ── Connections ──────────────────────────────────────────────────────────────

def _pg_pool(url: str) -> Any:
    with _lock:
        pool = _pools.get(url)
        if pool is None:
            from psycopg.rows import dict_row
            from psycopg_pool import ConnectionPool

            pool = ConnectionPool(
                url,
                min_size=1,
                max_size=5,
                # prepare_threshold=None keeps it compatible with PgBouncer / Supabase pooler.
                kwargs={"row_factory": dict_row, "prepare_threshold": None, "autocommit": False},
                check=ConnectionPool.check_connection,
                open=True,
            )
            _pools[url] = pool
        if url not in _initialised:
            with pool.connection() as conn:
                # Advisory lock so two instances starting together don't race on CREATE TABLE.
                conn.execute("SELECT pg_advisory_xact_lock(727274)")
                conn.execute(_pg_schema())
            _initialised.add(url)
        return pool


def _sqlite_connect() -> sqlite3.Connection:
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
def tx() -> Iterator[Any]:
    """One transaction. Yields an object with `execute(sql, params)` returning a cursor."""
    url = config.database_url()
    if url:
        with _pg_pool(url).connection() as conn:  # commits on success, rolls back on error
            yield _PgConn(conn)
        return
    conn = _sqlite_connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def close_pools() -> None:
    with _lock:
        for pool in _pools.values():
            pool.close()
        _pools.clear()
        _initialised.clear()


# ── Helpers ──────────────────────────────────────────────────────────────────

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
