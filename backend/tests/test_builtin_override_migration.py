"""Built-in override rows survive the drop of the ``builtin_name`` column.

Overriding a built-in subagent used to mean an editable copy stored as a
``Subagent`` row with ``builtin_name`` set, which won over the library default at
build time. That concept is gone (a built-in is now just on/off), but a user's
edits are not: each override row becomes an ordinary subagent and the library
built-in it was replacing is added to ``deep_defaults["disabled_builtins"]`` — so
the effective roster is unchanged and there are no duplicate names.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel import SQLModel

from app.db import models  # noqa: F401  (registers tables on SQLModel.metadata)
from app.db.session import _apply_lightweight_migrations


async def _legacy_db(path: Path, *, with_app_config: bool) -> None:
    """A database shaped like an override-era install.

    Starts from the real schema (the other lightweight migrations expect every
    table to exist), then walks ``subagents`` back by re-adding the column this
    migration exists to remove.
    """
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
            await conn.execute(
                text("ALTER TABLE subagents ADD COLUMN builtin_name VARCHAR")
            )
    finally:
        await engine.dispose()

    con = sqlite3.connect(path)
    con.executemany(
        "INSERT INTO subagents (id, created_at, updated_at, name, description,"
        " instructions, include_todo, include_subagents, include_skills,"
        " include_memory, include_plan, web_search, include_video, include_image,"
        " thinking, tool_choice, enabled, extra_config, builtin_name)"
        " VALUES (?, datetime('now'), datetime('now'), ?, ?, ?,"
        " 1, 0, 1, 0, 0, 0, 0, 0, 'off', 'auto', 1, '{}', ?)",
        [
            ("o1", "general-purpose", "my gp", "do it my way", "general-purpose"),
            ("u1", "writer", "a writer", "write", None),
        ],
    )
    if with_app_config:
        con.execute(
            "INSERT INTO app_config (id, created_at, updated_at, deep_defaults,"
            " hindsight_config, default_agents)"
            " VALUES ('cfg', datetime('now'), datetime('now'), ?, '{}', '{}')",
            (json.dumps({"max_nesting_depth": 2, "disabled_builtins": ["research"]}),),
        )
    con.commit()
    con.close()


async def _migrate(path: Path) -> tuple[list[dict], list[dict], set[str]]:
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await _apply_lightweight_migrations(conn)
        async with engine.connect() as conn:
            subagents = (
                await conn.execute(
                    text("SELECT id, name, description, instructions FROM subagents"
                         " ORDER BY id")
                )
            ).all()
            configs = (
                await conn.execute(text("SELECT id, deep_defaults FROM app_config"))
            ).all()
            cols = {
                r[1]
                for r in (await conn.exec_driver_sql("PRAGMA table_info(subagents)")).all()
            }
    finally:
        await engine.dispose()
    return (
        [
            {"id": r[0], "name": r[1], "description": r[2], "instructions": r[3]}
            for r in subagents
        ],
        [{"id": r[0], "deep_defaults": json.loads(r[1] or "{}")} for r in configs],
        cols,
    )


@pytest.fixture
async def legacy_db(tmp_path):
    path = tmp_path / "legacy.db"
    await _legacy_db(path, with_app_config=True)
    return path


async def test_override_row_becomes_an_ordinary_subagent(legacy_db):
    subagents, configs, cols = await _migrate(legacy_db)

    assert "builtin_name" not in cols
    # The user's edits survive verbatim, now visible in the normal roster.
    assert {
        "id": "o1",
        "name": "general-purpose",
        "description": "my gp",
        "instructions": "do it my way",
    } in subagents
    assert {s["name"] for s in subagents} == {"general-purpose", "writer"}

    # ...and the library built-in it replaced is switched off, so the promoted copy
    # is the only "general-purpose" in the roster — exactly today's behaviour.
    (config,) = configs
    assert set(config["deep_defaults"]["disabled_builtins"]) == {
        "research",
        "general-purpose",
    }
    # Unrelated keys in the blob are preserved.
    assert config["deep_defaults"]["max_nesting_depth"] == 2


async def test_migration_is_idempotent(legacy_db):
    await _migrate(legacy_db)

    # A second boot must not re-disable a built-in the user has since turned back on.
    con = sqlite3.connect(legacy_db)
    con.execute(
        "UPDATE app_config SET deep_defaults = ?",
        (json.dumps({"disabled_builtins": []}),),
    )
    con.commit()
    con.close()

    _subagents, configs, cols = await _migrate(legacy_db)
    assert "builtin_name" not in cols
    assert configs[0]["deep_defaults"]["disabled_builtins"] == []


async def test_no_app_config_row_gets_one(tmp_path):
    """An install can hold overrides without ever having touched app settings."""
    path = tmp_path / "no-config.db"
    await _legacy_db(path, with_app_config=False)

    _subagents, configs, cols = await _migrate(path)

    assert "builtin_name" not in cols
    (config,) = configs
    assert config["deep_defaults"]["disabled_builtins"] == ["general-purpose"]


async def test_fresh_schema_needs_no_migration(tmp_path):
    """No ``builtin_name`` column, so the whole block is skipped."""
    path = tmp_path / "fresh.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
    finally:
        await engine.dispose()

    subagents, configs, cols = await _migrate(path)
    assert "builtin_name" not in cols
    assert subagents == []
    assert configs == []
