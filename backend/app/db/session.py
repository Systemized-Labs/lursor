"""Async database engine and session management.

Uses SQLModel over an async SQLite engine (aiosqlite). For the MVP the schema is
created with ``create_all`` on startup; swap in Alembic migrations once the
schema stabilizes.
"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel

from app.config import get_settings

settings = get_settings()

# How long a connection waits for a peer to release its lock before raising
# "database is locked". Dev runs routinely have a second backend alive (Electron
# restarts it on reload; the old detached process group lingers a moment), and
# startup DDL holds a write lock for longer than SQLite's 5s default allows.
_BUSY_TIMEOUT_MS = 30_000

engine = create_async_engine(settings.database_url, echo=settings.debug, future=True)


@event.listens_for(engine.sync_engine, "connect")
def _set_sqlite_pragmas(dbapi_conn, _record) -> None:
    """Put every connection in WAL mode with a generous busy timeout.

    Rollback-journal mode (SQLite's default) takes a file-level exclusive lock on
    write, so one backend reading blocks another writing and startup dies with
    ``OperationalError: database is locked``. WAL lets readers and a writer
    coexist; the busy timeout absorbs the writer-vs-writer overlap that is left.
    """
    cursor = dbapi_conn.cursor()
    try:
        # Order matters: ``journal_mode=WAL`` needs the write lock itself, so the
        # timeout has to be armed first or this very statement is what dies with
        # "database is locked" against a busy peer.
        cursor.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
        cursor.execute("PRAGMA journal_mode=WAL")
        # WAL's default (FULL) fsyncs on every commit; NORMAL is the standard WAL
        # pairing and still crash-safe, losing at most the last commits on power
        # loss rather than corrupting the file.
        cursor.execute("PRAGMA synchronous=NORMAL")
    finally:
        cursor.close()

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
    # ``scope`` is dormant since the assignment model landed (see below); it is
    # still created here so the backfill has something to read on an older DB.
    if "scope" not in skill_cols:
        await conn.execute(
            text("ALTER TABLE skills ADD COLUMN scope VARCHAR DEFAULT 'global'")
        )
    if "workspace_id" not in skill_cols:
        await conn.execute(text("ALTER TABLE skills ADD COLUMN workspace_id VARCHAR"))
    # Assignment model: a skill is either ``managed`` (canonical store, reach set
    # by ``is_global`` + the ``skill_workspaces`` links) or ``local`` (lives in
    # ``<workspace>/.agents/skills``, applies only there). Backfill off the legacy
    # ``scope`` column so an existing install keeps behaving identically: global
    # skills stay global, workspace skills stay exactly where they are on disk.
    # Nothing is moved and no assignment is invented.
    skill_additions = {
        "origin": "ALTER TABLE skills ADD COLUMN origin VARCHAR DEFAULT 'managed'",
        "is_global": "ALTER TABLE skills ADD COLUMN is_global BOOLEAN DEFAULT 0",
    }
    added_assignment_cols = [c for c in skill_additions if c not in skill_cols]
    for col in added_assignment_cols:
        await conn.execute(text(skill_additions[col]))
    if added_assignment_cols and "scope" in skill_cols:
        # Only on the migrating step, so a user who later parks a global skill
        # (is_global=0) doesn't get it silently re-globalized on the next boot.
        await conn.execute(
            text(
                "UPDATE skills SET origin = CASE WHEN scope = 'workspace' "
                "THEN 'local' ELSE 'managed' END, "
                "is_global = CASE WHEN scope = 'workspace' THEN 0 ELSE 1 END"
            )
        )

    # Which root a skill folder lives in, now that a workspace has several
    # candidates (``.agents/skills`` plus the other tools' conventions) and
    # personal roots (``~/.agents/skills`` …) are indexed too. Runs after the origin
    # backfill above so ``origin`` is guaranteed to exist: every pre-existing local
    # row came from the one root there was.
    if "root" not in skill_cols:
        await conn.execute(text("ALTER TABLE skills ADD COLUMN root VARCHAR DEFAULT ''"))
        await conn.execute(
            text("UPDATE skills SET root = '.agents/skills' WHERE origin = 'local'")
        )
    await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_skills_root ON skills (root)"))
    # Per-skill off switch. Existing rows default to on, so an upgrade changes
    # nothing about what loads.
    if "enabled" not in skill_cols:
        await conn.execute(
            text("ALTER TABLE skills ADD COLUMN enabled BOOLEAN DEFAULT 1")
        )

    # Linked catalog entries: ``<catalog>/<slug>`` is a symlink into another tool's
    # directory and ``link_target`` records where it points.
    #
    # Adding it is also the one-shot gate for globalizing existing ``external``
    # rows. Those were in scope everywhere *regardless* of ``is_global``, which the
    # indexer had left at 0; now that the user layer honours the assignment, an
    # un-backfilled row would silently stop loading on upgrade. Gated on the column
    # having just been added so a user who later narrows or parks a personal skill
    # doesn't get it re-globalized on the next boot.
    if "link_target" not in skill_cols:
        await conn.execute(
            text("ALTER TABLE skills ADD COLUMN link_target VARCHAR DEFAULT ''")
        )
        await conn.execute(
            text("UPDATE skills SET is_global = 1 WHERE origin = 'external'")
        )

    # Skills are no longer linked per-agent/subagent — membership is derived from
    # scope. Drop the join tables; existing links are intentionally discarded (the
    # global scope now applies to every agent). SQLite ignores DROP on a missing
    # table only with IF EXISTS.
    await conn.execute(text("DROP TABLE IF EXISTS agent_skills"))
    await conn.execute(text("DROP TABLE IF EXISTS subagent_skills"))

    subagent_cols = await columns("subagents")
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
        "include_video": (
            "ALTER TABLE subagents ADD COLUMN include_video BOOLEAN DEFAULT 0"
        ),
        "include_image": (
            "ALTER TABLE subagents ADD COLUMN include_image BOOLEAN DEFAULT 0"
        ),
        "thinking": "ALTER TABLE subagents ADD COLUMN thinking VARCHAR DEFAULT 'off'",
        "tool_choice": "ALTER TABLE subagents ADD COLUMN tool_choice VARCHAR DEFAULT 'auto'",
        "extra_config": "ALTER TABLE subagents ADD COLUMN extra_config JSON DEFAULT '{}'",
        "enabled": "ALTER TABLE subagents ADD COLUMN enabled BOOLEAN DEFAULT 1",
        # Per-row context-compaction overrides. Left NULL, so every existing
        # subagent keeps running on the app-wide defaults.
        "compaction_threshold": (
            "ALTER TABLE subagents ADD COLUMN compaction_threshold FLOAT"
        ),
        "compaction_ratio": "ALTER TABLE subagents ADD COLUMN compaction_ratio FLOAT",
    }
    for col, ddl in subagent_additions.items():
        if col not in subagent_cols:
            await conn.execute(text(ddl))

    # Built-in overrides are gone: a built-in subagent is now a plain on/off toggle,
    # and "override a built-in" is spelled "disable it + create a subagent" (which
    # can express strictly more). Don't discard a user's edits — promote each
    # override row to an ordinary subagent and disable the library built-in it was
    # replacing. That preserves today's effective behaviour (the copy won at build
    # time) with no duplicate names in the roster.
    if "builtin_name" in subagent_cols:
        await _retire_builtin_overrides(conn)
        # Drop the index first: SQLite's DROP COLUMN doesn't always clean up an
        # index defined on the dropped column, which leaves a dangling index
        # that breaks every later statement touching this table.
        await conn.execute(text("DROP INDEX IF EXISTS ix_subagents_builtin_name"))
        # SQLite >= 3.35. Guarded on the column being present, so idempotent.
        await conn.execute(text("ALTER TABLE subagents DROP COLUMN builtin_name"))

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
    # Per-agent video generation toggle (see ``agents/video_tools.py``). Defaults to
    # 0: existing agents must opt in, because a clip is minutes of GPU time on a
    # connected box and nobody should discover that by accident after an upgrade.
    if "include_video" not in agent_cols:
        await conn.execute(
            text("ALTER TABLE agents ADD COLUMN include_video BOOLEAN DEFAULT 0")
        )
    # Per-agent image generation toggle (see ``agents/image_tools.py``). Also 0, and
    # deliberately not backfilled from ``include_video``: they are separate consents,
    # and an upgrade that reads one as the other would hand a capability to agents
    # whose operator never asked for it.
    if "include_image" not in agent_cols:
        await conn.execute(
            text("ALTER TABLE agents ADD COLUMN include_image BOOLEAN DEFAULT 0")
        )
    # Per-agent context-compaction overrides (see ``agents/context_budget.py``).
    # NULL means "use the app-wide default", so an upgrade changes nothing.
    agent_additions = {
        "compaction_threshold": (
            "ALTER TABLE agents ADD COLUMN compaction_threshold FLOAT"
        ),
        "compaction_ratio": "ALTER TABLE agents ADD COLUMN compaction_ratio FLOAT",
    }
    for col, ddl in agent_additions.items():
        if col not in agent_cols:
            await conn.execute(text(ddl))

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
        # Memory provider + Hindsight connection. A NULL ``memory_provider``
        # means "file", so an existing install upgrades to exactly its current
        # behaviour and no backfill is needed.
        "memory_provider": "ALTER TABLE app_config ADD COLUMN memory_provider VARCHAR",
        "hindsight_base_url": (
            "ALTER TABLE app_config ADD COLUMN hindsight_base_url VARCHAR"
        ),
        "hindsight_api_key": (
            "ALTER TABLE app_config ADD COLUMN hindsight_api_key VARCHAR"
        ),
        "hindsight_config": (
            "ALTER TABLE app_config ADD COLUMN hindsight_config JSON DEFAULT '{}'"
        ),
        # App-wide compaction defaults set from the Settings page. NULL means "use
        # the process settings", which is what every existing install already did.
        "compaction_threshold": (
            "ALTER TABLE app_config ADD COLUMN compaction_threshold FLOAT"
        ),
        "compaction_ratio": "ALTER TABLE app_config ADD COLUMN compaction_ratio FLOAT",
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
        # The schedule whose fire opened this conversation (see ``Schedule``).
        # Existing rows stay NULL and behave exactly as today: human-started.
        "schedule_id": "ALTER TABLE threads ADD COLUMN schedule_id VARCHAR",
    }
    for col, ddl in thread_additions.items():
        if col not in thread_cols:
            await conn.execute(text(ddl))
    # ``create_all`` builds this index for a fresh DB but never retrofits it onto
    # an existing table, and the sidebar's conversation list filters on it.
    await conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_threads_schedule_id ON threads (schedule_id)")
    )
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

    # Sidebar grouping: which folder a workspace is filed under and where it sits
    # among its siblings. Existing rows land at the root, ordered by creation —
    # which is exactly the order the sidebar was already showing, so an upgrade
    # doesn't reshuffle anyone's list.
    workspace_cols = await columns("workspaces")
    if "folder_id" not in workspace_cols:
        await conn.execute(text("ALTER TABLE workspaces ADD COLUMN folder_id VARCHAR"))
    await conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_workspaces_folder_id "
            "ON workspaces (folder_id)"
        )
    )
    if "position" not in workspace_cols:
        await conn.execute(
            text("ALTER TABLE workspaces ADD COLUMN position INTEGER DEFAULT 0")
        )
        await conn.execute(
            text(
                "UPDATE workspaces SET position = (SELECT COUNT(*) FROM workspaces "
                "AS earlier WHERE earlier.created_at < workspaces.created_at)"
            )
        )

    # Manually-listed model IDs for providers that don't expose ``/models``.
    # Existing rows default to "" and keep relying on discovery alone.
    provider_cols = await columns("custom_providers")
    if "manual_models" not in provider_cols:
        await conn.execute(
            text("ALTER TABLE custom_providers ADD COLUMN manual_models VARCHAR DEFAULT ''")
        )


async def _retire_builtin_overrides(conn) -> None:
    """Turn built-in override rows into ordinary subagents, disabling the built-in.

    One half of dropping the ``builtin_name`` column (see the caller). Called only
    while the column still exists, so it runs exactly once per install.
    """
    from app.db.models import _now, _uuid

    names = [
        row[0]
        for row in (
            await conn.exec_driver_sql(
                "SELECT DISTINCT builtin_name FROM subagents "
                "WHERE builtin_name IS NOT NULL AND builtin_name != ''"
            )
        ).all()
    ]
    if not names:
        return

    # The row becomes a plain user subagent: same name, description, instructions
    # and model, now visible and editable in the roster like anything else.
    await conn.execute(
        text("UPDATE subagents SET builtin_name = NULL WHERE builtin_name IS NOT NULL")
    )

    rows = (await conn.exec_driver_sql("SELECT id, deep_defaults FROM app_config")).all()
    if not rows:
        # SQLite's DATETIME storage format, so the ORM can read these back.
        now = _now().replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S.%f")
        # The other JSON blobs are written explicitly: readers do ``dict(...)`` on
        # them, which a NULL would break.
        await conn.exec_driver_sql(
            "INSERT INTO app_config "
            "(id, deep_defaults, hindsight_config, default_agents, "
            "created_at, updated_at) VALUES (?, ?, '{}', '{}', ?, ?)",
            (_uuid(), json.dumps({"disabled_builtins": names}), now, now),
        )
        return

    for cfg_id, blob in rows:
        try:
            defaults = json.loads(blob) if blob else {}
        except (TypeError, ValueError):
            defaults = {}
        if not isinstance(defaults, dict):
            defaults = {}
        disabled = defaults.get("disabled_builtins")
        disabled = list(disabled) if isinstance(disabled, list) else []
        defaults["disabled_builtins"] = disabled + [
            n for n in names if n not in disabled
        ]
        await conn.exec_driver_sql(
            "UPDATE app_config SET deep_defaults = ? WHERE id = ?",
            (json.dumps(defaults), cfg_id),
        )


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency that yields a database session per request."""
    async with async_session_factory() as session:
        yield session
