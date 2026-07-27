"""Async database engine and session management.

Uses SQLModel over an async SQLite engine (aiosqlite). For the MVP the schema is
created with ``create_all`` on startup; swap in Alembic migrations once the
schema stabilizes.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel

from app.config import get_settings

settings = get_settings()

engine = create_async_engine(settings.database_url, echo=settings.debug, future=True)

async_session_factory = async_sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False
)


async def init_db() -> None:
    """Create all tables. Import models first so they register on metadata."""
    from app.db import models  # noqa: F401  (registers tables on SQLModel.metadata)

    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
        await _apply_lightweight_migrations(conn)


async def _apply_lightweight_migrations(conn) -> None:
    """Add columns that ``create_all`` can't retrofit onto existing tables.

    ``create_all`` only creates missing tables, never alters existing ones, so a
    column added to a model after a table already exists needs an explicit
    ``ADD COLUMN``. Kept idempotent (checked against ``PRAGMA table_info``) until
    the schema graduates to Alembic.
    """
    async def columns(table: str) -> set[str]:
        rows = (await conn.exec_driver_sql(f"PRAGMA table_info({table})")).all()
        return {row[1] for row in rows}

    message_cols = await columns("messages")
    if "attachments" not in message_cols:
        await conn.execute(
            text("ALTER TABLE messages ADD COLUMN attachments JSON DEFAULT '[]'")
        )
    if "kind" not in message_cols:
        await conn.execute(
            text("ALTER TABLE messages ADD COLUMN kind VARCHAR DEFAULT 'chat'")
        )
    # ``/compact`` marks superseded messages hidden rather than deleting them.
    if "compacted" not in message_cols:
        await conn.execute(
            text("ALTER TABLE messages ADD COLUMN compacted BOOLEAN DEFAULT 0")
        )
    # Per-message agent provenance (which agent ran the turn). Existing rows stay
    # NULL/"" and render no agent chip.
    if "agent_id" not in message_cols:
        await conn.execute(text("ALTER TABLE messages ADD COLUMN agent_id VARCHAR"))
    if "agent_name" not in message_cols:
        await conn.execute(
            text("ALTER TABLE messages ADD COLUMN agent_name VARCHAR DEFAULT ''")
        )

    skill_cols = await columns("skills")
    if "slug" not in skill_cols:
        await conn.execute(text("ALTER TABLE skills ADD COLUMN slug VARCHAR DEFAULT ''"))
    # Scope columns for the global/workspace skill split. Existing rows are all
    # global (they came from the single flat skills dir), so backfill scope.
    if "scope" not in skill_cols:
        await conn.execute(
            text("ALTER TABLE skills ADD COLUMN scope VARCHAR DEFAULT 'global'")
        )
    if "workspace_id" not in skill_cols:
        await conn.execute(text("ALTER TABLE skills ADD COLUMN workspace_id VARCHAR"))

    # Skills are no longer linked per-agent/subagent — membership is derived from
    # scope. Drop the join tables; existing links are intentionally discarded (the
    # global scope now applies to every agent). SQLite ignores DROP on a missing
    # table only with IF EXISTS.
    await conn.execute(text("DROP TABLE IF EXISTS agent_skills"))
    await conn.execute(text("DROP TABLE IF EXISTS subagent_skills"))

    subagent_cols = await columns("subagents")
    if "builtin_name" not in subagent_cols:
        await conn.execute(text("ALTER TABLE subagents ADD COLUMN builtin_name VARCHAR"))
    # Full deep-agent parity knobs on subagents. Defaults match the model so
    # existing rows keep behaving as before (skills on, everything else off).
    subagent_additions = {
        "include_todo": "ALTER TABLE subagents ADD COLUMN include_todo BOOLEAN DEFAULT 1",
        "include_subagents": (
            "ALTER TABLE subagents ADD COLUMN include_subagents BOOLEAN DEFAULT 0"
        ),
        "include_skills": (
            "ALTER TABLE subagents ADD COLUMN include_skills BOOLEAN DEFAULT 1"
        ),
        "include_memory": (
            "ALTER TABLE subagents ADD COLUMN include_memory BOOLEAN DEFAULT 0"
        ),
        "include_plan": "ALTER TABLE subagents ADD COLUMN include_plan BOOLEAN DEFAULT 0",
        "web_search": "ALTER TABLE subagents ADD COLUMN web_search BOOLEAN DEFAULT 0",
        "thinking": "ALTER TABLE subagents ADD COLUMN thinking VARCHAR DEFAULT 'off'",
        "tool_choice": "ALTER TABLE subagents ADD COLUMN tool_choice VARCHAR DEFAULT 'auto'",
        "extra_config": "ALTER TABLE subagents ADD COLUMN extra_config JSON DEFAULT '{}'",
        "enabled": "ALTER TABLE subagents ADD COLUMN enabled BOOLEAN DEFAULT 1",
    }
    for col, ddl in subagent_additions.items():
        if col not in subagent_cols:
            await conn.execute(text(ddl))

    agent_cols = await columns("agents")
    if "tool_choice" not in agent_cols:
        await conn.execute(
            text("ALTER TABLE agents ADD COLUMN tool_choice VARCHAR DEFAULT 'auto'")
        )
    # Per-agent browser-QA toggle. Defaults to 1 so existing agents keep receiving
    # browser tools exactly as before (still gated by settings.browser_qa_enabled).
    if "browser_qa" not in agent_cols:
        await conn.execute(
            text("ALTER TABLE agents ADD COLUMN browser_qa BOOLEAN DEFAULT 1")
        )

    app_config_cols = await columns("app_config")
    if "deep_defaults" not in app_config_cols:
        await conn.execute(
            text("ALTER TABLE app_config ADD COLUMN deep_defaults JSON DEFAULT '{}'")
        )
    if "goal_evaluator_model" not in app_config_cols:
        await conn.execute(
            text("ALTER TABLE app_config ADD COLUMN goal_evaluator_model VARCHAR")
        )
    if "compaction_model" not in app_config_cols:
        await conn.execute(
            text("ALTER TABLE app_config ADD COLUMN compaction_model VARCHAR")
        )
    if "default_agents" not in app_config_cols:
        await conn.execute(
            text("ALTER TABLE app_config ADD COLUMN default_agents JSON DEFAULT '{}'")
        )
    app_config_additions = {
        "web_search_provider": (
            "ALTER TABLE app_config ADD COLUMN web_search_provider VARCHAR"
        ),
        "tavily_api_key": "ALTER TABLE app_config ADD COLUMN tavily_api_key VARCHAR",
        "exa_api_key": "ALTER TABLE app_config ADD COLUMN exa_api_key VARCHAR",
    }
    for col, ddl in app_config_additions.items():
        if col not in app_config_cols:
            await conn.execute(text(ddl))

    # Plan/goal columns on threads (all default to a benign "chat"/idle state so
    # existing rows keep behaving exactly as before). ``status`` is the generalized
    # run lifecycle (was ``goal_status`` before the slash-command refactor);
    # ``require_plan_approval`` was dropped (plan mode replaces the approval gate).
    thread_cols = await columns("threads")
    thread_additions = {
        "mode": "ALTER TABLE threads ADD COLUMN mode VARCHAR DEFAULT 'chat'",
        "goal": "ALTER TABLE threads ADD COLUMN goal VARCHAR DEFAULT ''",
        "success_criteria": (
            "ALTER TABLE threads ADD COLUMN success_criteria VARCHAR DEFAULT ''"
        ),
        "status": "ALTER TABLE threads ADD COLUMN status VARCHAR DEFAULT 'idle'",
        "plan_path": "ALTER TABLE threads ADD COLUMN plan_path VARCHAR DEFAULT ''",
        "iteration": "ALTER TABLE threads ADD COLUMN iteration INTEGER DEFAULT 0",
        "max_iterations": "ALTER TABLE threads ADD COLUMN max_iterations INTEGER DEFAULT 25",
        "last_reason": "ALTER TABLE threads ADD COLUMN last_reason VARCHAR DEFAULT ''",
        "todos_snapshot": "ALTER TABLE threads ADD COLUMN todos_snapshot JSON DEFAULT '[]'",
    }
    for col, ddl in thread_additions.items():
        if col not in thread_cols:
            await conn.execute(text(ddl))
    # Carry old goal-mode state onto the renamed ``status`` column, then drop the
    # legacy NOT NULL columns. Leaving them in place breaks INSERTs: the ORM no
    # longer writes ``goal_status`` / ``require_plan_approval``, and SQLite rejects
    # NULL for those constraints.
    if "goal_status" in thread_cols:
        await conn.execute(
            text("UPDATE threads SET status = goal_status WHERE goal_status IS NOT NULL")
        )
        await conn.execute(text("ALTER TABLE threads DROP COLUMN goal_status"))
    if "require_plan_approval" in thread_cols:
        await conn.execute(text("ALTER TABLE threads DROP COLUMN require_plan_approval"))

    # Manually-listed model IDs for providers that don't expose ``/models``.
    # Existing rows default to "" and keep relying on discovery alone.
    provider_cols = await columns("custom_providers")
    if "manual_models" not in provider_cols:
        await conn.execute(
            text("ALTER TABLE custom_providers ADD COLUMN manual_models VARCHAR DEFAULT ''")
        )


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency that yields a database session per request."""
    async with async_session_factory() as session:
        yield session
