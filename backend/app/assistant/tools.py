"""The Assistant's control-plane tools — the ones no other agent can hold.

Each tool is a thin wrapper over an **existing route handler**. That is not
laziness: there is no service layer in this repo (``app/service.py`` is the
daemon installer), so the handlers under ``app/api/`` *are* the business logic.
Calling ``workspaces.create_workspace(payload, session)`` reuses its validation,
its 400s, its ordering side effects and its system-workspace guards for free,
and means a rule added to the HTTP surface applies here on the same commit. The
alternative — hand-written SQL per tool — would be a second implementation that
silently drifts.

Two things every tool does differently from an HTTP caller:

**It opens its own session.** The request-scoped session that built the agent is
closed the moment the response starts streaming, but a run is a detached task
that outlives it (``agents/chat_run_manager.py``). Using the build-time session
inside a tool would be a use-after-close on the first turn that calls one, so
each call takes a fresh session from ``async_session_factory``.

**It turns ``HTTPException`` into text.** :func:`_call` renders FastAPI's 422
``detail`` list into one line that names the offending field, which is the one
piece of Hermes worth copying wholesale
(``integrations/hermes/lursor/client.py``). A raised exception here would be
caught by ``ToolErrorsAsText`` anyway, but as a stack-shaped blob the model then
has to interpret.

Naming: every tool is prefixed ``lursor_``. The prefix is what makes a leak
legible — a control-plane tool showing up in an unrelated agent's roster is
obvious at a glance — and it keeps these out of the namespace of the ~50
deep-agent tools they sit beside.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.agents.chat_run_manager import chat_run_manager
from app.api import agents as agents_api
from app.api import analytics as analytics_api
from app.api import chat as chat_api
from app.api import models as models_api
from app.api import providers as providers_api
from app.api import schedules as schedules_api
from app.api import settings as settings_api
from app.api import skills as skills_api
from app.api import subagents as subagents_api
from app.api import threads as threads_api
from app.api import workspaces as workspaces_api
from app.assistant.confirm import confirmations
from app.assistant.identity import (
    ASSISTANT_AGENT_ID,
    ASSISTANT_WORKSPACE_ID,
    DEFAULT_ASSISTANT_MODEL,
)
from app.assistant.registry import ASSISTANT_DESTRUCTIVE_TOOLS, assert_registry_matches
from app.config import get_settings
from app.db.models import (
    Agent,
    AppConfig,
    Message,
    Schedule,
    ScheduleRunType,
    Thread,
    Workspace,
)
from app.db.session import async_session_factory
from app.schemas.agent import AgentCreate, AgentUpdate
from app.schemas.schedule import CronPreviewRequest, ScheduleCreate, ScheduleUpdate
from app.schemas.workspace import WorkspaceCreate, WorkspaceUpdate
from app.workspace_paths import is_skills_catalog

settings = get_settings()

# What ``lursor_update_settings`` is allowed to touch. An allowlist, not a
# blocklist: ``AppConfig`` grows, and a new column must not become writable by an
# agent just because nobody remembered to add it to a denial list.
_WRITABLE_SETTINGS = frozenset(
    {
        "web_search_provider",
        "memory_provider",
        "compaction_model",
        "compaction_threshold",
        "compaction_ratio",
        "goal_evaluator_model",
        "assistant_model",
        "image_source",
        "video_source",
        "image_model",
        "video_model",
    }
)


# --- plumbing -------------------------------------------------------------------


def _format_detail(exc: HTTPException) -> str:
    """Render an ``HTTPException`` detail as one readable line.

    FastAPI's 422 detail is a list of ``{loc, msg, type}`` dicts. Handed to a
    model raw it reads as noise; named by field it is actionable.
    """
    detail = exc.detail
    if isinstance(detail, list):
        parts = []
        for item in detail:
            if isinstance(item, dict):
                loc = ".".join(str(p) for p in item.get("loc", []) if p != "body")
                parts.append(f"{loc or 'request'}: {item.get('msg', '')}".strip())
            else:
                parts.append(str(item))
        return "; ".join(parts)
    return str(detail)


async def _call(fn: Callable[[AsyncSession], Awaitable[Any]]) -> Any:
    """Run ``fn`` against a fresh session, converting HTTP errors into text.

    Returns either the handler's result or a ``str`` beginning with ``"Error:"``.
    Callers that need to distinguish the two check ``isinstance(result, str)``.
    """
    async with async_session_factory() as session:
        try:
            return await fn(session)
        except HTTPException as exc:
            return f"Error ({exc.status_code}): {_format_detail(exc)}"
        except ValueError as exc:
            # Pydantic validation on a schema we constructed by hand.
            return f"Error: {exc}"


def _dump(value: Any) -> str:
    """Serialize a handler result for the model. Compact, but still JSON."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return json.dumps([_plain(v) for v in value], default=str)
    return json.dumps(_plain(value), default=str)


def _plain(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    return value


def _protected_workspace(ws: Workspace) -> str | None:
    """Why ``ws`` may not be changed, or ``None`` if it may."""
    if ws.id == ASSISTANT_WORKSPACE_ID:
        return "That is my own workspace — I can't delete or relocate it."
    if is_skills_catalog(ws.path):
        return "That is the Skill Studio, which the app owns and cannot remove."
    return None


# --- the toolset ----------------------------------------------------------------


def build_assistant_tools(thread_id: str) -> list[Callable[..., Awaitable[str]]]:
    """Build the control-plane tools for one run.

    ``thread_id`` is closed over rather than read from a ``RunContext`` because
    the confirmation protocol publishes into *this* thread's event stream, and
    the run's deps carry no thread id.
    """

    async def _confirm(action: str, summary: str, impact: str) -> bool:
        return await confirmations.request(
            thread_id, action=action, summary=summary, impact=impact
        )

    # --- workspaces ---------------------------------------------------------

    async def lursor_list_workspaces() -> str:
        """List every workspace in Lursor: id, name, description and path.

        Start here for anything workspace-shaped — you need an id for most other
        workspace and schedule tools, and names are not unique.
        """
        result = await _call(lambda s: workspaces_api.list_workspaces(s))
        if isinstance(result, str):
            return result
        return _dump(
            [
                {
                    "id": w.id,
                    "name": w.name,
                    "description": w.description,
                    "path": w.path,
                    "is_system": w.is_system,
                }
                for w in result
                if w.id != ASSISTANT_WORKSPACE_ID
            ]
        )

    async def lursor_create_workspace(
        name: str, description: str = "", path: str | None = None
    ) -> str:
        """Create a workspace.

        Args:
            name: What to call it in the sidebar.
            description: Optional one-liner shown under the name.
            path: Absolute directory to use. Leave empty to have Lursor make one
                under its workspaces folder, named after ``name``. ``~`` is
                expanded. An existing directory is adopted, not overwritten.
        """
        payload = WorkspaceCreate(name=name, description=description, path=path)
        result = await _call(lambda s: workspaces_api.create_workspace(payload, s))
        if isinstance(result, str):
            return result
        return f"Created workspace \"{result.name}\" (id {result.id}) at {result.path}"

    async def lursor_update_workspace(
        workspace_id: str,
        name: str | None = None,
        description: str | None = None,
        path: str | None = None,
    ) -> str:
        """Rename, re-describe or relocate a workspace. Omitted fields are left alone.

        Args:
            workspace_id: From ``lursor_list_workspaces``.
            name: New name, or omit to keep the current one.
            description: New description, or omit to keep the current one.
            path: New absolute directory. Moving a workspace does not move files.
        """

        async def run(s: AsyncSession) -> Any:
            ws = await s.get(Workspace, workspace_id)
            if ws is None:
                return f"Error: no workspace with id {workspace_id}"
            if path is not None and (reason := _protected_workspace(ws)):
                return f"Error: {reason}"
            payload = WorkspaceUpdate(name=name, description=description, path=path)
            return await workspaces_api.update_workspace(workspace_id, payload, s)

        result = await _call(run)
        if isinstance(result, str):
            return result
        return f"Updated workspace \"{result.name}\" (id {result.id}) at {result.path}"

    async def lursor_delete_workspace(workspace_id: str) -> str:
        """Remove a workspace from Lursor. Asks the user to confirm first.

        The directory on disk is left exactly where it is — only the Lursor
        registration and its conversations go. Say so when you report the result.

        Args:
            workspace_id: From ``lursor_list_workspaces``.
        """

        async def load(s: AsyncSession) -> Any:
            ws = await s.get(Workspace, workspace_id)
            if ws is None:
                return f"Error: no workspace with id {workspace_id}"
            if reason := _protected_workspace(ws):
                return f"Error: {reason}"
            count = len(
                (
                    await s.execute(select(Thread).where(Thread.workspace_id == workspace_id))
                )
                .scalars()
                .all()
            )
            return (ws.name, ws.path, count)

        loaded = await _call(load)
        if isinstance(loaded, str):
            return loaded
        name, ws_path, thread_count = loaded

        approved = await _confirm(
            "lursor_delete_workspace",
            f'Delete the workspace "{name}"',
            f"{thread_count} conversation(s) go with it. The directory at "
            f"{ws_path} stays on disk.",
        )
        if not approved:
            return "Not confirmed — nothing was changed."

        result = await _call(lambda s: workspaces_api.delete_workspace(workspace_id, s))
        if isinstance(result, str):
            return result
        return (
            f'Deleted workspace "{name}" and its {thread_count} conversation(s). '
            f"The files at {ws_path} are untouched."
        )

    # --- agents -------------------------------------------------------------

    async def lursor_list_agents() -> str:
        """List every configured agent: id, name, model and feature flags.

        A null model means the agent inherits the app default. Use this to find
        the id for ``lursor_update_agent``.
        """
        result = await _call(lambda s: agents_api.list_agents(s))
        if isinstance(result, str):
            return result
        return _dump(
            [
                {
                    "id": a.id,
                    "name": a.name,
                    "description": a.description,
                    "model": a.model or f"(inherits {settings.default_model})",
                    "include_subagents": a.include_subagents,
                    "include_skills": a.include_skills,
                    "web_search": a.web_search,
                    "browser_qa": a.browser_qa,
                    "thinking": a.thinking,
                }
                for a in result
                if a.id != ASSISTANT_AGENT_ID
            ]
        )

    async def lursor_create_agent(
        name: str,
        instructions: str,
        description: str = "",
        model: str | None = None,
        include_subagents: bool = False,
        include_skills: bool = True,
        include_memory: bool = False,
        web_search: bool = False,
    ) -> str:
        """Create an agent.

        Args:
            name: What to call it.
            instructions: Its system prompt. Write a real one — this is the
                agent's whole character.
            description: Optional one-liner for the picker.
            model: A model string from ``lursor_list_models``
                (``openrouter:<slug>`` or ``custom:<provider>:<model>``). Leave
                empty to inherit the app default.
            include_subagents: Let it delegate to subagents.
            include_skills: Let it discover skills in scope.
            include_memory: Give it persistent memory.
            web_search: Give it web search.
        """
        payload = AgentCreate(
            name=name,
            description=description,
            model=model,
            instructions=instructions,
            include_subagents=include_subagents,
            include_skills=include_skills,
            include_memory=include_memory,
            web_search=web_search,
        )
        result = await _call(lambda s: agents_api.create_agent(payload, s))
        if isinstance(result, str):
            return result
        on = result.model or "the app default"
        return f'Created agent "{result.name}" (id {result.id}) on {on}'

    async def lursor_update_agent(
        agent_id: str,
        model: str | None = None,
        name: str | None = None,
        description: str | None = None,
        instructions: str | None = None,
        include_subagents: bool | None = None,
        include_skills: bool | None = None,
        include_memory: bool | None = None,
        web_search: bool | None = None,
        browser_qa: bool | None = None,
    ) -> str:
        """Change an agent's configuration. Omitted fields are left alone.

        This is how you retarget an agent's model: pass ``agent_id`` and
        ``model`` and nothing else.

        Args:
            agent_id: From ``lursor_list_agents``.
            model: New model string from ``lursor_list_models``.
            name: New name.
            description: New description.
            instructions: New system prompt. This replaces the whole prompt —
                read the current one first if you mean to amend it.
            include_subagents: Toggle subagent delegation.
            include_skills: Toggle skill discovery.
            include_memory: Toggle persistent memory.
            web_search: Toggle web search.
            browser_qa: Toggle the headless browser.
        """
        if agent_id == ASSISTANT_AGENT_ID:
            return (
                "Error: that is me. My model is set in Settings → Model → Assistant, "
                "not through this tool."
            )
        fields = {
            "model": model,
            "name": name,
            "description": description,
            "instructions": instructions,
            "include_subagents": include_subagents,
            "include_skills": include_skills,
            "include_memory": include_memory,
            "web_search": web_search,
            "browser_qa": browser_qa,
        }
        given = {k: v for k, v in fields.items() if v is not None}
        if not given:
            return "Error: nothing to change — pass at least one field."
        # ``exclude_unset`` in the route is what makes "omitted means untouched"
        # work, so the payload has to be constructed from only what was given.
        payload = AgentUpdate.model_construct(**given)
        payload.__pydantic_fields_set__ = set(given)
        result = await _call(lambda s: agents_api.update_agent(agent_id, payload, s))
        if isinstance(result, str):
            return result
        changed = ", ".join(f"{k}={v!r}" for k, v in given.items())
        return f'Updated agent "{result.name}" (id {result.id}): {changed}'

    async def lursor_delete_agent(agent_id: str) -> str:
        """Delete an agent. Asks the user to confirm first.

        Args:
            agent_id: From ``lursor_list_agents``.
        """
        if agent_id == ASSISTANT_AGENT_ID:
            return "Error: I can't delete myself."

        async def load(s: AsyncSession) -> Any:
            agent = await s.get(Agent, agent_id)
            if agent is None:
                return f"Error: no agent with id {agent_id}"
            threads = len(
                (await s.execute(select(Thread).where(Thread.agent_id == agent_id)))
                .scalars()
                .all()
            )
            scheds = len(
                (await s.execute(select(Schedule).where(Schedule.agent_id == agent_id)))
                .scalars()
                .all()
            )
            return (agent.name, threads, scheds)

        loaded = await _call(load)
        if isinstance(loaded, str):
            return loaded
        name, threads, scheds = loaded

        approved = await _confirm(
            "lursor_delete_agent",
            f'Delete the agent "{name}"',
            f"{threads} conversation(s) and {scheds} schedule(s) point at it.",
        )
        if not approved:
            return "Not confirmed — nothing was changed."

        result = await _call(lambda s: agents_api.delete_agent(agent_id, s))
        if isinstance(result, str):
            return result
        return f'Deleted agent "{name}".'

    # --- schedules ----------------------------------------------------------

    async def lursor_list_schedules(workspace_id: str | None = None) -> str:
        """List schedules, optionally narrowed to one workspace.

        Args:
            workspace_id: Restrict to this workspace, or omit for all of them.
        """
        result = await _call(lambda s: schedules_api.list_schedules(workspace_id, s))
        if isinstance(result, str):
            return result
        return _dump(result)

    async def lursor_create_schedule(
        name: str,
        workspace_id: str,
        agent_id: str,
        cron: str,
        prompt: str,
        timezone: str = "UTC",
        description: str = "",
        run_type: str = "chat",
        success_criteria: str = "",
        max_iterations: int = 25,
    ) -> str:
        """Create a recurring job. The cron is previewed before anything is saved.

        Args:
            name: What to call the schedule.
            workspace_id: Where each fire runs. From ``lursor_list_workspaces``.
            agent_id: Which agent runs it. From ``lursor_list_agents``.
            cron: A 5-field cron expression, e.g. ``0 9 * * 1-5``.
            prompt: The turn each fire sends. This is the actual instruction.
            timezone: IANA name, e.g. ``Europe/London``. DST is handled.
            description: Optional one-liner.
            run_type: ``chat`` for a single turn, ``goal`` for the self-continuing
                loop that runs until ``success_criteria`` is met.
            success_criteria: What "done" means, for a ``goal`` schedule.
            max_iterations: Hard cap on turns for a ``goal`` schedule (1-200).
        """
        # Preview first: a bad expression should be a readable error, not a
        # half-made row someone has to find and delete.
        preview = await _call(
            lambda _s: schedules_api.preview_cron(
                CronPreviewRequest(cron=cron, timezone=timezone, count=3)
            )
        )
        if isinstance(preview, str):
            return preview

        try:
            payload = ScheduleCreate(
                name=name,
                description=description,
                workspace_id=workspace_id,
                agent_id=agent_id,
                cron=cron,
                timezone=timezone,
                prompt=prompt,
                run_type=ScheduleRunType(run_type),
                success_criteria=success_criteria,
                max_iterations=max_iterations,
            )
        except ValueError as exc:
            return f"Error: {exc}"

        result = await _call(lambda s: schedules_api.create_schedule(payload, s))
        if isinstance(result, str):
            return result
        upcoming = ", ".join(o.isoformat() for o in preview.occurrences)
        return (
            f'Created schedule "{result.name}" (id {result.id}). '
            f"Next fires: {upcoming}"
        )

    async def lursor_update_schedule(
        schedule_id: str,
        enabled: bool | None = None,
        cron: str | None = None,
        timezone: str | None = None,
        prompt: str | None = None,
        name: str | None = None,
    ) -> str:
        """Change a schedule. Omitted fields are left alone.

        Pausing one is ``enabled=false``; it keeps its history and can be
        resumed.

        Args:
            schedule_id: From ``lursor_list_schedules``.
            enabled: Turn the schedule on or off.
            cron: New 5-field cron expression.
            timezone: New IANA timezone name.
            prompt: New turn to send on each fire.
            name: New name.
        """
        fields = {
            "enabled": enabled,
            "cron": cron,
            "timezone": timezone,
            "prompt": prompt,
            "name": name,
        }
        given = {k: v for k, v in fields.items() if v is not None}
        if not given:
            return "Error: nothing to change — pass at least one field."
        try:
            payload = ScheduleUpdate(**given)
        except ValueError as exc:
            return f"Error: {exc}"
        payload.__pydantic_fields_set__ = set(given)
        result = await _call(lambda s: schedules_api.update_schedule(schedule_id, payload, s))
        if isinstance(result, str):
            return result
        nxt = result.next_fire_at.isoformat() if result.next_fire_at else "never (disabled)"
        return f'Updated schedule "{result.name}". Next fire: {nxt}'

    async def lursor_run_schedule_now(schedule_id: str) -> str:
        """Fire a schedule immediately, without consuming its next slot.

        Args:
            schedule_id: From ``lursor_list_schedules``.
        """
        result = await _call(lambda s: schedules_api.run_schedule_now(schedule_id, s))
        if isinstance(result, str):
            return result
        return (
            f"Fired schedule {schedule_id}: status {result.status}"
            + (f", conversation {result.thread_id}" if result.thread_id else "")
        )

    async def lursor_delete_schedule(schedule_id: str) -> str:
        """Delete a schedule. Asks the user to confirm first.

        Past transcripts survive — only the schedule itself goes.

        Args:
            schedule_id: From ``lursor_list_schedules``.
        """

        async def load(s: AsyncSession) -> Any:
            row = await s.get(Schedule, schedule_id)
            if row is None:
                return f"Error: no schedule with id {schedule_id}"
            return (row.name, row.cron, row.timezone)

        loaded = await _call(load)
        if isinstance(loaded, str):
            return loaded
        name, cron, tz = loaded

        approved = await _confirm(
            "lursor_delete_schedule",
            f'Delete the schedule "{name}"',
            f"It runs on \"{cron}\" ({tz}). Past run transcripts are kept.",
        )
        if not approved:
            return "Not confirmed — nothing was changed."

        result = await _call(lambda s: schedules_api.delete_schedule(schedule_id, s))
        if isinstance(result, str):
            return result
        return f'Deleted schedule "{name}". Its past transcripts are still readable.'

    # --- conversations and runs ---------------------------------------------

    async def lursor_list_threads(workspace_id: str) -> str:
        """List the conversations in a workspace, newest first.

        Scheduled-fire transcripts are excluded, as they are in the UI.

        Args:
            workspace_id: From ``lursor_list_workspaces``.
        """
        result = await _call(
            lambda s: threads_api.list_threads(
                workspace_id=workspace_id, include_scheduled=False, session=s
            )
        )
        if isinstance(result, str):
            return result
        return _dump(
            [
                {
                    "id": t.id,
                    "title": t.title,
                    "agent_id": t.agent_id,
                    "status": t.status,
                    "updated_at": t.updated_at,
                }
                for t in result
            ]
        )

    async def lursor_read_thread(thread_id: str, limit: int = 20) -> str:
        """Read the most recent messages in a conversation.

        Args:
            thread_id: From ``lursor_list_threads``.
            limit: How many of the most recent messages to return.
        """
        result = await _call(lambda s: threads_api.list_messages(thread_id, s))
        if isinstance(result, str):
            return result
        recent = result[-limit:] if limit > 0 else result
        return _dump(
            [
                {"role": m.role, "content": (m.content or "")[:4000], "kind": m.kind}
                for m in recent
            ]
        )

    async def lursor_delegate(workspace_id: str, agent_id: str, prompt: str) -> str:
        """Start a run in another workspace and return immediately.

        This is how you get work done *inside* a project: your own file tools are
        rooted in your scratch directory, not the user's code. The run is
        detached — it keeps going after this returns. Poll it with
        ``lursor_run_status``.

        Args:
            workspace_id: Where the work happens. From ``lursor_list_workspaces``.
            agent_id: Who does it. From ``lursor_list_agents``.
            prompt: The instruction to send. Be specific and self-contained; the
                agent has none of this conversation's context.
        """
        if not prompt.strip():
            return "Error: a prompt is required."

        async def run(s: AsyncSession) -> Any:
            workspace = await s.get(Workspace, workspace_id)
            if workspace is None:
                return f"Error: no workspace with id {workspace_id}"
            agent = await s.get(Agent, agent_id)
            if agent is None:
                return f"Error: no agent with id {agent_id}"
            if agent_id == ASSISTANT_AGENT_ID:
                return "Error: I can't delegate to myself."
            thread = Thread(
                title=prompt.strip()[:60],
                workspace_id=workspace_id,
                agent_id=agent_id,
            )
            s.add(thread)
            await s.commit()
            await s.refresh(thread)
            await chat_api.start_scheduled_run(
                s,
                thread=thread,
                prompt=prompt,
                run_type=ScheduleRunType.chat,
                kind="delegated",
            )
            return (thread.id, workspace.name, agent.name)

        try:
            result = await _call(run)
        except RuntimeError as exc:
            return f"Error: {exc}"
        if isinstance(result, str):
            return result
        tid, ws_name, agent_name = result
        return (
            f'Started {agent_name} in "{ws_name}" — conversation {tid}. '
            "It is running now; check back with lursor_run_status."
        )

    async def lursor_run_status(thread_id: str | None = None) -> str:
        """Report which conversations have a run in flight.

        Args:
            thread_id: Ask about one conversation, or omit to list every live run.
        """
        active = await threads_api.list_active_runs()
        if thread_id is None:
            return _dump({"active_runs": active})
        return _dump({"thread_id": thread_id, "running": thread_id in active})

    async def lursor_stop_run(thread_id: str) -> str:
        """Stop the run in flight on a conversation.

        The partial output is kept — stopping is not undoing.

        Args:
            thread_id: From ``lursor_run_status`` or ``lursor_list_threads``.
        """
        stopped = await chat_run_manager.stop(thread_id)
        return "Stopped the run." if stopped else "No run was active on that conversation."

    async def lursor_delete_thread(thread_id: str) -> str:
        """Delete a conversation and its messages. Asks the user to confirm first.

        Args:
            thread_id: From ``lursor_list_threads``.
        """

        async def load(s: AsyncSession) -> Any:
            thread = await s.get(Thread, thread_id)
            if thread is None:
                return f"Error: no conversation with id {thread_id}"
            if thread.workspace_id == ASSISTANT_WORKSPACE_ID:
                return "Error: that is one of our own conversations."
            count = len(
                (await s.execute(select(Message).where(Message.thread_id == thread_id)))
                .scalars()
                .all()
            )
            return (thread.title, count)

        loaded = await _call(load)
        if isinstance(loaded, str):
            return loaded
        title, count = loaded

        approved = await _confirm(
            "lursor_delete_thread",
            f'Delete the conversation "{title}"',
            f"{count} message(s) go with it. This cannot be undone.",
        )
        if not approved:
            return "Not confirmed — nothing was changed."

        result = await _call(lambda s: threads_api.delete_thread(thread_id, s))
        if isinstance(result, str):
            return result
        return f'Deleted the conversation "{title}" and its {count} message(s).'

    # --- configuration ------------------------------------------------------

    async def lursor_get_settings() -> str:
        """Read the app's settings.

        API keys come back only as a four-character hint (``…ab12``) — they are
        write-only by design, so do not claim to be able to read one.
        """

        async def run(s: AsyncSession) -> Any:
            cfg = (await s.execute(select(AppConfig))).scalars().first()
            return {
                "default_model": settings.default_model,
                "assistant_model": (
                    getattr(cfg, "assistant_model", None) or DEFAULT_ASSISTANT_MODEL
                ),
                "web_search_provider": getattr(cfg, "web_search_provider", None),
                "memory_provider": getattr(cfg, "memory_provider", None),
                "compaction_model": getattr(cfg, "compaction_model", None),
                "compaction_threshold": getattr(cfg, "compaction_threshold", None),
                "compaction_ratio": getattr(cfg, "compaction_ratio", None),
                "goal_evaluator_model": getattr(cfg, "goal_evaluator_model", None),
                "image_source": getattr(cfg, "image_source", None),
                "video_source": getattr(cfg, "video_source", None),
                "openrouter_api_key": settings_api._hint(
                    getattr(cfg, "openrouter_api_key", None)
                )
                or "(not set)",
                "tavily_api_key": settings_api._hint(getattr(cfg, "tavily_api_key", None))
                or "(not set)",
                "exa_api_key": settings_api._hint(getattr(cfg, "exa_api_key", None))
                or "(not set)",
            }

        return _dump(await _call(run))

    async def lursor_update_settings(key: str, value: str) -> str:
        """Change one app setting.

        Args:
            key: One of ``web_search_provider``, ``memory_provider``,
                ``compaction_model``, ``compaction_threshold``,
                ``compaction_ratio``, ``goal_evaluator_model``,
                ``assistant_model``, ``image_source``, ``video_source``,
                ``image_model``, ``video_model``. API keys are not settable here
                — those belong in the Settings UI.
            value: The new value, as text. Numbers are parsed; an empty string
                clears the setting.
        """
        if key not in _WRITABLE_SETTINGS:
            return (
                f"Error: \"{key}\" is not a setting I can change. "
                f"Try one of: {', '.join(sorted(_WRITABLE_SETTINGS))}."
            )

        async def run(s: AsyncSession) -> Any:
            cfg = (await s.execute(select(AppConfig))).scalars().first()
            if cfg is None:
                cfg = AppConfig()
                s.add(cfg)
            parsed: Any = value
            if value == "":
                parsed = None
            elif key in {"compaction_threshold", "compaction_ratio"}:
                try:
                    parsed = float(value)
                except ValueError:
                    return f"Error: {key} must be a number between 0 and 1."
                if not 0 < parsed <= 1:
                    return f"Error: {key} must be greater than 0 and at most 1."
            setattr(cfg, key, parsed)
            cfg.updated_at = datetime.now(UTC)
            s.add(cfg)
            await s.commit()
            return parsed

        result = await _call(run)
        if isinstance(result, str) and result.startswith("Error"):
            return result
        # The compaction knobs and the OpenRouter key are applied to the live
        # ``Settings`` object as well as persisted (``api/settings.py``), so a
        # change here has to go through the same path or it will not take effect
        # until the next restart.
        if key in {"compaction_threshold", "compaction_ratio"}:
            await settings_api.load_app_config()
        return f"Set {key} to {result if result is not None else '(cleared)'}."

    async def lursor_list_models() -> str:
        """List the model strings available to agents, grouped by provider.

        These are the exact values ``lursor_create_agent`` and
        ``lursor_update_agent`` expect.
        """
        result = await _call(lambda s: models_api.list_models(session=s))
        if isinstance(result, str):
            return result
        return _dump(result)

    async def lursor_list_providers() -> str:
        """List the configured custom (OpenAI-compatible) model providers."""
        result = await _call(lambda s: providers_api.list_providers(s))
        if isinstance(result, str):
            return result
        return _dump(result)

    # --- inventory ----------------------------------------------------------

    async def lursor_list_skills() -> str:
        """List the skills in the catalog and where each one is in scope."""
        result = await _call(lambda s: skills_api.list_skills(session=s))
        if isinstance(result, str):
            return result
        return _dump(result)

    async def lursor_list_subagents() -> str:
        """List the subagent roster available to agents that can delegate."""
        result = await _call(lambda s: subagents_api.list_subagents(s))
        if isinstance(result, str):
            return result
        return _dump(result)

    async def lursor_usage_report(workspace_id: str | None = None) -> str:
        """Report token and cost totals, overall and broken down by model.

        Args:
            workspace_id: Restrict to one workspace, or omit for the whole app.
        """
        filters = {
            "workspace_id": workspace_id,
            "model": None,
            "agent_id": None,
            "kind": None,
            "start": None,
            "end": None,
        }

        async def run(s: AsyncSession) -> Any:
            total = await analytics_api.usage_summary(filters, s)
            by_model = await analytics_api.usage_by_model(filters, s)
            return {"total": total, "by_model": by_model[:10]}

        return _dump(await _call(run))

    tools: list[Callable[..., Awaitable[str]]] = [
        lursor_list_workspaces,
        lursor_create_workspace,
        lursor_update_workspace,
        lursor_delete_workspace,
        lursor_list_agents,
        lursor_create_agent,
        lursor_update_agent,
        lursor_delete_agent,
        lursor_list_schedules,
        lursor_create_schedule,
        lursor_update_schedule,
        lursor_run_schedule_now,
        lursor_delete_schedule,
        lursor_list_threads,
        lursor_read_thread,
        lursor_delegate,
        lursor_run_status,
        lursor_stop_run,
        lursor_delete_thread,
        lursor_get_settings,
        lursor_update_settings,
        lursor_list_models,
        lursor_list_providers,
        lursor_list_skills,
        lursor_list_subagents,
        lursor_usage_report,
    ]

    # The boundary is only as good as its name list. Checked here, on every
    # build, so a tool added without updating ``registry.py`` fails immediately
    # and loudly instead of shipping unguarded.
    assert_registry_matches({t.__name__ for t in tools})
    assert ASSISTANT_DESTRUCTIVE_TOOLS <= {t.__name__ for t in tools}
    return tools
