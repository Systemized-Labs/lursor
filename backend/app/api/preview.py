"""Live view of a workspace's background processes, for the Preview panel and
the running-process indicator.

A single WebSocket per workspace streams the current list of *running* background
processes the agent started (see :mod:`app.agents.preview_service`) — each with
its command and, for dev servers, a detected URL and starting/ready state. The
panel stays connected regardless of chat activity, so a server the agent starts
is surfaced even though it comes up after the agent's turn has ended.

Each WS message is a full snapshot: ``{"processes": [{id, shellId, command, url,
port, ready}, ...]}``. The client replaces its list wholesale, so a process that
exits (dropping off the list) removes its entry.

REST alongside the socket lets the UI inspect and control a process:
``GET /output`` returns its captured output tail, ``POST /kill`` stops it.
"""

from __future__ import annotations

import asyncio
import contextlib

from fastapi import APIRouter, HTTPException, WebSocket, status
from pydantic import BaseModel
from starlette.websockets import WebSocketDisconnect

from app.agents.preview_service import preview_service
from app.db.models import Workspace
from app.db.session import async_session_factory

router = APIRouter(prefix="/workspaces/{workspace_id}/preview", tags=["preview"])


async def _workspace_exists(workspace_id: str) -> bool:
    async with async_session_factory() as session:
        return (await session.get(Workspace, workspace_id)) is not None


@router.websocket("/ws")
async def preview_ws(websocket: WebSocket, workspace_id: str) -> None:
    """Stream the workspace's running background processes as full snapshots."""
    if not await _workspace_exists(workspace_id):
        # Reject the handshake so the client sees a permanent failure and backs
        # off instead of hammering us with reconnects.
        with contextlib.suppress(Exception):
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        return

    try:
        await websocket.accept()
    except (WebSocketDisconnect, RuntimeError):
        return

    queue, snapshot = preview_service.subscribe(workspace_id)

    async def pump() -> None:
        # Send the current list up front, then every subsequent change.
        with contextlib.suppress(Exception):
            await websocket.send_json({"processes": snapshot})
        while True:
            processes = await queue.get()
            with contextlib.suppress(Exception):
                await websocket.send_json({"processes": processes})

    pump_task = asyncio.create_task(pump())
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        pump_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await pump_task
        preview_service.unsubscribe(workspace_id, queue)


@router.get("/output")
async def process_output(workspace_id: str, id: str) -> dict:
    """Return the captured output tail for a background process."""
    output = preview_service.output(workspace_id, id)
    if output is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such background process")
    return {"output": output}


class KillResult(BaseModel):
    killed: bool


@router.post("/kill", response_model=KillResult)
async def kill_process(workspace_id: str, id: str) -> KillResult:
    """Stop a running background process."""
    killed = await preview_service.kill(workspace_id, id)
    if not killed:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "No such running background process"
        )
    return KillResult(killed=True)
