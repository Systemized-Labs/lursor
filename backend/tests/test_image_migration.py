"""``agents.include_image`` is added on boot, and every existing agent stays off.

The column lands through the additive lightweight-migration path
(``db/session._apply_lightweight_migrations``), so a database written by the previous
build has to gain it on the next start.

There is deliberately **no backfill**, and specifically none from ``include_video``.
The cost argument is weaker than video's — an image is seconds of GPU, not minutes —
so the reason here is consent rather than spend: the two are separate capabilities,
and reading one as permission for the other would hand agents a tool their operator
never granted. "Everyone keeps their tools, nobody gains this one" has to survive a
second boot, including one where the user has since turned the flag on.
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
# minimal, so a backfill that keyed off any other flag would show up here. The
# trailing pair is (browser_qa, include_video) — ``a-video`` has video on and is the
# case that proves the two capabilities are not the same consent.
LEGACY_AGENTS = [
    ("a-full", "Builder", 1, 1, 1, 1, 1, 1, 1, 0),
    ("a-bare", "Asker", 0, 0, 0, 0, 0, 0, 0, 0),
    ("a-video", "Editor", 1, 1, 1, 0, 0, 0, 1, 1),
]

# Every NOT NULL column on ``agents``, since SQLite applies no Python-side default.
# ``include_video`` is in the list because the pre-image build already had it.
_INSERT = (
    "INSERT INTO agents (id, created_at, updated_at, name, description,"
    " instructions, include_todo, include_subagents, include_skills,"
    " include_memory, include_plan, web_search, browser_qa, include_video,"
    " thinking, tool_choice, extra_config"
)


async def _pre_image_db(path: Path) -> None:
    """A database shaped like the build before agent image generation existed."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
            await conn.execute(text("ALTER TABLE agents DROP COLUMN include_image"))
            await conn.execute(text("ALTER TABLE subagents DROP COLUMN include_image"))
    finally:
        await engine.dispose()

    con = sqlite3.connect(path)
    con.executemany(
        f"{_INSERT})"
        " VALUES (?, datetime('now'), datetime('now'), ?, '', '', ?, ?, ?, ?, ?, ?,"
        " ?, ?, 'off', 'auto', '{}')",
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
                    text("SELECT id, include_image FROM agents ORDER BY id")
                )
            ).all()
    finally:
        await engine.dispose()
    return {row[0]: row[1] for row in rows}


@pytest.fixture
async def legacy_db(tmp_path):
    path = tmp_path / "pre-image.db"
    await _pre_image_db(path)
    return path


async def test_column_is_added_and_every_existing_agent_is_off(legacy_db):
    flags = await _migrate(legacy_db)
    assert set(flags) == {"a-bare", "a-full", "a-video"}
    assert all(not value for value in flags.values()), (
        "an upgrade must not hand an existing agent a capability nobody granted"
    )


async def test_a_video_enabled_agent_does_not_inherit_image(legacy_db):
    """The two flags are separate consents, not one 'media generation' switch."""
    flags = await _migrate(legacy_db)
    assert not flags["a-video"]


async def test_migration_is_idempotent_and_keeps_a_deliberate_opt_in(legacy_db):
    await _migrate(legacy_db)

    # The user turns it on for one agent.
    con = sqlite3.connect(legacy_db)
    con.execute("UPDATE agents SET include_image = 1 WHERE id = 'a-full'")
    con.commit()
    con.close()

    flags = await _migrate(legacy_db)  # second boot
    assert flags["a-full"] == 1, "a second boot must not reset a deliberate choice"
    assert not flags["a-bare"]


async def test_the_subagent_column_lands_too(legacy_db):
    """A subagent's own flag is what lets it spend the parent's runtime."""
    await _migrate(legacy_db)
    engine = create_async_engine(f"sqlite+aiosqlite:///{legacy_db}")
    try:
        async with engine.connect() as conn:
            cols = {
                row[1]
                for row in (await conn.execute(text("PRAGMA table_info(subagents)"))).all()
            }
    finally:
        await engine.dispose()
    assert "include_image" in cols


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
        f"{_INSERT}, include_image)"
        " VALUES ('a1', datetime('now'), datetime('now'), 'New', '', '', 1, 0, 1, 0,"
        " 0, 0, 1, 0, 'off', 'auto', '{}', 1)"
    )
    con.commit()
    con.close()

    assert (await _migrate(path))["a1"] == 1
