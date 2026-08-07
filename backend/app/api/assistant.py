"""HTTP surface for the top-level Assistant.

Deliberately small. Chat itself is **not** here: an Assistant conversation is an
ordinary :class:`~app.db.models.Thread` and goes through
``POST /api/threads/{id}/chat`` like every other run, which is what lets it reuse
persistence, SSE fan-out, reconnect, ``/stop`` and compaction unchanged. All this
module does is find the thread to talk to and settle confirmation cards.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.assistant.confirm import confirmations
from app.assistant.identity import (
    ASSISTANT_AGENT_ID,
    ASSISTANT_WORKSPACE_ID,
    ensure_assistant_records,
)
from app.db.models import Thread
from app.db.session import get_session
from app.schemas.thread import ThreadRead

router = APIRouter(prefix="/assistant", tags=["assistant"])


class ConfirmDecision(BaseModel):
    approved: bool


async def _ensure_thread(session: AsyncSession) -> Thread:
    """The Assistant's most recent conversation, creating one if there is none."""
    # Seeding is idempotent and runs at boot; repeating it here covers a client
    # that reaches this route on a database seeded by an older version.
    await ensure_assistant_records(session)
    existing = (
        (
            await session.execute(
                select(Thread)
                .where(Thread.workspace_id == ASSISTANT_WORKSPACE_ID)
                .order_by(Thread.updated_at.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    if existing is not None:
        return existing
    thread = Thread(
        title="Assistant",
        workspace_id=ASSISTANT_WORKSPACE_ID,
        agent_id=ASSISTANT_AGENT_ID,
    )
    session.add(thread)
    await session.commit()
    await session.refresh(thread)
    return thread


@router.get("/thread", response_model=ThreadRead)
async def get_assistant_thread(session: AsyncSession = Depends(get_session)):
    """The conversation the overlay opens on. Created on first use."""
    return ThreadRead.model_validate(await _ensure_thread(session), from_attributes=True)


@router.post("/threads", response_model=ThreadRead, status_code=status.HTTP_201_CREATED)
async def create_assistant_thread(session: AsyncSession = Depends(get_session)):
    """Start a fresh Assistant conversation."""
    await ensure_assistant_records(session)
    thread = Thread(
        title="Assistant",
        workspace_id=ASSISTANT_WORKSPACE_ID,
        agent_id=ASSISTANT_AGENT_ID,
    )
    session.add(thread)
    await session.commit()
    await session.refresh(thread)
    return ThreadRead.model_validate(thread, from_attributes=True)


@router.get("/threads", response_model=list[ThreadRead])
async def list_assistant_threads(session: AsyncSession = Depends(get_session)):
    """Past Assistant conversations, most recent first."""
    rows = (
        (
            await session.execute(
                select(Thread)
                .where(Thread.workspace_id == ASSISTANT_WORKSPACE_ID)
                .order_by(Thread.updated_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return [ThreadRead.model_validate(r, from_attributes=True) for r in rows]


@router.get("/confirmations")
async def list_confirmations(thread_id: str | None = None) -> list[dict]:
    """Confirmation cards still waiting on an answer.

    The card is published as a *sticky* stream event, so a reconnecting client
    normally gets it replayed (``agents/chat_run_manager.subscribe``). This is the
    recovery path for a client that has no stream open at all — a fresh tab, or
    one that reconnected after the run's buffer was evicted.
    """
    return confirmations.pending(thread_id)


@router.post("/confirm/{token}", status_code=status.HTTP_204_NO_CONTENT)
async def resolve_confirmation(token: str, decision: ConfirmDecision) -> None:
    """Approve or deny a pending destructive action, unblocking the waiting tool."""
    if not confirmations.resolve(token, approved=decision.approved):
        # Unknown or already settled. A 404 is the honest answer for a card whose
        # run is no longer waiting on it — including one that timed out.
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "That confirmation is no longer waiting for an answer.",
        )
