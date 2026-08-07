"""HTTP surface for the top-level Assistant.

Deliberately tiny, and it stays that way because the Assistant is backed by a
real workspace rather than a bespoke surface. Its conversations are ordinary
:class:`~app.db.models.Thread` rows in that workspace, so ``GET /api/threads``,
``POST /api/threads`` and ``POST /api/threads/{id}/chat`` already serve them —
history, persistence, SSE fan-out, reconnect, ``/stop`` and compaction all come
from the paths every other agent uses.

What is left is the one thing nothing else does: settling the confirmation cards
its destructive tools block on (:mod:`app.assistant.confirm`).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.assistant.confirm import confirmations

router = APIRouter(prefix="/assistant", tags=["assistant"])


class ConfirmDecision(BaseModel):
    approved: bool


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
