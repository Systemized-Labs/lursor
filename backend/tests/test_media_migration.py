"""The media-source columns land on boot, and an upgrade changes nothing.

Three tables gain columns through ``db/session._apply_lightweight_migrations``:
``app_config`` learns which source generates images and clips, and
``image_generations`` / ``video_jobs`` learn which source produced each row and
what it cost.

The property under test is that **an existing install keeps behaving exactly as
it did**. Every generation that predates this change came from a laios box, so
``provider`` has to backfill to ``'laios'`` rather than to NULL — a NULL there
would make an old run indistinguishable from an OpenRouter one and route its
content fetch at the wrong upstream. In the other direction, all four
``app_config`` columns must stay NULL, because NULL is what "laios, cheapest
available" means and anything else would silently move someone's generation onto
a paid API on upgrade.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel import SQLModel

from app.db import models  # noqa: F401  (registers tables on SQLModel.metadata)
from app.db.session import _apply_lightweight_migrations

# The columns this migration adds, per table.
_ADDED = {
    "app_config": ("image_source", "video_source", "image_model", "video_model"),
    "image_generations": ("provider", "cost_usd"),
    "video_jobs": ("provider", "cost_usd", "content_url"),
}


async def _pre_media_db(path: Path) -> None:
    """A database shaped like the build before a media source could be chosen."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
            for table, columns in _ADDED.items():
                # ``provider`` is indexed on a fresh schema, and SQLite refuses to
                # drop a column an index still references.
                await conn.execute(text(f"DROP INDEX IF EXISTS ix_{table}_provider"))
                for column in columns:
                    await conn.execute(
                        text(f"ALTER TABLE {table} DROP COLUMN {column}")
                    )
    finally:
        await engine.dispose()

    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO app_config (id, created_at, updated_at, hindsight_config,"
        " default_agents, deep_defaults)"
        " VALUES ('cfg', datetime('now'), datetime('now'), '{}', '{}', '{}')"
    )
    # Two finished generations and one clip, as an upgrading install would have
    # them: all from a box, none with a price.
    con.executemany(
        "INSERT INTO image_generations (id, created_at, updated_at, connection_id,"
        " model, prompt, request, status)"
        " VALUES (?, datetime('now'), datetime('now'), 'conn-1', ?, 'a cat', '{}',"
        " 'completed')",
        [("img-1", "z-image-turbo"), ("img-2", "qwen-image-2512")],
    )
    con.execute(
        "INSERT INTO video_jobs (id, created_at, updated_at, connection_id, job_id,"
        " model, prompt, task, request, status)"
        " VALUES ('vid-1', datetime('now'), datetime('now'), 'conn-1', 'vid_abc',"
        " 'minimax-h3', 'a cat', 't2va', '{}', 'completed')"
    )
    con.commit()
    con.close()


async def _migrate(path: Path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await _apply_lightweight_migrations(conn)
    finally:
        await engine.dispose()


def _rows(path: Path, sql: str) -> list[tuple]:
    con = sqlite3.connect(path)
    try:
        return con.execute(sql).fetchall()
    finally:
        con.close()


@pytest.fixture
async def legacy_db(tmp_path):
    path = tmp_path / "pre-media.db"
    await _pre_media_db(path)
    return path


async def test_every_column_lands(legacy_db):
    await _migrate(legacy_db)
    con = sqlite3.connect(legacy_db)
    try:
        for table, columns in _ADDED.items():
            present = {
                row[1] for row in con.execute(f"PRAGMA table_info({table})").fetchall()
            }
            assert set(columns) <= present, f"{table} is missing {set(columns) - present}"
    finally:
        con.close()


async def test_existing_generations_are_attributed_to_laios(legacy_db):
    """Not NULL: an old row must not be mistaken for an OpenRouter one."""
    await _migrate(legacy_db)
    assert _rows(legacy_db, "SELECT id, provider, cost_usd FROM image_generations"
                            " ORDER BY id") == [
        ("img-1", "laios", None),
        ("img-2", "laios", None),
    ]
    assert _rows(
        legacy_db, "SELECT id, provider, cost_usd, content_url FROM video_jobs"
    ) == [("vid-1", "laios", None, None)]


async def test_the_source_setting_starts_unset(legacy_db):
    """All four NULL is what 'laios, cheapest available' means — today's behaviour."""
    await _migrate(legacy_db)
    assert _rows(
        legacy_db,
        "SELECT image_source, video_source, image_model, video_model FROM app_config",
    ) == [(None, None, None, None)]


async def test_a_deliberate_choice_survives_a_second_boot(legacy_db):
    await _migrate(legacy_db)

    con = sqlite3.connect(legacy_db)
    con.execute(
        "UPDATE app_config SET image_source = 'openrouter',"
        " image_model = 'openrouter:google/gemini-2.5-flash-image'"
    )
    con.commit()
    con.close()

    await _migrate(legacy_db)  # second boot
    assert _rows(legacy_db, "SELECT image_source, image_model, video_source FROM app_config") == [
        ("openrouter", "openrouter:google/gemini-2.5-flash-image", None)
    ]


async def test_openrouter_rows_keep_their_empty_connection(legacy_db):
    """``connection_id = ''`` is the non-laios marker, and must not be rewritten."""
    await _migrate(legacy_db)

    con = sqlite3.connect(legacy_db)
    con.execute(
        "INSERT INTO image_generations (id, created_at, updated_at, provider,"
        " connection_id, model, prompt, request, status, cost_usd)"
        " VALUES ('img-or', datetime('now'), datetime('now'), 'openrouter', '',"
        " 'google/gemini-2.5-flash-image', 'a cat', '{}', 'completed', 0.031)"
    )
    con.commit()
    con.close()

    await _migrate(legacy_db)
    assert _rows(
        legacy_db,
        "SELECT provider, connection_id, cost_usd FROM image_generations"
        " WHERE id = 'img-or'",
    ) == [("openrouter", "", 0.031)]


async def test_migration_is_a_no_op_on_a_fresh_schema(tmp_path):
    path = tmp_path / "fresh.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
    finally:
        await engine.dispose()

    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO image_generations (id, created_at, updated_at, provider,"
        " connection_id, model, prompt, request, status)"
        " VALUES ('img-1', datetime('now'), datetime('now'), 'openrouter', '',"
        " 'x/y', 'a cat', '{}', 'running')"
    )
    con.commit()
    con.close()

    await _migrate(path)
    assert _rows(path, "SELECT provider FROM image_generations") == [("openrouter",)]
