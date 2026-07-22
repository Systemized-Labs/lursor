"""AG-UI chat endpoints (decoupled runs + reconnect).

``POST /threads/{id}/chat`` starts an agent run and returns an SSE stream. The
run is not driven by that response, though: it is spawned into the
:mod:`chat_run_manager` as a detached task, and the response merely *subscribes*
to it. That lets the browser disconnect (switch conversations, reload) without
killing the run, and later reconnect via ``GET /threads/{id}/stream`` to replay
buffered events and follow the live stream again.

The incoming user turn is persisted up front and the assistant turn on
completion (or a partial on stop) so threads reload cleanly.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime
from pathlib import Path

from ag_ui.core import (
    CustomEvent,
    EventType,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
)
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import ModelMessage
from pydantic_ai.ui.ag_ui import AGUIAdapter
from pydantic_ai.usage import UsageLimits
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select
from starlette.responses import StreamingResponse

from app.agents.browser_qa import wrap_evaluate_with_visual_qa
from app.agents.builder import build_deep_agent
from app.agents.chat_run_manager import chat_run_manager
from app.agents.compaction import summarize_thread
from app.agents.goal_loop import (
    AUTONOMOUS_KICKOFF,
    PLAN_DIR,
    build_continuation_adapter,
    build_goal_evaluator,
    build_steer_capability,
    detect_written_plan,
    drive_goal_loop,
    encode_goal_status_event,
    extract_success_criteria,
    messages_to_history,
    plan_doc_path,
    plan_execute_kickoff,
    planning_instruction,
    queue_interjection,
    read_plan_doc,
    refine_instruction,
    scan_plan_dir,
)
from app.agents.preview_service import preview_service
from app.agents.titler import generate_title
from app.agents.vision import model_supports_vision
from app.config import get_settings
from app.db.models import (
    Agent,
    AppConfig,
    CustomProvider,
    Message,
    Subagent,
    Thread,
    ThreadMode,
    ThreadStatus,
    UsageRecord,
    Workspace,
)
from app.db.session import async_session_factory, get_session
from app.media_store import media_path, save_base64_image
from app.pricing import compute_cost
from app.skills import store as skill_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/threads", tags=["chat"])

settings = get_settings()

# Strong references to in-flight auto-title tasks so the event loop doesn't
# garbage-collect a fire-and-forget task before it finishes.
_auto_title_tasks: set[asyncio.Task] = set()


def _schedule_auto_title(thread_id: str, user_text: str, placeholder: str) -> None:
    """Fire-and-forget: name a thread from its first message on a fast model.

    Runs in its own DB session (the request session closes with the streaming
    response) so it can proceed concurrently with the agent run. It only
    overwrites the title while it still equals ``placeholder`` — the truncated
    first message we set inline — so a manual rename mid-run always wins, and a
    second turn never re-triggers naming. All failures are swallowed: a missing
    title is cosmetic and must never disrupt the chat.
    """

    async def _run() -> None:
        try:
            async with async_session_factory() as bg_session:
                providers = (
                    await bg_session.execute(select(CustomProvider))
                ).scalars().all()
                custom_providers = {p.id: p for p in providers}
                title = await generate_title(
                    user_text, settings.default_title_model, custom_providers
                )
                if not title:
                    return
                thread = await bg_session.get(Thread, thread_id)
                if thread is None or thread.title != placeholder:
                    return
                thread.title = title
                bg_session.add(thread)
                await bg_session.commit()
        except Exception as exc:  # noqa: BLE001 — titling is best-effort, never fatal
            logger.warning("auto-title failed for thread %s: %s", thread_id, exc)

    with contextlib.suppress(RuntimeError):  # no running loop (e.g. under sync tests)
        task = asyncio.get_running_loop().create_task(_run())
        _auto_title_tasks.add(task)
        task.add_done_callback(_auto_title_tasks.discard)

_KEEPALIVE_TIMEOUT = 25.0  # seconds between ": keepalive" comments on an idle stream
# Cap on model request/tool-call rounds within a single agent turn. Overrides
# pydantic-ai's default of 50, which trips deep agents on tool-heavy turns before
# they can finish the work.
_MAX_TURN_REQUESTS = 150
_TEXT_DELTA_TYPES = {EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_CHUNK}
# Run-lifecycle events. A goal run drives many agent turns through one SSE
# stream, but the AG-UI client requires exactly one RUN_STARTED…RUN_FINISHED per
# stream — so we strip each per-turn pair and emit a single outer lifecycle
# around the whole goal run (see ``goal_driver``).
_LIFECYCLE_TYPES = {
    EventType.RUN_STARTED,
    EventType.RUN_FINISHED,
    EventType.RUN_ERROR,
}


def _encode_ag_ui_event(event) -> str:
    """SSE-frame any AG-UI event object (matches the adapter's own encoding)."""
    return f"data: {event.model_dump_json(by_alias=True, exclude_none=True)}\n\n"

# Name of the AG-UI CUSTOM event that carries the agent's live todo list. The
# deep agent's todo tools mutate ``deps.todos`` in place; we snapshot it after
# each streamed event and emit this whenever it changes so the UI can render a
# live task panel (see frontend `stream-reader`/`ChatTodoList`).
_TODOS_EVENT_NAME = "todos"


def _todos_snapshot(deps) -> list[dict]:
    """Serialize the run's current todo list into a JSON-friendly shape.

    Each item mirrors ``pydantic_ai_todo.Todo`` with the fields the UI needs,
    using ``activeForm`` (camelCase) to match the AG-UI wire convention.
    """
    todos = getattr(deps, "todos", None) or []
    return [
        {
            "id": t.id,
            "content": t.content,
            "status": t.status,
            "activeForm": t.active_form,
        }
        for t in todos
    ]


def _encode_todos_event(todos: list[dict]) -> str:
    """Encode a todo snapshot as an SSE-framed AG-UI CUSTOM event."""
    event = CustomEvent(
        type=EventType.CUSTOM, name=_TODOS_EVENT_NAME, value={"todos": todos}
    )
    return f"data: {event.model_dump_json(by_alias=True, exclude_none=True)}\n\n"


def _join_instructions(*parts: str | None) -> str | None:
    """Join non-empty run-scoped instruction blocks with blank lines."""
    kept = [p for p in parts if p]
    return "\n\n".join(kept) if kept else None


def _referenced_skill_instructions(
    slugs: list[str], workspace_path: str
) -> str | None:
    """Force-load the full body of every ``@``-referenced skill into this turn.

    Mirrors Claude Code's explicit skill invocation: when the user ``@``-references
    a skill in the composer, its whole ``SKILL.md`` body is injected into this
    turn's instructions so the agent is guaranteed to follow it — rather than
    relying on the agent to discover it via its skill tools. Each slug resolves
    against the same two scopes the builder uses — this workspace's
    ``.agents/skills`` first, then the user-global store — so a workspace skill
    wins a slug collision, matching ``skill_store.merged_skill_dirs``. Unknown or
    malformed slugs (the list is client-supplied) are skipped.
    """
    if not slugs:
        return None
    global_root = skill_store.global_skills_root()
    ws_root = skill_store.workspace_skills_root(workspace_path)
    sections: list[str] = []
    seen: set[str] = set()
    for slug in slugs:
        if slug in seen:
            continue
        seen.add(slug)
        parsed = None
        for root in (ws_root, global_root):  # workspace wins on collision
            with contextlib.suppress(ValueError):
                parsed = skill_store.read_skill(slug, root)
            if parsed is not None:
                break
        if parsed is None:
            continue
        sections.append(f"## {parsed.name}\n\n{parsed.content}".strip())
    if not sections:
        return None
    header = (
        "The user explicitly referenced the following skill(s) for this turn. "
        "Treat their instructions as directly in force now and follow them, using "
        "any bundled resources or scripts they describe:"
    )
    return "\n\n".join([header, *sections])


def _parse_user_turn(run_input: dict) -> tuple[str, list[dict]]:
    """Extract (text, images) from the newest user message of an AG-UI body.

    ``content`` is either a plain string or a list of typed parts (AG-UI
    multimodal). Returns the joined text plus a list of ingestible images,
    each ``{"b64", "mime", "filename"}`` (inline base64 sources only; remote
    URL sources are references we don't fetch here).
    """
    for msg in reversed(run_input.get("messages", []) or []):
        if msg.get("role") != "user":
            continue
        content = msg.get("content", "")
        if isinstance(content, str):
            return content, []
        texts: list[str] = []
        images: list[dict] = []
        for part in content or []:
            if not isinstance(part, dict):
                continue
            ptype = part.get("type")
            if ptype == "text":
                texts.append(part.get("text") or "")
            elif ptype == "image":
                src = part.get("source") or {}
                meta = part.get("metadata") or {}
                if src.get("type") == "data" and src.get("value"):
                    images.append(
                        {
                            "b64": src["value"],
                            "mime": src.get("mimeType") or "image/png",
                            "filename": meta.get("filename")
                            if isinstance(meta, dict)
                            else None,
                        }
                    )
            elif ptype == "binary" and part.get("data"):  # deprecated AG-UI shape
                images.append(
                    {
                        "b64": part["data"],
                        "mime": part.get("mimeType") or "image/png",
                        "filename": part.get("filename"),
                    }
                )
        return "\n".join(t for t in texts if t), images
    return "", []


def _strip_inline_images(run_input, note: str) -> None:
    """Replace the latest user message's content with plain text ``note``.

    Used when the agent's model has no native vision: the parsed image parts
    would otherwise reach a text-only chat API (which rejects them), so we drop
    them and point the agent at the on-disk copies via the note instead.
    """
    for msg in reversed(run_input.messages):
        if getattr(msg, "role", None) == "user":
            msg.content = note
            return


async def _thread_media_instructions(session: AsyncSession, thread_id: str) -> str | None:
    """An instructions section listing every image attached in the thread so the
    agent can inspect any of them (this turn or an earlier one) via view_image."""
    rows = (
        await session.execute(
            select(Message).where(Message.thread_id == thread_id)
        )
    ).scalars().all()
    entries: list[str] = []
    for m in rows:
        for att in m.attachments or []:
            path = media_path(thread_id, att["media_id"])
            if path.is_file():
                label = att.get("filename") or att["media_id"]
                entries.append(f"- {path} ({label})")
    if not entries:
        return None
    return (
        "## Attached media\n"
        "Image(s) attached in this conversation. Use the view_image tool with "
        "one of these paths to inspect its contents:\n" + "\n".join(entries)
    )


async def _persist_message(
    thread_id: str,
    role: str,
    content: str,
    *,
    tool_calls: list[dict] | None = None,
) -> None:
    """Append a message on its own background session (runs outside the request).

    A turn is worth persisting when it produced text *or* tool calls — a goal
    turn that ends on tool calls with no final text still has to survive reload,
    otherwise the thread reopens empty.
    """
    tool_calls = tool_calls or []
    if not content and not tool_calls:
        return
    async with async_session_factory() as bg_session:
        # Resolve the agent that produced this turn from the thread (runs outside
        # request scope, so the thread's current agent is the ground truth). Snapshot
        # the name so the transcript survives a later rename/delete.
        thread = await bg_session.get(Thread, thread_id)
        agent_id = thread.agent_id if thread is not None else None
        agent = await bg_session.get(Agent, agent_id) if agent_id else None
        bg_session.add(
            Message(
                thread_id=thread_id,
                role=role,
                content=content,
                tool_calls=tool_calls,
                agent_id=agent_id,
                agent_name=agent.name if agent is not None else "",
            )
        )
        # Bump the thread's activity clock so the sidebar sorts by "most recently
        # active" and can flag a finished reply the user hasn't opened yet.
        if thread is not None:
            thread.updated_at = datetime.now(UTC)
            bg_session.add(thread)
        await bg_session.commit()


async def _set_thread_state(
    thread_id: str,
    *,
    status: ThreadStatus | None = None,
    mode: ThreadMode | None = None,
    plan_path: str | None = None,
    iteration: int | None = None,
    last_reason: str | None = None,
    todos: list[dict] | None = None,
) -> None:
    """Persist plan/goal run progress to the thread row (own background session).

    Only non-``None`` fields are written, so partial updates (just a status, or
    just the latest todos) are cheap and don't clobber the rest.
    """
    async with async_session_factory() as bg_session:
        thread = await bg_session.get(Thread, thread_id)
        if thread is None:
            return
        if status is not None:
            thread.status = status
        if mode is not None:
            thread.mode = mode
        if plan_path is not None:
            thread.plan_path = plan_path
        if iteration is not None:
            thread.iteration = iteration
        if last_reason is not None:
            thread.last_reason = last_reason
        if todos is not None:
            thread.todos_snapshot = todos
        thread.updated_at = datetime.now(UTC)
        bg_session.add(thread)
        await bg_session.commit()


async def _persist_usage(thread_id: str, kind: str, usage) -> None:
    """Record one turn's token usage + cost (own background session).

    Resolves the workspace/agent/model from the thread so callers only supply the
    turn ``kind``. Best-effort: a missing thread, absent usage, or a pricing gap
    must never break a run, so failures are swallowed after logging.
    """
    if usage is None:
        return
    try:
        async with async_session_factory() as bg_session:
            thread = await bg_session.get(Thread, thread_id)
            if thread is None:
                return
            agent_row = await bg_session.get(Agent, thread.agent_id)
            model_str = (agent_row.model if agent_row else None) or settings.default_model

            cost = await compute_cost(model_str, usage)
            details = usage.details if isinstance(getattr(usage, "details", None), dict) else {}
            bg_session.add(
                UsageRecord(
                    thread_id=thread_id,
                    workspace_id=thread.workspace_id,
                    agent_id=thread.agent_id,
                    model=model_str,
                    kind=kind,
                    input_tokens=getattr(usage, "input_tokens", 0) or 0,
                    output_tokens=getattr(usage, "output_tokens", 0) or 0,
                    total_tokens=getattr(usage, "total_tokens", 0) or 0,
                    cache_read_tokens=getattr(usage, "cache_read_tokens", 0) or 0,
                    cache_write_tokens=getattr(usage, "cache_write_tokens", 0) or 0,
                    requests=getattr(usage, "requests", 0) or 0,
                    cost_usd=cost,
                    usage_details=details,
                )
            )
            await bg_session.commit()
    except Exception as exc:  # noqa: BLE001 — usage recording is best-effort
        logger.warning("usage: failed to persist for thread %s: %s", thread_id, exc)


def _collect_tool_call(event, etype, tool_calls: dict[str, dict]) -> None:
    """Fold one tool-call event into the per-turn ``tool_calls`` accumulator.

    Mirrors the frontend stream reader: START/CHUNK opens a call (and may carry
    the name + first args delta), ARGS appends JSON argument deltas, RESULT
    attaches the tool's return. Keyed by ``tool_call_id`` and insertion-ordered so
    the persisted list matches what streamed in live.
    """
    tid = getattr(event, "tool_call_id", None)
    if not tid:
        return
    call = tool_calls.setdefault(
        tid, {"id": tid, "name": "tool", "arguments": "", "result": None}
    )
    if etype in (EventType.TOOL_CALL_START, EventType.TOOL_CALL_CHUNK):
        name = getattr(event, "tool_call_name", None)
        if name:
            call["name"] = name
        delta = getattr(event, "delta", None)
        if delta:
            call["arguments"] += delta
    elif etype == EventType.TOOL_CALL_ARGS:
        delta = getattr(event, "delta", None)
        if delta:
            call["arguments"] += delta
    elif etype == EventType.TOOL_CALL_RESULT:
        call["result"] = getattr(event, "content", None)


async def _tee_events(
    stream: AsyncIterator,
    accumulated: list[str],
    tool_calls: dict[str, dict],
    *,
    strip_lifecycle: bool,
) -> AsyncIterator:
    """Pass events through, accumulating assistant text + tool calls for persist.

    ``accumulated`` gathers streamed text (used for the stop/cancel partial);
    ``tool_calls`` collects each tool call so the turn can be persisted with the
    same tool blocks the user watched — not just the final text.

    In goal mode (``strip_lifecycle``) the per-turn RUN_STARTED/FINISHED/ERROR
    events are dropped so the caller can wrap all turns in one outer lifecycle.
    """
    async for event in stream:
        etype = getattr(event, "type", None)
        if strip_lifecycle and etype in _LIFECYCLE_TYPES:
            continue
        if etype in _TEXT_DELTA_TYPES:
            delta = getattr(event, "delta", None)
            if delta:
                accumulated.append(delta)
        else:
            _collect_tool_call(event, etype, tool_calls)
        yield event


def _turn_content(streamed: str, result) -> str:
    """Pick the text to persist for an assistant turn.

    Prefer the streamed transcript — the concatenation of every text delta the
    user actually saw across *all* model rounds. ``result.output`` is only the
    final response's text, so any prose streamed before a tool call (and any turn
    whose final output is empty, e.g. a local reasoning model that answered then
    called a tool) would be dropped if we saved ``result.output`` instead. Fall
    back to ``result.output`` only when nothing streamed as text — e.g. a
    non-text/deferred-tool output object, or an abort before any text arrived
    (``result`` is ``None`` there, so the fallback is an empty string).
    """
    if streamed:
        return streamed
    if result is None:
        return ""
    output = getattr(result, "output", None)
    return output if isinstance(output, str) else str(output) if output else ""


async def _stream_turn(
    thread_id: str,
    turn_adapter: AGUIAdapter,
    deps,
    *,
    message_history: list[ModelMessage] | None,
    instructions: str | None,
    todos_state: dict,
    strip_lifecycle: bool = False,
    kind: str = "chat",
    capabilities: Sequence[AbstractCapability] | None = None,
) -> list[ModelMessage]:
    """Run one agent turn to completion, streaming events + todos to subscribers.

    Returns the full message history after the turn (``result.all_messages()``)
    so a goal loop can feed it into the next turn. ``todos_state`` carries the
    last-published todo JSON across a run's turns (``{"json": str | None}``).
    ``kind`` (chat | plan | goal) tags the usage row recorded on completion.

    The assistant turn is persisted from a ``finally`` so it survives *however*
    the stream ends — clean finish, stop/abort, or a model/tool error. We save the
    streamed transcript (the text the user actually saw, across every model round)
    plus the turn's tool calls, so a reloaded thread matches what streamed live and
    a stopped turn keeps its tool blocks (usage is only recorded when the run
    actually completed). See ``persist_turn`` for why this beats ``result.output``.
    """
    captured: dict[str, object] = {}
    # Per-turn buffers, filled as events flow through ``_tee_events``. ``text`` is
    # the streamed transcript (every text delta, all rounds) persisted as the turn's
    # content; ``tool_calls`` (keyed by id, insertion-ordered) is persisted with the
    # turn regardless of outcome. Both are turn-local so a multi-turn goal run
    # persists each turn separately instead of concatenating every prior turn.
    text: list[str] = []
    tool_calls: dict[str, dict] = {}
    persisted = False

    async def on_complete(result) -> None:
        # Only capture here — the tool-call accumulator isn't guaranteed complete
        # until the encode loop below has drained, so persistence happens after it.
        captured["result"] = result

    async def persist_turn() -> None:
        nonlocal persisted
        if persisted:
            return
        persisted = True
        result = captured.get("result")
        content = _turn_content("".join(text), result)
        await _persist_message(
            thread_id, "assistant", content, tool_calls=list(tool_calls.values())
        )
        if result is not None:
            # ``AgentRunResult.usage`` is a property (not a method) that returns the
            # run's ``RunUsage``; ``_persist_usage`` guards its own failures. Usage is
            # only known on a completed run, so skip it on abort/error.
            await _persist_usage(thread_id, kind, getattr(result, "usage", None))

    stream = turn_adapter.run_stream(
        message_history=message_history,
        deps=deps,
        on_complete=on_complete,
        instructions=instructions,
        usage_limits=UsageLimits(request_limit=_MAX_TURN_REQUESTS),
        capabilities=capabilities,
    )
    try:
        async for encoded in turn_adapter.encode_stream(
            _tee_events(stream, text, tool_calls, strip_lifecycle=strip_lifecycle)
        ):
            chat_run_manager.publish(thread_id, encoded)
            # A todo tool call mutated deps.todos in place — surface the new list to
            # subscribers as a CUSTOM event when it actually changed.
            snapshot = _todos_snapshot(deps)
            snapshot_json = json.dumps(snapshot, sort_keys=True)
            if snapshot_json != todos_state["json"] and (
                snapshot or todos_state["json"] is not None
            ):
                todos_state["json"] = snapshot_json
                chat_run_manager.publish(thread_id, _encode_todos_event(snapshot))
    finally:
        # Always persist the turn, whether the loop drained normally or unwound on
        # a CancelledError (stop) / exception (model or tool error).
        await persist_turn()

    result = captured.get("result")
    return result.all_messages() if result is not None else (message_history or [])


async def _resolve_goal_agent_model(
    session: AsyncSession, app_config: AppConfig | None
) -> str | None:
    """The model of the agent configured as the ``/goal`` default, if any.

    Plan execution runs autonomously like ``/goal``, so it should honor the
    user's chosen ``/goal`` agent's model — letting a heavier execution model run
    the plan than the one that drafted it. Returns the ``/goal`` agent's effective
    model (its own, or ``settings.default_model`` when it stores none) so a
    configured goal agent always wins. Returns ``None`` when no ``/goal`` default is
    set or its agent is missing, so the caller keeps the thread agent's own model.
    """
    default_agents = (app_config.default_agents if app_config else None) or {}
    goal_agent_id = (default_agents.get("goal") or "").strip()
    if not goal_agent_id:
        return None
    goal_agent = await session.get(Agent, goal_agent_id)
    if goal_agent is None:
        return None
    return goal_agent.model or settings.default_model


async def _build_agent_and_context(
    session: AsyncSession,
    agent_row: Agent,
    workspace: Workspace,
    read_only: bool = False,
    execute_plan: bool = False,
):
    """Build the deep agent + deps for a thread and load the app-wide context.

    Shared by the chat/planning endpoint and the goal-execution start so both
    resolve providers, subagents, and deep-defaults identically. ``read_only``
    gates the agent to "ask" mode (no file writes / shell). ``execute_plan``
    swaps in the ``/goal`` default agent's model (if the user configured one) so
    approved plans run under the chosen execution model — model only; the thread
    agent's tools and instructions are unchanged.
    """
    providers = (await session.execute(select(CustomProvider))).scalars().all()
    custom_providers = {p.id: p for p in providers}
    subagents = list((await session.execute(select(Subagent))).scalars().all())
    app_config = (await session.execute(select(AppConfig))).scalars().first()
    deep_defaults = app_config.deep_defaults if app_config else None
    model_override = (
        await _resolve_goal_agent_model(session, app_config) if execute_plan else None
    )
    agent, deps = build_deep_agent(
        agent_row,
        workspace.path,
        custom_providers,
        subagents,
        deep_defaults,
        model_override=model_override,
        workspace_name=workspace.name,
        workspace_description=workspace.description or None,
        workspace_id=workspace.id,
        read_only=read_only,
        web_search_provider=app_config.web_search_provider if app_config else None,
        # A UI-saved key (on AppConfig) wins over the environment fallback.
        tavily_api_key=(app_config.tavily_api_key if app_config else None)
        or settings.tavily_api_key,
        exa_api_key=(app_config.exa_api_key if app_config else None)
        or settings.exa_api_key,
    )
    return agent, deps, custom_providers, app_config


def _resolve_evaluator_model(
    app_config: AppConfig | None, thread: Thread, agent_row: Agent
) -> str:
    """The model that judges goal completion.

    Explicit ``goal_evaluator_model`` wins; otherwise it follows the thread
    agent's model (which itself falls back to the default).
    """
    return (
        (app_config.goal_evaluator_model if app_config else None)
        or agent_row.model
        or settings.default_model
    )


def _publish_lifecycle_start(thread_id: str, run_id: str) -> None:
    """Emit the single RUN_STARTED that opens a manually-wrapped goal run."""
    chat_run_manager.publish(
        thread_id,
        _encode_ag_ui_event(
            RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=run_id)
        ),
    )


def _publish_lifecycle_finish(thread_id: str, run_id: str) -> None:
    chat_run_manager.publish(
        thread_id,
        _encode_ag_ui_event(
            RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=run_id)
        ),
    )


def _goal_status_publisher(thread_id: str, condition: str, max_iter: int):
    """A ``(status, iteration, reason)`` closure that emits goal-status events.

    The optional ``plan_path`` per call is stamped onto the event for plan-mode
    runs so the UI can open the thread's specific plan doc when it parks for
    review (empty for goal mode and the pre-detection planning phase).
    """

    def publish(
        status_: ThreadStatus, iteration: int, reason: str = "", plan_path: str = ""
    ) -> None:
        chat_run_manager.publish(
            thread_id,
            encode_goal_status_event(
                status_,
                condition=condition,
                iteration=iteration,
                max_iterations=max_iter,
                reason=reason,
                plan_path=plan_path,
            ),
        )

    return publish


async def _run_goal_execution(
    thread_id: str,
    agent,
    deps,
    *,
    accept: str | None,
    evaluator,
    condition: str,
    max_turns: int,
    media_instructions: str | None,
    initial_history: list[ModelMessage],
    workspace_id: str,
    kickoff: str = AUTONOMOUS_KICKOFF,
) -> None:
    """Drive the autonomous goal loop (``/goal``).

    Many agent turns stream through one AG-UI lifecycle: work a step, evaluate
    against the goal, continue — until met / impossible / capped. The whole run is
    wrapped in a single RUN_STARTED…RUN_FINISHED.
    """
    todos_state: dict = {"json": None}
    run_id = uuid.uuid4().hex
    publish_status = _goal_status_publisher(thread_id, condition, max_turns)

    _publish_lifecycle_start(thread_id, run_id)
    try:
        await _set_thread_state(thread_id, status=ThreadStatus.running, iteration=0)
        publish_status(ThreadStatus.running, 0)
        history = list(initial_history)
        # Mid-run steering: this capability drains the thread's interjection
        # buffer before each model request and injects it into the live run, so a
        # message the user sends while executing reaches the model at the next
        # step (not just between whole agent runs).
        steer = build_steer_capability(thread_id)

        async def run_turn(turn_no: int, seed: str | None) -> list[ModelMessage]:
            nonlocal history
            turn_adapter = build_continuation_adapter(
                agent, seed or kickoff, thread_id, accept
            )
            history = await _stream_turn(
                thread_id,
                turn_adapter,
                deps,
                message_history=history,
                instructions=media_instructions,
                todos_state=todos_state,
                strip_lifecycle=True,
                kind="goal",
                capabilities=[steer],
            )
            return history

        async def on_evaluation(state, evaluation) -> None:
            await _set_thread_state(
                thread_id,
                status=ThreadStatus.running,
                iteration=state.turns,
                last_reason=evaluation.reason,
                todos=_todos_snapshot(deps),
            )
            publish_status(ThreadStatus.running, state.turns, evaluation.reason)

        # Judge completion against the *rendered* app, not just the transcript:
        # wrap the transcript evaluator so each evaluation also gets a live
        # screenshot of the dev server described by the vision model. Degrades to
        # plain transcript evaluation when browser QA is off or no server is up.
        evaluate = wrap_evaluate_with_visual_qa(evaluator.evaluate, workspace_id)

        outcome = await drive_goal_loop(
            condition=condition,
            max_turns=max_turns,
            run_turn=run_turn,
            evaluate=evaluate,
            on_evaluation=on_evaluation,
            initial_seed=kickoff,
        )
        await _set_thread_state(
            thread_id,
            status=outcome.status,
            iteration=outcome.turns,
            last_reason=outcome.last_reason,
            todos=_todos_snapshot(deps),
        )
        publish_status(outcome.status, outcome.turns, outcome.last_reason)
    except asyncio.CancelledError:
        # Each turn was persisted by ``_stream_turn``'s finally, including the
        # partial of any turn interrupted mid-stream.
        await _set_thread_state(thread_id, status=ThreadStatus.stopped)
        publish_status(ThreadStatus.stopped, 0)
        raise
    except Exception as exc:
        chat_run_manager.publish(
            thread_id,
            _encode_ag_ui_event(RunErrorEvent(type=EventType.RUN_ERROR, message=str(exc))),
        )
        await _set_thread_state(thread_id, status=ThreadStatus.failed)
        raise
    _publish_lifecycle_finish(thread_id, run_id)
    chat_run_manager.finish(thread_id, "finished")


def subscribe_chat_sse(thread_id: str) -> StreamingResponse:
    """SSE response that replays buffered events then follows the live run.

    Shared by the initial POST and the reconnect GET — both just subscribe to
    the thread's run. Disconnecting only unsubscribes; the run keeps going.
    """

    async def generate() -> AsyncIterator[str]:
        queue, replay = chat_run_manager.subscribe(thread_id)
        try:
            for encoded in replay:
                yield encoded
            # A finished run's replay already carried its terminal event.
            if not chat_run_manager.is_running(thread_id):
                return
            while True:
                try:
                    encoded = await asyncio.wait_for(queue.get(), _KEEPALIVE_TIMEOUT)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if encoded is None:  # sentinel → run finished
                    return
                yield encoded
        finally:
            chat_run_manager.unsubscribe(thread_id, queue)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/{thread_id}/chat")
async def chat(
    thread_id: str, request: Request, session: AsyncSession = Depends(get_session)
) -> StreamingResponse:
    thread = await session.get(Thread, thread_id)
    if thread is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thread not found")

    agent_row = await session.get(Agent, thread.agent_id)
    workspace = await session.get(Workspace, thread.workspace_id)
    if agent_row is None or workspace is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Thread's agent or workspace is missing")

    # Persist the incoming user turn up front (best-effort; body is cached for re-read
    # by the adapter below). AG-UI only fires on_complete on success, so doing this
    # here means the user turn survives even if the run errors or is stopped. Any
    # attached images are written to the media store and referenced on the row.
    user_text = ""
    attachments: list[dict] = []
    # Per-turn intent rides on the AG-UI request as a forwarded prop, set by the
    # frontend slash-command dispatch: "chat" (full tools, the default), "ask"
    # (read-only agent), "goal" (one-off autonomous run), "plan" (propose a plan
    # doc without executing) or "execute_plan" (carry an approved plan doc out as a
    # goal). All are per-turn — no sticky thread mode is involved. A plain "chat"
    # turn while a plan is parked (`awaiting_approval`) is treated as a plan
    # *refinement* (see the driver dispatch below), not an implementation.
    turn = "chat"
    # Skills the user @-referenced in the composer this turn (slugs); their full
    # bodies are force-loaded into the turn below. Client-supplied, so validated
    # when resolved (see _referenced_skill_instructions).
    referenced_skill_slugs: list[str] = []
    with contextlib.suppress(Exception):
        body = await request.json()
        forwarded = body.get("forwardedProps") or {}
        if isinstance(forwarded, dict):
            turn = forwarded.get("turn") or "chat"
            raw_skills = forwarded.get("skills")
            if isinstance(raw_skills, list):
                referenced_skill_slugs = [s for s in raw_skills if isinstance(s, str) and s]
        user_text, images = _parse_user_turn(body)
        for img in images:
            with contextlib.suppress(Exception):
                media_id = save_base64_image(thread_id, img["b64"], img["mime"])
                attachments.append(
                    {
                        "media_id": media_id,
                        "mime_type": img["mime"],
                        "filename": img.get("filename"),
                    }
                )
        if user_text or attachments:
            # Tag the turn for the history badge: /ask, /goal and /plan all ride on
            # the per-turn `turn` flag (plan is no longer a sticky thread mode). A
            # plain message while a plan is parked is a plan refinement, so badge it
            # "plan" too so the transcript reads as one planning conversation.
            if turn == "ask":
                msg_kind = "ask"
            elif turn == "goal" or turn == "execute_plan":
                msg_kind = "goal"
            elif turn == "plan" or (
                turn == "chat" and thread.status == ThreadStatus.awaiting_approval
            ):
                msg_kind = "plan"
            else:
                msg_kind = "chat"
            session.add(
                Message(
                    thread_id=thread_id,
                    role="user",
                    content=user_text,
                    attachments=attachments,
                    kind=msg_kind,
                    # Snapshot the agent that ran this turn so the bubble can show it.
                    agent_id=agent_row.id,
                    agent_name=agent_row.name,
                )
            )
            if thread.title == "New conversation":
                # Set the truncated first message inline so the sidebar shows
                # something instantly, then upgrade it to an LLM-generated title
                # in the background. Image-only first turns keep the placeholder.
                placeholder = user_text[:60] or f"{len(attachments)} image(s)"
                thread.title = placeholder
                session.add(thread)
                if user_text.strip():
                    _schedule_auto_title(thread_id, user_text, placeholder)
            await session.commit()

    # List every image attached in this conversation so the agent can inspect any
    # of them via view_image, regardless of the model's own vision support.
    media_instructions = await _thread_media_instructions(session, thread_id)

    # Fold any @-referenced skills into the per-turn instruction blocks so every
    # driver (chat, /ask, plan, goal) force-loads them. Reuses media_instructions
    # as the shared base the drivers already thread through.
    skill_instructions = _referenced_skill_instructions(
        referenced_skill_slugs, workspace.path
    )
    media_instructions = _join_instructions(media_instructions, skill_instructions)

    # A "/ask" turn on a chat thread builds a read-only agent (no write/edit/shell).
    read_only = thread.mode == ThreadMode.chat and turn == "ask"
    # "Execute plan" runs the approved plan autonomously; honor the `/goal` default
    # agent's model (if the user set one) so execution can use a heavier model than
    # the planning agent — see `_resolve_goal_agent_model`.
    agent, deps, custom_providers, app_config = await _build_agent_and_context(
        session, agent_row, workspace, read_only=read_only,
        execute_plan=(turn == "execute_plan"),
    )
    # Build the adapter (parses the request body/messages) before returning, so the
    # detached driver never touches the request object after the response starts.
    adapter = await AGUIAdapter.from_request(request, agent=agent)

    # Decide how the model receives attached images. A vision-capable model gets
    # them inline (the adapter already converted the parts to BinaryContent). A
    # text-only model can't accept image content, so strip it and steer the agent
    # to view_image via the on-disk copies instead. Mutating run_input.messages
    # here is safe: the adapter parses .messages lazily, only once run_stream runs.
    if attachments:
        model_str = agent_row.model or settings.default_model
        if not await model_supports_vision(model_str):
            paths = [str(media_path(thread_id, a["media_id"])) for a in attachments]
            note = user_text + (
                f"\n\n[The user attached {len(paths)} image(s). They are saved on "
                "disk — use the view_image tool with a path from the 'Attached "
                "media' section of your instructions to inspect their contents.]"
            )
            _strip_inline_images(adapter.run_input, note.strip())

    # `/plan`, `/goal` and "Execute plan" are all one-off per-turn runs, not sticky
    # thread modes. A `/plan` turn drafts a NEW plan doc and parks the thread in
    # `awaiting_approval`. While parked, a plain message *refines* that doc (it does
    # NOT implement it); the user presses "Execute plan" (turn == "execute_plan")
    # to carry the approved plan out as a goal.
    parked = thread.status == ThreadStatus.awaiting_approval
    run_goal = turn == "goal"
    is_execute_plan = turn == "execute_plan"
    # A plain chat turn on a parked plan is a refinement of the existing doc. `/ask`
    # is read-only and `/plan` always starts fresh, so neither refines.
    is_refine = parked and turn == "chat"
    # `/plan` (fresh draft) or a plain-message refinement both run the plan driver.
    run_plan = turn == "plan" or is_refine
    condition = user_text.strip() or (thread.success_criteria or thread.goal).strip()
    todos_state: dict = {"json": None}

    async def chat_driver() -> None:
        # Plain chat (or /ask): one turn, natural AG-UI lifecycle intact. A plain
        # turn on a *parked* plan is handled by the plan driver (refinement), so
        # this path only runs for non-parked chat/`ask` turns and never needs to
        # touch a parked plan's state.
        # ``_stream_turn`` persists the turn (including any partial on stop/error)
        # from its own ``finally``, so a stop just propagates the CancelledError.
        await _stream_turn(
            thread_id,
            adapter,
            deps,
            message_history=None,
            instructions=media_instructions,
            todos_state=todos_state,
        )
        chat_run_manager.finish(thread_id, "finished")

    # A plain message on a thread parked in `awaiting_approval` is a *refinement*:
    # the user is giving feedback on the plan already written, so we reuse that
    # thread's doc and frame the turn as revising the existing draft. A `/plan` turn
    # always starts a NEW plan doc, naming it itself (resolved after the turn — see
    # `plan_driver`). The request adapter already carries the full frontend
    # transcript and any image attachments, so the planning turn has full
    # conversational context without re-seeding from the DB.
    plan_instruction = (
        refine_instruction(thread.plan_path or plan_doc_path(thread.title))
        if is_refine
        else planning_instruction()
    )

    async def plan_driver() -> None:
        # Plan mode: one turn that writes/revises the plan doc, then ends in
        # `awaiting_approval` so the thread is free for the user to iterate (send
        # more messages to refine). Nothing executes while in plan mode; the user
        # leaves plan mode (mode→chat) and chats normally to carry the plan out.
        # Wrapped in a manual lifecycle so status events sit inside RUN_STARTED…FINISHED.
        run_id = uuid.uuid4().hex
        publish_status = _goal_status_publisher(thread_id, condition, thread.max_iterations)
        # On a refinement the agent edits the doc the thread already points at; on a
        # fresh round it picks the filename itself, so we snapshot the plan folder now
        # and detect what it wrote afterwards. Bound before the try so the cancel
        # handler can resolve a partially-written plan.
        known_path = thread.plan_path if is_refine else ""
        before: dict[str, float] = {} if is_refine else scan_plan_dir(workspace.path)
        _publish_lifecycle_start(thread_id, run_id)
        try:
            # Make sure `.agents/plan/` exists so the agent's write lands (its file
            # tools may not create parent dirs).
            with contextlib.suppress(OSError):
                (Path(workspace.path) / PLAN_DIR).mkdir(parents=True, exist_ok=True)
            await _set_thread_state(
                thread_id, status=ThreadStatus.planning, plan_path=known_path or None
            )
            publish_status(ThreadStatus.planning, 0, plan_path=known_path)
            await _stream_turn(
                thread_id,
                adapter,
                deps,
                message_history=None,
                instructions=_join_instructions(media_instructions, plan_instruction),
                todos_state=todos_state,
                strip_lifecycle=True,
                kind="plan",
            )
            # Resolve the doc the agent wrote (fresh round) or reuse the known one
            # (refinement). Falls back to a title-derived name only if the agent left
            # no detectable plan file. Pin it so the UI + later turns open the same doc.
            plan_doc = (
                known_path
                or detect_written_plan(workspace.path, before)
                or plan_doc_path(thread.title)
            )
            await _set_thread_state(
                thread_id,
                status=ThreadStatus.awaiting_approval,
                plan_path=plan_doc,
                todos=_todos_snapshot(deps),
            )
            publish_status(ThreadStatus.awaiting_approval, 0, plan_path=plan_doc)
        except asyncio.CancelledError:
            # The turn itself was persisted by ``_stream_turn``'s finally. Stopped
            # mid-turn the agent may still have written (part of) a plan, so resolve
            # and pin whatever doc it left rather than losing the pointer.
            stopped_doc = (
                known_path
                or detect_written_plan(workspace.path, before)
                or thread.plan_path
                or None
            )
            await _set_thread_state(
                thread_id,
                status=ThreadStatus.awaiting_approval,
                plan_path=stopped_doc,
            )
            raise
        except Exception as exc:
            chat_run_manager.publish(
                thread_id,
                _encode_ag_ui_event(RunErrorEvent(type=EventType.RUN_ERROR, message=str(exc))),
            )
            raise
        _publish_lifecycle_finish(thread_id, run_id)
        chat_run_manager.finish(thread_id, "finished")

    if run_goal or is_execute_plan:
        # Autonomous goal loop, run straight away for this one submission — no
        # sticky mode. `/goal` takes its objective from this message; "Execute plan"
        # derives it from the approved plan doc. Both load context in request scope
        # (the detached driver must not touch the request-scoped session after the
        # response starts).
        if is_execute_plan:
            plan_path = thread.plan_path
            if not plan_path:
                raise HTTPException(
                    status.HTTP_409_CONFLICT, "No plan to execute for this conversation"
                )
            doc_text = read_plan_doc(workspace.path, plan_path)
            # The plan's `## Success Criteria` section is what "done" means; fall
            # back to the whole doc when a plan omits that section.
            goal_condition = extract_success_criteria(doc_text) or doc_text.strip()
            if not goal_condition:
                raise HTTPException(
                    status.HTTP_409_CONFLICT, "The plan doc is empty or unreadable"
                )
            # Persist the derived goal + clear the park so the run (and any reconnect)
            # shows the objective and no longer reads as awaiting approval.
            thread.goal = f"Fully implement the plan at {plan_path}."
            thread.success_criteria = goal_condition
            thread.status = ThreadStatus.running
            session.add(thread)
            await session.commit()
            goal_kickoff = plan_execute_kickoff(plan_path)
        else:
            goal_condition = condition
            goal_kickoff = AUTONOMOUS_KICKOFF

        rows = (
            await session.execute(
                select(Message)
                .where(Message.thread_id == thread_id, Message.compacted == False)  # noqa: E712
                .order_by(Message.created_at)
            )
        ).scalars().all()
        initial_history = messages_to_history(rows)
        evaluator = build_goal_evaluator(
            _resolve_evaluator_model(app_config, thread, agent_row), custom_providers
        )
        max_iter = thread.max_iterations
        accept = adapter.accept

        async def goal_driver() -> None:
            await _run_goal_execution(
                thread_id,
                agent,
                deps,
                accept=accept,
                evaluator=evaluator,
                condition=goal_condition,
                max_turns=max_iter,
                media_instructions=media_instructions,
                initial_history=initial_history,
                workspace_id=workspace.id,
                kickoff=goal_kickoff,
            )

        driver = goal_driver
    elif run_plan:
        driver = plan_driver
    else:
        driver = chat_driver

    # Hand the run's backend to the preview service so a dev server the agent
    # starts surfaces in the Preview panel — even after this turn ends (the
    # server outlives the run; the service keeps watching the retained backend).
    preview_service.register(workspace.id, deps.backend)

    if not chat_run_manager.start_run(thread_id, driver):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "A chat run is already active for this conversation"
        )

    # Setup DB work is done and the detached driver uses its own background
    # sessions — so release this request-scoped connection before returning the
    # stream. FastAPI won't run the get_session cleanup until the SSE body is fully
    # consumed (the whole run, potentially minutes), and the reads above leave an
    # open transaction that would pin this pooled connection for that entire time.
    # Left unclosed, ~15 concurrent runs exhaust the pool (QueuePool timeout).
    await session.close()
    return subscribe_chat_sse(thread_id)


@router.get("/{thread_id}/stream")
async def reconnect_stream(thread_id: str) -> StreamingResponse:
    """Re-attach to a thread's in-flight run: replay its buffer, then stream live."""
    return subscribe_chat_sse(thread_id)


@router.post("/{thread_id}/stop", status_code=status.HTTP_200_OK)
async def stop_run(thread_id: str) -> dict[str, bool]:
    stopped = await chat_run_manager.stop(thread_id)
    if not stopped:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No active run for this conversation")
    return {"stopped": True}


@router.post("/{thread_id}/goal/interject", status_code=status.HTTP_200_OK)
async def interject_goal(
    thread_id: str, request: Request, session: AsyncSession = Depends(get_session)
) -> dict[str, bool]:
    """Steer a running goal: buffer a user message for the loop's next turn.

    The autonomous run streams as one long lifecycle, so a new message can't ride
    the normal ``POST /chat`` path (that would 409 on the active run). Instead we
    persist the message to the transcript and buffer it; ``_run_goal_execution``
    weaves any buffered messages into the next turn's seed at the turn boundary.
    """
    thread = await session.get(Thread, thread_id)
    if thread is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thread not found")
    # A goal is a one-off run (not a sticky mode), so gate on there being a live
    # run to steer rather than on the thread's mode. The frontend only interjects
    # while a goal loop is executing.
    if not chat_run_manager.is_running(thread_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "No active goal run to steer")

    text = ""
    with contextlib.suppress(Exception):
        body = await request.json()
        if isinstance(body, dict):
            text = str(body.get("content") or body.get("text") or "").strip()
    if not text:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Message text is required")

    # Persist so the interjection survives reconnect and lands in the transcript
    # (the optimistic bubble the sender rendered is reconciled on reload). It's a
    # steer into a live goal run, so tag it "goal" for the history badge, and stamp
    # the running agent so the bubble shows it like every other turn.
    agent = await session.get(Agent, thread.agent_id)
    session.add(
        Message(
            thread_id=thread_id,
            role="user",
            content=text,
            kind="goal",
            agent_id=thread.agent_id,
            agent_name=agent.name if agent is not None else "",
        )
    )
    await session.commit()
    queue_interjection(thread_id, text)
    return {"queued": True}


@router.post("/{thread_id}/compact", status_code=status.HTTP_200_OK)
async def compact_thread(
    thread_id: str, session: AsyncSession = Depends(get_session)
) -> dict[str, bool | str]:
    """Condense a conversation into a single carry-forward summary (``/compact``).

    Summarizes every currently-visible message with the compaction model (an app
    config override, else the thread agent's model), marks those messages
    ``compacted`` (hidden, not deleted), and inserts a ``kind="summary"`` assistant
    message in their place. Later turns then send only the summary plus new
    messages, cutting token cost while keeping the thread's context.
    """
    thread = await session.get(Thread, thread_id)
    if thread is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thread not found")
    # Compacting mid-run would race the run's own message writes and yank context
    # out from under it, so require a settled thread.
    if chat_run_manager.is_running(thread_id):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Can't compact while a run is active"
        )

    rows = (
        await session.execute(
            select(Message)
            .where(Message.thread_id == thread_id, Message.compacted == False)  # noqa: E712
            .order_by(Message.created_at)
        )
    ).scalars().all()
    # Nothing meaningful to condense — a single message (or an existing lone
    # summary) already is the compact form.
    if len(rows) < 2:
        return {"compacted": False, "reason": "Not enough history to compact"}

    app_config = (await session.execute(select(AppConfig))).scalars().first()
    providers = (await session.execute(select(CustomProvider))).scalars().all()
    custom_providers = {p.id: p for p in providers}
    # An explicit override wins; otherwise summarize on the global default (a small,
    # fast cloud model) rather than the thread agent's model, which may be heavy or
    # offline.
    model_str = (
        app_config.compaction_model if app_config else None
    ) or settings.default_compaction_model

    try:
        summary = await summarize_thread(list(rows), model_str, custom_providers)
    except Exception as exc:  # noqa: BLE001 — surface any model/provider failure cleanly
        # The summarizer model may be unreachable or unknown to its provider (e.g.
        # a local proxy that no longer serves it). Return a clean 502 so the UI can
        # show the reason, rather than letting it bubble up as an opaque 500.
        logger.warning("compact: summarization failed for thread %s: %s", thread_id, exc)
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"Compaction failed ({model_str}): {exc}",
        ) from exc
    if not summary:
        return {"compacted": False, "reason": "Summarizer produced no output"}

    for row in rows:
        row.compacted = True
        session.add(row)
    session.add(
        Message(
            thread_id=thread_id,
            role="assistant",
            content=summary,
            kind="summary",
        )
    )
    thread.updated_at = datetime.now(UTC)
    session.add(thread)
    await session.commit()
    return {"compacted": True}
