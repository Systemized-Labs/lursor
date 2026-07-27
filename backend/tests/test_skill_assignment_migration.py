"""The assignment columns backfill correctly off the legacy ``scope`` column.

An existing install must keep behaving identically after the upgrade: skills that
were global stay global, skills that lived in a workspace's ``.agents/skills``
stay exactly where they are (as ``local``), nothing moves on disk, and no
assignment is invented. The backfill must also run exactly once, so a user who
later parks a global skill doesn't find it re-globalized on the next boot.
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

LEGACY_ROWS = [
    ("g1", "global-one", "Global One", "global", None),
    ("g2", "global-two", "Global Two", "global", None),
    ("w1", "repo-skill", "Repo Skill", "workspace", "ws-123"),
]


async def _legacy_db(path: Path) -> None:
    """Build a database shaped like a scope-era install.

    Starts from the real schema (the other lightweight migrations expect every
    table to exist), then walks ``skills`` back to what the previous build had:
    a ``scope`` column, and no assignment columns.
    """
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
            # SQLite refuses to drop an indexed column, so the indexes go first.
            for stmt in (
                "DROP INDEX IF EXISTS ix_skills_origin",
                "DROP INDEX IF EXISTS ix_skills_is_global",
                "ALTER TABLE skills DROP COLUMN origin",
                "ALTER TABLE skills DROP COLUMN is_global",
                "ALTER TABLE skills ADD COLUMN scope VARCHAR DEFAULT 'global'",
            ):
                await conn.execute(text(stmt))
    finally:
        await engine.dispose()

    con = sqlite3.connect(path)
    con.executemany(
        "INSERT INTO skills (id, created_at, updated_at, slug, name, description,"
        " content, scope, workspace_id)"
        " VALUES (?, datetime('now'), datetime('now'), ?, ?, '', '', ?, ?)",
        LEGACY_ROWS,
    )
    con.commit()
    con.close()


async def _migrate(db_path: Path) -> list[dict]:
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    try:
        async with engine.begin() as conn:
            await _apply_lightweight_migrations(conn)
        async with engine.connect() as conn:
            rows = (
                await conn.execute(
                    text("SELECT id, origin, is_global, workspace_id FROM skills ORDER BY id")
                )
            ).all()
    finally:
        await engine.dispose()
    return [
        {"id": r[0], "origin": r[1], "is_global": bool(r[2]), "workspace_id": r[3]}
        for r in rows
    ]


@pytest.fixture
async def legacy_db(tmp_path):
    path = tmp_path / "legacy.db"
    await _legacy_db(path)
    return path


async def test_backfill_maps_scope_to_origin_and_assignment(legacy_db):
    rows = await _migrate(legacy_db)
    by_id = {r["id"]: r for r in rows}

    # Previously-global skills stay global, in the catalog.
    assert by_id["g1"] == {
        "id": "g1",
        "origin": "managed",
        "is_global": True,
        "workspace_id": None,
    }
    assert by_id["g2"]["is_global"] is True

    # A workspace skill becomes ``local`` and keeps pointing at its workspace: its
    # folder is already in that repo, so nothing is moved or reassigned.
    assert by_id["w1"] == {
        "id": "w1",
        "origin": "local",
        "is_global": False,
        "workspace_id": "ws-123",
    }


async def test_backfill_runs_once_and_respects_later_edits(legacy_db):
    await _migrate(legacy_db)

    # The user parks a formerly-global skill (is_global -> 0).
    con = sqlite3.connect(legacy_db)
    con.execute("UPDATE skills SET is_global = 0 WHERE id = 'g1'")
    con.commit()
    con.close()

    rows = await _migrate(legacy_db)  # second boot
    by_id = {r["id"]: r for r in rows}
    # Still parked: the backfill did not re-run off the dormant ``scope`` column.
    assert by_id["g1"]["is_global"] is False
    assert by_id["g2"]["is_global"] is True


async def test_migration_is_idempotent_on_a_fresh_schema(tmp_path):
    """A DB created with the new columns present needs (and gets) no backfill."""
    path = tmp_path / "fresh.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
    finally:
        await engine.dispose()

    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO skills (id, created_at, updated_at, slug, name, description,"
        " content, origin, is_global)"
        " VALUES ('n1', datetime('now'), datetime('now'), 'new', 'New', '', '', 'managed', 0)"
    )
    con.commit()
    con.close()

    rows = await _migrate(path)
    # Untouched: no backfill overwrote the row's own assignment.
    assert rows == [
        {"id": "n1", "origin": "managed", "is_global": False, "workspace_id": None}
    ]
