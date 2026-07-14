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

    subagent_cols = await columns("subagents")
    if "builtin_name" not in subagent_cols:
        await conn.execute(text("ALTER TABLE subagents ADD COLUMN builtin_name VARCHAR"))

    app_config_cols = await columns("app_config")
    if "deep_defaults" not in app_config_cols:
        await conn.execute(
            text("ALTER TABLE app_config ADD COLUMN deep_defaults JSON DEFAULT '{}'")
        )
    if "goal_evaluator_model" not in app_config_cols:
        await conn.execute(
            text("ALTER TABLE app_config ADD COLUMN goal_evaluator_model VARCHAR")
        )

    # Goal-mode columns on threads (all default to a benign "chat"/idle state so
    # existing rows keep behaving exactly as before).
    thread_cols = await columns("threads")
    thread_additions = {
        "mode": "ALTER TABLE threads ADD COLUMN mode VARCHAR DEFAULT 'chat'",
        "goal": "ALTER TABLE threads ADD COLUMN goal VARCHAR DEFAULT ''",
        "success_criteria": (
            "ALTER TABLE threads ADD COLUMN success_criteria VARCHAR DEFAULT ''"
        ),
        "goal_status": "ALTER TABLE threads ADD COLUMN goal_status VARCHAR DEFAULT 'idle'",
        "iteration": "ALTER TABLE threads ADD COLUMN iteration INTEGER DEFAULT 0",
        "max_iterations": "ALTER TABLE threads ADD COLUMN max_iterations INTEGER DEFAULT 25",
        "require_plan_approval": (
            "ALTER TABLE threads ADD COLUMN require_plan_approval BOOLEAN DEFAULT 1"
        ),
        "last_reason": "ALTER TABLE threads ADD COLUMN last_reason VARCHAR DEFAULT ''",
        "todos_snapshot": "ALTER TABLE threads ADD COLUMN todos_snapshot JSON DEFAULT '[]'",
    }
    for col, ddl in thread_additions.items():
        if col not in thread_cols:
            await conn.execute(text(ddl))


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency that yields a database session per request."""
    async with async_session_factory() as session:
        yield session
