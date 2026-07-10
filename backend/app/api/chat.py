"""AG-UI chat endpoint.

Streams a deep-agent run to the browser using the AG-UI protocol (SSE). The
frontend AG-UI client posts a ``RunAgentInput`` (message history + state); the
adapter runs the agent and streams AG-UI events back. We persist the incoming
user turn up front and the assistant turn on completion so threads can be
reloaded later.
"""

from __future__ import annotations

import contextlib

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic_ai.ui.ag_ui import AGUIAdapter
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import Response

from app.agents.builder import build_deep_agent
from app.db.models import Agent, Message, Thread, Workspace
from app.db.session import async_session_factory, get_session

router = APIRouter(prefix="/threads", tags=["chat"])


def _latest_user_text(run_input: dict) -> str:
    """Extract the newest user message text from an AG-UI RunAgentInput body."""
    for msg in reversed(run_input.get("messages", []) or []):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            return content if isinstance(content, str) else str(content)
    return ""


@router.post("/{thread_id}/chat")
async def chat(
    thread_id: str, request: Request, session: AsyncSession = Depends(get_session)
) -> Response:
    thread = await session.get(Thread, thread_id)
    if thread is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thread not found")

    agent_row = await session.get(Agent, thread.agent_id)
    workspace = await session.get(Workspace, thread.workspace_id)
    if agent_row is None or workspace is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Thread's agent or workspace is missing")

    # Persist the incoming user turn (best-effort; body is cached for re-read).
    with contextlib.suppress(Exception):
        body = await request.json()
        user_text = _latest_user_text(body)
        if user_text:
            session.add(Message(thread_id=thread_id, role="user", content=user_text))
            if thread.title == "New conversation":
                thread.title = user_text[:60]
                session.add(thread)
            await session.commit()

    agent, deps = build_deep_agent(agent_row, workspace.path)

    async def on_complete(result) -> None:
        """Persist the assistant turn once the run finishes."""
        output = getattr(result, "output", None)
        content = output if isinstance(output, str) else str(output) if output else ""
        if not content:
            return
        async with async_session_factory() as bg_session:
            bg_session.add(Message(thread_id=thread_id, role="assistant", content=content))
            await bg_session.commit()

    return await AGUIAdapter.dispatch_request(
        request, agent=agent, deps=deps, on_complete=on_complete
    )
