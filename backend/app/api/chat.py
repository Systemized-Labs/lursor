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
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

from ag_ui.core import (
    CustomEvent,
    EventType,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
)
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic_ai.messages import ModelMessage
from pydantic_ai.ui.ag_ui import AGUIAdapter
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select
from starlette.responses import StreamingResponse

from app.agents.builder import build_deep_agent
from app.agents.chat_run_manager import chat_run_manager
from app.agents.goal_loop import (
    AUTONOMOUS_KICKOFF,
    EXECUTION_KICKOFF,
    PLANNING_INSTRUCTION,
    build_continuation_adapter,
    build_goal_evaluator,
    drive_goal_loop,
    encode_goal_status_event,
    messages_to_history,
)
from app.agents.vision import model_supports_vision
from app.config import get_settings
from app.db.models import (
    Agent,
    AppConfig,
    CustomProvider,
    GoalStatus,
    Message,
    Subagent,
    Thread,
    ThreadMode,
    Workspace,
)
from app.db.session import async_session_factory, get_session
from app.media_store import media_path, save_base64_image

router = APIRouter(prefix="/threads", tags=["chat"])

settings = get_settings()

_KEEPALIVE_TIMEOUT = 25.0  # seconds between ": keepalive" comments on an idle stream
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


async def _persist_message(thread_id: str, role: str, content: str) -> None:
    """Append a message on its own background session (runs outside the request)."""
    if not content:
        return
    async with async_session_factory() as bg_session:
        bg_session.add(Message(thread_id=thread_id, role=role, content=content))
        await bg_session.commit()


async def _set_goal_state(
    thread_id: str,
    *,
    status: GoalStatus | None = None,
    iteration: int | None = None,
    last_reason: str | None = None,
    todos: list[dict] | None = None,
) -> None:
    """Persist goal progress to the thread row (own background session).

    Only non-``None`` fields are written, so partial updates (just a status, or
    just the latest todos) are cheap and don't clobber the rest.
    """
    async with async_session_factory() as bg_session:
        thread = await bg_session.get(Thread, thread_id)
        if thread is None:
            return
        if status is not None:
            thread.goal_status = status
        if iteration is not None:
            thread.iteration = iteration
        if last_reason is not None:
            thread.last_reason = last_reason
        if todos is not None:
            thread.todos_snapshot = todos
        thread.updated_at = datetime.now(UTC)
        bg_session.add(thread)
        await bg_session.commit()


async def _tee_events(
    stream: AsyncIterator, accumulated: list[str], *, strip_lifecycle: bool
) -> AsyncIterator:
    """Pass events through, accumulating assistant text for partial-persist.

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
        yield event


async def _stream_turn(
    thread_id: str,
    turn_adapter: AGUIAdapter,
    deps,
    *,
    message_history: list[ModelMessage] | None,
    instructions: str | None,
    accumulated: list[str],
    todos_state: dict,
    strip_lifecycle: bool = False,
) -> list[ModelMessage]:
    """Run one agent turn to completion, streaming events + todos to subscribers.

    Returns the full message history after the turn (``result.all_messages()``)
    so a goal loop can feed it into the next turn. ``todos_state`` carries the
    last-published todo JSON across a run's turns (``{"json": str | None}``).
    """
    captured: dict[str, object] = {}

    async def on_complete(result) -> None:
        captured["result"] = result
        output = getattr(result, "output", None)
        content = output if isinstance(output, str) else str(output) if output else ""
        await _persist_message(thread_id, "assistant", content)

    stream = turn_adapter.run_stream(
        message_history=message_history,
        deps=deps,
        on_complete=on_complete,
        instructions=instructions,
    )
    async for encoded in turn_adapter.encode_stream(
        _tee_events(stream, accumulated, strip_lifecycle=strip_lifecycle)
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

    result = captured.get("result")
    return result.all_messages() if result is not None else (message_history or [])


async def _build_agent_and_context(
    session: AsyncSession,
    agent_row: Agent,
    workspace: Workspace,
    read_only: bool = False,
):
    """Build the deep agent + deps for a thread and load the app-wide context.

    Shared by the chat/planning endpoint and the goal-execution start so both
    resolve providers, subagents, and deep-defaults identically. ``read_only``
    gates the agent to "ask" mode (no file writes / shell).
    """
    providers = (await session.execute(select(CustomProvider))).scalars().all()
    custom_providers = {p.id: p for p in providers}
    subagents = list((await session.execute(select(Subagent))).scalars().all())
    app_config = (await session.execute(select(AppConfig))).scalars().first()
    deep_defaults = app_config.deep_defaults if app_config else None
    agent, deps = build_deep_agent(
        agent_row,
        workspace.path,
        custom_providers,
        subagents,
        deep_defaults,
        read_only=read_only,
    )
    return agent, deps, custom_providers, app_config


def _resolve_evaluator_model(app_config: AppConfig | None, agent_row: Agent) -> str:
    """The model that judges goal completion — configurable, else the agent's own."""
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
    """A ``(status, iteration, reason)`` closure that emits goal-status events."""

    def publish(status_: GoalStatus, iteration: int, reason: str = "") -> None:
        chat_run_manager.publish(
            thread_id,
            encode_goal_status_event(
                status_,
                condition=condition,
                iteration=iteration,
                max_iterations=max_iter,
                reason=reason,
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
    kickoff: str = EXECUTION_KICKOFF,
) -> None:
    """Drive the autonomous execution loop after a plan is approved.

    Many agent turns stream through one AG-UI lifecycle: read the approved plan,
    work a step, evaluate against the goal, continue — until met / impossible /
    capped. The whole run is wrapped in a single RUN_STARTED…RUN_FINISHED.
    """
    accumulated: list[str] = []
    todos_state: dict = {"json": None}
    run_id = uuid.uuid4().hex
    publish_status = _goal_status_publisher(thread_id, condition, max_turns)

    _publish_lifecycle_start(thread_id, run_id)
    try:
        await _set_goal_state(thread_id, status=GoalStatus.running, iteration=0)
        publish_status(GoalStatus.running, 0)
        history = list(initial_history)

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
                accumulated=accumulated,
                todos_state=todos_state,
                strip_lifecycle=True,
            )
            return history

        async def on_evaluation(state, evaluation) -> None:
            await _set_goal_state(
                thread_id,
                status=GoalStatus.running,
                iteration=state.turns,
                last_reason=evaluation.reason,
                todos=_todos_snapshot(deps),
            )
            publish_status(GoalStatus.running, state.turns, evaluation.reason)

        outcome = await drive_goal_loop(
            condition=condition,
            max_turns=max_turns,
            run_turn=run_turn,
            evaluate=evaluator.evaluate,
            on_evaluation=on_evaluation,
            initial_seed=kickoff,
        )
        await _set_goal_state(
            thread_id,
            status=outcome.status,
            iteration=outcome.turns,
            last_reason=outcome.last_reason,
            todos=_todos_snapshot(deps),
        )
        publish_status(outcome.status, outcome.turns, outcome.last_reason)
    except asyncio.CancelledError:
        await _persist_message(thread_id, "assistant", "".join(accumulated))
        await _set_goal_state(thread_id, status=GoalStatus.stopped)
        publish_status(GoalStatus.stopped, 0)
        raise
    except Exception as exc:
        chat_run_manager.publish(
            thread_id,
            _encode_ag_ui_event(RunErrorEvent(type=EventType.RUN_ERROR, message=str(exc))),
        )
        await _set_goal_state(thread_id, status=GoalStatus.failed)
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
    # Per-turn mode ("ask"/"edit") rides on the AG-UI request as a forwarded
    # prop; "edit" (full tools) is the default. Only meaningful for chat threads
    # — goal threads run the plan lifecycle regardless.
    turn_mode = "edit"
    with contextlib.suppress(Exception):
        body = await request.json()
        forwarded = body.get("forwardedProps") or {}
        if isinstance(forwarded, dict):
            turn_mode = forwarded.get("turn_mode") or "edit"
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
            session.add(
                Message(
                    thread_id=thread_id,
                    role="user",
                    content=user_text,
                    attachments=attachments,
                )
            )
            if thread.title == "New conversation":
                thread.title = (user_text[:60] or f"{len(attachments)} image(s)")
                session.add(thread)
            await session.commit()

    # List every image attached in this conversation so the agent can inspect any
    # of them via view_image, regardless of the model's own vision support.
    media_instructions = await _thread_media_instructions(session, thread_id)

    # "Ask" mode on a chat thread builds a read-only agent (no write/edit/shell).
    read_only = thread.mode == ThreadMode.chat and turn_mode == "ask"
    agent, deps, custom_providers, app_config = await _build_agent_and_context(
        session, agent_row, workspace, read_only=read_only
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

    is_goal = thread.mode == ThreadMode.goal
    condition = (thread.success_criteria or thread.goal).strip()
    accumulated: list[str] = []
    todos_state: dict = {"json": None}

    async def chat_driver() -> None:
        # Plain chat: one turn, natural AG-UI lifecycle intact.
        try:
            await _stream_turn(
                thread_id,
                adapter,
                deps,
                message_history=None,
                instructions=media_instructions,
                accumulated=accumulated,
                todos_state=todos_state,
            )
        except asyncio.CancelledError:
            # Stopped mid-run: on_complete never fired, so keep the partial answer.
            await _persist_message(thread_id, "assistant", "".join(accumulated))
            raise
        else:
            chat_run_manager.finish(thread_id, "finished")

    async def planning_driver() -> None:
        # Goal planning: one turn that writes/revises the plan doc, then ends in
        # `awaiting_approval` so the thread is free for the user to iterate (send
        # more messages) or approve. Wrapped in a manual lifecycle so goal-status
        # events sit safely inside RUN_STARTED…RUN_FINISHED.
        run_id = uuid.uuid4().hex
        publish_status = _goal_status_publisher(thread_id, condition, thread.max_iterations)
        _publish_lifecycle_start(thread_id, run_id)
        try:
            await _set_goal_state(thread_id, status=GoalStatus.planning)
            publish_status(GoalStatus.planning, 0)
            await _stream_turn(
                thread_id,
                adapter,
                deps,
                message_history=None,
                instructions=_join_instructions(media_instructions, PLANNING_INSTRUCTION),
                accumulated=accumulated,
                todos_state=todos_state,
                strip_lifecycle=True,
            )
            await _set_goal_state(
                thread_id,
                status=GoalStatus.awaiting_approval,
                todos=_todos_snapshot(deps),
            )
            publish_status(GoalStatus.awaiting_approval, 0)
        except asyncio.CancelledError:
            await _persist_message(thread_id, "assistant", "".join(accumulated))
            await _set_goal_state(thread_id, status=GoalStatus.awaiting_approval)
            raise
        except Exception as exc:
            chat_run_manager.publish(
                thread_id,
                _encode_ag_ui_event(RunErrorEvent(type=EventType.RUN_ERROR, message=str(exc))),
            )
            raise
        _publish_lifecycle_finish(thread_id, run_id)
        chat_run_manager.finish(thread_id, "finished")

    if not is_goal:
        driver = chat_driver
    elif thread.require_plan_approval:
        driver = planning_driver
    else:
        # Fully autonomous (approval off): skip the review pause and execute the
        # goal straight away. Load context in request scope (the detached driver
        # must not touch the request-scoped session after the response starts).
        rows = (
            await session.execute(
                select(Message)
                .where(Message.thread_id == thread_id)
                .order_by(Message.created_at)
            )
        ).scalars().all()
        initial_history = messages_to_history(rows)
        evaluator = build_goal_evaluator(
            _resolve_evaluator_model(app_config, agent_row), custom_providers
        )
        max_iter = thread.max_iterations
        accept = adapter.accept

        async def autonomous_driver() -> None:
            await _run_goal_execution(
                thread_id,
                agent,
                deps,
                accept=accept,
                evaluator=evaluator,
                condition=condition,
                max_turns=max_iter,
                media_instructions=media_instructions,
                initial_history=initial_history,
                kickoff=AUTONOMOUS_KICKOFF,
            )

        driver = autonomous_driver

    if not chat_run_manager.start_run(thread_id, driver):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "A chat run is already active for this conversation"
        )

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


@router.post("/{thread_id}/goal/approve", status_code=status.HTTP_200_OK)
async def approve_goal_plan(
    thread_id: str, session: AsyncSession = Depends(get_session)
) -> dict[str, bool]:
    """Approve the plan and start the autonomous execution run.

    Planning turns have already finished (the thread is idle in
    ``awaiting_approval``), so this spawns the execution loop as a fresh detached
    run. The caller follows it via ``GET /threads/{id}/stream``.
    """
    thread = await session.get(Thread, thread_id)
    if thread is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thread not found")
    if thread.mode != ThreadMode.goal:
        raise HTTPException(status.HTTP_409_CONFLICT, "Not a goal thread")
    if chat_run_manager.is_running(thread_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "A run is already active")

    agent_row = await session.get(Agent, thread.agent_id)
    workspace = await session.get(Workspace, thread.workspace_id)
    if agent_row is None or workspace is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Thread's agent or workspace is missing")

    media_instructions = await _thread_media_instructions(session, thread_id)
    agent, deps, custom_providers, app_config = await _build_agent_and_context(
        session, agent_row, workspace
    )
    evaluator = build_goal_evaluator(
        _resolve_evaluator_model(app_config, agent_row), custom_providers
    )
    condition = (thread.success_criteria or thread.goal).strip()
    max_iter = thread.max_iterations
    # Seed the execution run with the planning transcript so it has context; the
    # detailed plan itself lives in the workspace's plan doc, which it reads.
    rows = (
        await session.execute(
            select(Message).where(Message.thread_id == thread_id).order_by(Message.created_at)
        )
    ).scalars().all()
    initial_history = messages_to_history(rows)

    async def driver() -> None:
        await _run_goal_execution(
            thread_id,
            agent,
            deps,
            accept="text/event-stream",
            evaluator=evaluator,
            condition=condition,
            max_turns=max_iter,
            media_instructions=media_instructions,
            initial_history=initial_history,
        )

    if not chat_run_manager.start_run(thread_id, driver):
        raise HTTPException(status.HTTP_409_CONFLICT, "A run is already active")
    return {"approved": True}
