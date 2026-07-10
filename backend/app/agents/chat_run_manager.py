"""Keeps agent chat runs alive independently of the HTTP request.

A chat run normally lives and dies with the SSE response that drives it: when
the browser disconnects (tab close, conversation switch, reload) the streaming
generator is torn down and the agent run is cancelled with it. That makes it
impossible to leave a running conversation and come back to it.

This manager owns each run as a detached :class:`asyncio.Task`. The SSE response
is only a *subscriber*: it replays the events buffered so far, then follows the
live stream. Disconnecting merely unsubscribes — the run keeps going.
Reconnecting re-subscribes and replays. Runs are keyed by ``thread_id`` (one
active run per thread).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable

logger = logging.getLogger(__name__)

# "running" while in flight; one of the terminal states once done.
RunStatus = str  # "running" | "finished" | "error" | "stopped"

_MAX_BUFFER_EVENTS = 5000  # cap per-thread replay buffer
_TRIM_CHUNK = 1000  # drop this many oldest lines when the cap is hit (amortised O(1))
_MAX_FINISHED_RETAINED = 200  # terminal threads kept around for reconnect-after-finish
_SENTINEL: None = None  # queue item signalling the run has ended


class ChatRunManager:
    """Owns background chat runs and fans their events out to SSE subscribers."""

    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._queues: dict[str, set[asyncio.Queue[str | None]]] = defaultdict(set)
        self._buffers: dict[str, list[str]] = {}
        self._status: dict[str, RunStatus] = {}
        self._finished_order: deque[str] = deque()

    # --- lifecycle ---------------------------------------------------------------

    def start_run(self, thread_id: str, driver: Callable[[], Awaitable[None]]) -> bool:
        """Spawn ``driver`` as a detached task for ``thread_id``.

        Returns ``False`` if a run is already active for this thread (the caller
        should answer 409) — the existing run keeps streaming untouched.
        """
        if self.is_running(thread_id):
            return False

        self._buffers[thread_id] = []
        self._status[thread_id] = "running"

        async def _wrapped() -> None:
            try:
                await driver()
            except asyncio.CancelledError:
                self.finish(thread_id, "stopped")
                raise
            except Exception:
                logger.exception("chat run driver crashed for thread %s", thread_id)
                self.finish(thread_id, "error")
            finally:
                self._tasks.pop(thread_id, None)

        self._tasks[thread_id] = asyncio.create_task(_wrapped())
        return True

    def is_running(self, thread_id: str) -> bool:
        return self._status.get(thread_id) == "running"

    def active_threads(self) -> list[str]:
        """Thread ids with a live background run (drives the UI's running badges)."""
        return [tid for tid, status in self._status.items() if status == "running"]

    async def stop(self, thread_id: str) -> bool:
        """Cancel the run for ``thread_id``. Returns ``False`` if none is active."""
        task = self._tasks.get(thread_id)
        if task is None or task.done():
            return False
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        return True

    # --- producer ----------------------------------------------------------------

    def publish(self, thread_id: str, encoded: str) -> None:
        """Buffer an encoded SSE line and push it to every live subscriber."""
        buffer = self._buffers.setdefault(thread_id, [])
        buffer.append(encoded)
        if len(buffer) > _MAX_BUFFER_EVENTS:
            del buffer[:_TRIM_CHUNK]
        for queue in self._queues.get(thread_id, set()):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(encoded)

    def finish(self, thread_id: str, status: RunStatus) -> None:
        """Mark the run terminal and close every subscriber. First status wins."""
        # cancel() + the driver's own finally can race; keep the first terminal state.
        if self._status.get(thread_id) not in (None, "running"):
            return
        self._status[thread_id] = status
        self._finished_order.append(thread_id)
        for queue in self._queues.get(thread_id, set()):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(_SENTINEL)
        self._evict_finished()

    def _evict_finished(self) -> None:
        while len(self._finished_order) > _MAX_FINISHED_RETAINED:
            old = self._finished_order.popleft()
            if self._status.get(old) == "running":
                continue  # re-run reused the id; keep it
            self._buffers.pop(old, None)
            self._status.pop(old, None)

    # --- consumer ----------------------------------------------------------------

    def subscribe(self, thread_id: str) -> tuple[asyncio.Queue[str | None], list[str]]:
        """Register a subscriber and snapshot the replay buffer.

        The snapshot and the registration happen with no ``await`` between them,
        so under asyncio's single-threaded loop no published event can slip
        through the gap between "what's replayed" and "what's streamed live".
        """
        queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=1024)
        replay = list(self._buffers.get(thread_id, []))
        self._queues[thread_id].add(queue)
        return queue, replay

    def unsubscribe(self, thread_id: str, queue: asyncio.Queue[str | None]) -> None:
        subscribers = self._queues.get(thread_id)
        if subscribers is None:
            return
        subscribers.discard(queue)
        if not subscribers:
            self._queues.pop(thread_id, None)


# Module-level singleton shared across requests.
chat_run_manager = ChatRunManager()
