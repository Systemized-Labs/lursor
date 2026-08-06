"""``agents.include_video`` is added on boot, and every existing agent stays off.

The column lands through the additive lightweight-migration path
(``db/session._apply_lightweight_migrations``), so a database written by the previous
build has to gain it on the next start. There is deliberately **no backfill**: a clip
is minutes of GPU time on someone's box, and an upgrade that silently handed every
existing agent the ability to spend it would be the wrong default. "Everyone keeps
their tools, nobody gains this one" is the whole correctness argument, and it has to
survive a second boot — including one where the user has since turned the flag on.
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

# Two populated agents, as an upgrading install would have them: one maximal, one
# minimal, so a backfill that keyed off any other flag would show up here.
LEGACY_AGENTS = [
    ("a-full", "Builder", 1, 1, 1, 1, 1, 1, 1),
    ("a-bare", "Asker", 0, 0, 0, 0, 0, 0, 0),
]

# Every NOT NULL column on ``agents``, since SQLite applies no Python-side default.
_INSERT = (
    "INSERT INTO agents (id, created_at, updated_at, name, description,"
    " instructions, include_todo, include_subagents, include_skills,"
    " include_memory, include_plan, web_search, browser_qa, include_image,"
    " thinking, tool_choice, extra_config"
)


async def _pre_video_db(path: Path) -> None:
    """A database shaped like the build before video generation existed."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
            await conn.execute(text("ALTER TABLE agents DROP COLUMN include_video"))
    finally:
        await engine.dispose()

    con = sqlite3.connect(path)
    con.executemany(
        f"{_INSERT})"
        " VALUES (?, datetime('now'), datetime('now'), ?, '', '', ?, ?, ?, ?, ?, ?,"
        " ?, 0, 'off', 'auto', '{}')",
        LEGACY_AGENTS,
    )
    con.commit()
    con.close()


async def _migrate(path: Path) -> dict[str, int | None]:
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await _apply_lightweight_migrations(conn)
        async with engine.connect() as conn:
            rows = (
                await conn.execute(
                    text("SELECT id, include_video FROM agents ORDER BY id")
                )
            ).all()
    finally:
        await engine.dispose()
    return {row[0]: row[1] for row in rows}


@pytest.fixture
async def legacy_db(tmp_path):
    path = tmp_path / "pre-video.db"
    await _pre_video_db(path)
    return path


async def test_column_is_added_and_every_existing_agent_is_off(legacy_db):
    flags = await _migrate(legacy_db)
    assert set(flags) == {"a-bare", "a-full"}
    assert all(not value for value in flags.values()), (
        "an upgrade must not hand an existing agent minutes of someone's GPU time"
    )


async def test_migration_is_idempotent_and_keeps_a_deliberate_opt_in(legacy_db):
    await _migrate(legacy_db)

    # The user turns it on for one agent.
    con = sqlite3.connect(legacy_db)
    con.execute("UPDATE agents SET include_video = 1 WHERE id = 'a-full'")
    con.commit()
    con.close()

    flags = await _migrate(legacy_db)  # second boot
    assert flags["a-full"] == 1, "a second boot must not reset a deliberate choice"
    assert not flags["a-bare"]


async def test_migration_is_a_no_op_on_a_fresh_schema(tmp_path):
    """A DB created with the column present needs (and gets) no ALTER."""
    path = tmp_path / "fresh.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
    finally:
        await engine.dispose()

    con = sqlite3.connect(path)
    con.execute(
        f"{_INSERT}, include_video)"
        " VALUES ('a1', datetime('now'), datetime('now'), 'New', '', '', 1, 0, 1, 0,"
        " 0, 0, 1, 0, 'off', 'auto', '{}', 1)"
    )
    con.commit()
    con.close()

    assert (await _migrate(path))["a1"] == 1
