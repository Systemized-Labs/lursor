"""The memory columns are added on boot, and an existing install is unchanged.

The four ``app_config`` columns behind the memory provider land via the additive
lightweight-migration path (``db/session._apply_lightweight_migrations``), so a
database written by the previous build has to gain them on the next start —
without a backfill, and without any existing row's behaviour changing. A NULL
``memory_provider`` means "file", which is exactly what every install was doing
before, so "no backfill" is the whole correctness argument and is what this pins.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel import SQLModel

from app.agents import hindsight as hs
from app.config import get_settings
from app.db import models  # noqa: F401  (registers tables on SQLModel.metadata)
from app.db.models import AppConfig
from app.db.session import _apply_lightweight_migrations

MEMORY_COLUMNS = (
    "memory_provider",
    "hindsight_base_url",
    "hindsight_api_key",
    "hindsight_config",
)


async def _pre_memory_db(path: Path) -> None:
    """A database shaped like the build before the memory provider existed."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
            for column in MEMORY_COLUMNS:
                await conn.execute(
                    text(f"ALTER TABLE app_config DROP COLUMN {column}")
                )
    finally:
        await engine.dispose()

    # A populated row, as an upgrading install would have: a key, a search
    # provider, and nothing whatsoever about memory.
    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO app_config (id, created_at, updated_at, openrouter_api_key,"
        " web_search_provider, default_agents, deep_defaults)"
        " VALUES ('cfg', datetime('now'), datetime('now'), 'sk-existing',"
        " 'tavily', '{}', '{}')"
    )
    con.commit()
    con.close()


async def _columns(path: Path) -> set[str]:
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.connect() as conn:
            rows = (await conn.execute(text("PRAGMA table_info(app_config)"))).all()
    finally:
        await engine.dispose()
    return {r[1] for r in rows}


async def _migrate(path: Path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await _apply_lightweight_migrations(conn)
    finally:
        await engine.dispose()


@pytest.fixture
async def legacy_db(tmp_path):
    path = tmp_path / "pre-memory.db"
    await _pre_memory_db(path)
    return path


async def test_the_memory_columns_are_added_on_boot(legacy_db):
    assert not (await _columns(legacy_db)) & set(MEMORY_COLUMNS)
    await _migrate(legacy_db)
    assert set(MEMORY_COLUMNS) <= await _columns(legacy_db)


async def test_an_existing_row_reads_back_as_the_file_provider(legacy_db):
    """No backfill: an upgrading install keeps exactly its current behaviour."""
    await _migrate(legacy_db)

    con = sqlite3.connect(legacy_db)
    row = con.execute(
        "SELECT openrouter_api_key, web_search_provider, memory_provider,"
        " hindsight_base_url, hindsight_api_key, hindsight_config FROM app_config"
    ).fetchone()
    con.close()

    # Pre-existing settings untouched.
    assert row[0] == "sk-existing"
    assert row[1] == "tavily"
    # Nothing invented for memory.
    assert row[2] is None
    assert row[3] is None
    assert row[4] is None
    assert row[5] in (None, "{}")

    # And that state resolves to file memory — the pre-upgrade behaviour.
    cfg = AppConfig(memory_provider=row[2])
    assert hs.resolve_provider(cfg) == "file"
    assert hs.resolve_hindsight_config(cfg, get_settings()) is None


async def test_the_migration_is_idempotent(legacy_db):
    await _migrate(legacy_db)
    await _migrate(legacy_db)  # a second boot must not fail on existing columns
    assert set(MEMORY_COLUMNS) <= await _columns(legacy_db)


async def test_a_fresh_schema_already_has_the_columns(tmp_path):
    path = tmp_path / "fresh.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
    finally:
        await engine.dispose()

    assert set(MEMORY_COLUMNS) <= await _columns(path)
    await _migrate(path)
    assert set(MEMORY_COLUMNS) <= await _columns(path)
