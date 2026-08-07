"""In-chat confirmation for the Assistant's destructive actions.

Deleting a workspace, an agent, a schedule or a conversation stops and asks. The
protocol:

1. The tool calls :meth:`Confirmations.request`, which registers a pending entry
   and publishes an AG-UI ``CUSTOM`` event named ``assistant_confirm`` into the
   run's stream — the same mechanism the todo panel uses (``api/chat.py``).
2. The tool ``await``\\ s. This is safe because a run is a **detached task** that
   owns its own lifetime (``agents/chat_run_manager.py``); the HTTP response is
   only a subscriber, so a blocked tool holds nothing open and a client that
   hangs up does not cancel it.
3. The user clicks Approve or Deny, the frontend ``POST``\\ s to
   ``/api/assistant/confirm/{token}``, and :meth:`resolve` wakes the tool.
4. A resolution event goes out under the *same* sticky key, so a client that
   reconnects later sees a settled card rather than a live one.

Published with ``sticky_key`` deliberately: sticky events are replayed on every
reconnect even after the 5000-line buffer trims them away
(``ChatRunManager.subscribe``), which is what makes "refresh the page mid-prompt"
work rather than stranding a run on a card nobody can see any more.

Expiry is a denial, never a default-yes. :data:`CONFIRM_TIMEOUT` exists so a run
abandoned mid-prompt eventually releases instead of pinning a task forever.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from dataclasses import dataclass, field

from ag_ui.core import CustomEvent, EventType

from app.agents.chat_run_manager import chat_run_manager

logger = logging.getLogger(__name__)

# How long a card waits before it counts as a denial. Five minutes: long enough
# to read the impact line and think, short enough that an abandoned tab does not
# hold a run task open for the life of the process.
CONFIRM_TIMEOUT = 300.0

CONFIRM_EVENT_NAME = "assistant_confirm"


def _sticky_key(token: str) -> str:
    return f"{CONFIRM_EVENT_NAME}:{token}"


def _encode(payload: dict) -> str:
    """SSE-frame a CUSTOM event, matching the adapter's own encoding."""
    event = CustomEvent(type=EventType.CUSTOM, name=CONFIRM_EVENT_NAME, value=payload)
    return f"data: {event.model_dump_json(by_alias=True, exclude_none=True)}\n\n"


@dataclass
class PendingConfirmation:
    """One outstanding ask. ``event`` is set exactly once, by whichever of
    approve / deny / timeout gets there first."""

    token: str
    thread_id: str
    action: str  # the tool name, e.g. "lursor_delete_workspace"
    summary: str  # "Delete the workspace \"Scratch\""
    impact: str  # what else goes with it, in the user's terms
    event: asyncio.Event = field(default_factory=asyncio.Event)
    approved: bool = False
    resolved: bool = False


class Confirmations:
    """Process-wide registry of outstanding confirmations.

    In-memory only, like every other piece of run state here: a restart drops
    live runs anyway (``reconcile_interrupted_runs``), so a pending card that
    does not survive one is consistent with the rest of the system rather than a
    gap in it.
    """

    def __init__(self) -> None:
        self._pending: dict[str, PendingConfirmation] = {}

    async def request(
        self,
        thread_id: str,
        *,
        action: str,
        summary: str,
        impact: str,
        timeout: float | None = None,
    ) -> bool:
        """Ask the user, block until answered, and return whether to proceed.

        ``timeout`` resolves to :data:`CONFIRM_TIMEOUT` at *call* time, not as a
        default argument: a default binds the value at import, which would make
        the module constant unpatchable and the knob a lie.
        """
        if timeout is None:
            timeout = CONFIRM_TIMEOUT
        token = uuid.uuid4().hex
        pending = PendingConfirmation(
            token=token,
            thread_id=thread_id,
            action=action,
            summary=summary,
            impact=impact,
        )
        self._pending[token] = pending

        chat_run_manager.publish(
            thread_id,
            _encode(
                {
                    "token": token,
                    "action": action,
                    "summary": summary,
                    "impact": impact,
                    "status": "pending",
                    "timeoutSeconds": timeout,
                }
            ),
            sticky_key=_sticky_key(token),
        )

        try:
            await asyncio.wait_for(pending.event.wait(), timeout=timeout)
        except TimeoutError:
            logger.info("assistant confirmation %s timed out (%s)", token, action)
            pending.approved = False
            pending.resolved = True
            self._publish_settled(pending, outcome="timeout")
        finally:
            self._pending.pop(token, None)

        return pending.approved

    def resolve(self, token: str, *, approved: bool) -> bool:
        """Answer a pending confirmation. ``False`` if the token is unknown.

        Unknown covers both "never existed" and "already settled" — the caller
        turns either into a 404, which is the honest answer for a card the user
        is looking at that no longer has a run behind it.
        """
        pending = self._pending.get(token)
        if pending is None or pending.resolved:
            return False
        pending.approved = approved
        pending.resolved = True
        self._publish_settled(pending, outcome="approved" if approved else "denied")
        pending.event.set()
        return True

    def pending(self, thread_id: str | None = None) -> list[dict]:
        """Outstanding cards, for a client whose replay missed one."""
        return [
            {
                "token": p.token,
                "threadId": p.thread_id,
                "action": p.action,
                "summary": p.summary,
                "impact": p.impact,
            }
            for p in self._pending.values()
            if thread_id is None or p.thread_id == thread_id
        ]

    def _publish_settled(self, pending: PendingConfirmation, *, outcome: str) -> None:
        """Overwrite the sticky card with its outcome so a reconnect sees it settled."""
        with contextlib.suppress(Exception):
            chat_run_manager.publish(
                pending.thread_id,
                _encode(
                    {
                        "token": pending.token,
                        "action": pending.action,
                        "summary": pending.summary,
                        "impact": pending.impact,
                        "status": outcome,
                    }
                ),
                sticky_key=_sticky_key(pending.token),
            )


# Module-level singleton, shared across requests like ``chat_run_manager``.
confirmations = Confirmations()
