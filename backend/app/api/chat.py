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
from collections.abc import AsyncIterator

from ag_ui.core import EventType
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic_ai.ui.ag_ui import AGUIAdapter
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select
from starlette.responses import StreamingResponse

from app.agents.builder import build_deep_agent
from app.agents.chat_run_manager import chat_run_manager
from app.agents.vision import model_supports_vision
from app.config import get_settings
from app.db.models import Agent, CustomProvider, Message, Subagent, Thread, Workspace
from app.db.session import async_session_factory, get_session
from app.media_store import media_path, save_base64_image

router = APIRouter(prefix="/threads", tags=["chat"])

settings = get_settings()

_KEEPALIVE_TIMEOUT = 25.0  # seconds between ": keepalive" comments on an idle stream
_TEXT_DELTA_TYPES = {EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_CHUNK}


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
    with contextlib.suppress(Exception):
        body = await request.json()
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

    # Custom (locally-hosted) providers, keyed by id, so a `custom:` model on the
    # agent can be routed to the right base URL.
    providers = (await session.execute(select(CustomProvider))).scalars().all()
    custom_providers = {p.id: p for p in providers}
    # Global subagent roster — the builder only applies it when the agent has
    # include_subagents on.
    subagents = list((await session.execute(select(Subagent))).scalars().all())
    agent, deps = build_deep_agent(
        agent_row, workspace.path, custom_providers, subagents
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

    async def on_complete(result) -> None:
        output = getattr(result, "output", None)
        content = output if isinstance(output, str) else str(output) if output else ""
        await _persist_message(thread_id, "assistant", content)

    accumulated: list[str] = []

    async def _tee(stream: AsyncIterator) -> AsyncIterator:
        """Pass events through while accumulating assistant text for partial-persist."""
        async for event in stream:
            if getattr(event, "type", None) in _TEXT_DELTA_TYPES:
                delta = getattr(event, "delta", None)
                if delta:
                    accumulated.append(delta)
            yield event

    async def driver() -> None:
        stream = adapter.run_stream(
            deps=deps, on_complete=on_complete, instructions=media_instructions
        )
        try:
            async for encoded in adapter.encode_stream(_tee(stream)):
                chat_run_manager.publish(thread_id, encoded)
        except asyncio.CancelledError:
            # Stopped mid-run: on_complete never fired, so keep the partial answer.
            await _persist_message(thread_id, "assistant", "".join(accumulated))
            raise
        else:
            chat_run_manager.finish(thread_id, "finished")

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
