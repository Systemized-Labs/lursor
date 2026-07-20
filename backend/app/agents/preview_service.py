"""Long-lived, per-workspace tracking of the agent's background processes.

Why this is not tied to a chat run: a process the agent starts with
``run_in_background`` (a dev server, a watcher) *outlives the turn that started
it*. A watcher scoped to the chat run would be torn down the moment the agent
finishes replying — and the chat SSE closes then too — so the process is
invisible right when the user wants to see it. This service instead lives at
module scope, keyed by workspace.

The chat endpoint :func:`register`\\s each run's backend as it starts. The
service holds a strong reference, so the ``LocalBackend`` and its background
process registry survive past the run (the OS process was already detached).
A per-workspace poll loop scans those backends and broadcasts the current list
of *running* background processes to every subscriber (the UI, over a
WebSocket). For each process it also parses stdout for a served URL and probes
it — so a dev server is surfaced with a starting/ready state and can be opened in
the Preview panel. Callers can also :func:`kill` a process or read its
:func:`output`. A backend is dropped once all its processes have exited.

Processes are keyed ``"{backend_id}:{shell_id}"`` so identical shell ids from
different runs never collide.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
import time
from dataclasses import dataclass, field

from app.agents.preview_detect import (
    parse_server_url,
    probe_ready,
    read_background_output,
)

logger = logging.getLogger(__name__)

# How often to re-scan a workspace's backends while anything is live/watched.
_SCAN_INTERVAL = 1.5


@dataclass
class _Process:
    key: str  # composite "{backend_id}:{shell_id}"
    backend_id: str
    shell_id: str
    command: str
    # Epoch seconds when we first observed the process — a close proxy for its
    # start time (within one scan interval), used to show elapsed running time.
    started_at: float
    url: str | None = None
    port: int | None = None
    ready: bool = False

    def as_dict(self) -> dict:
        return {
            "id": self.key,
            "shellId": self.shell_id,
            "command": self.command,
            "startedAt": self.started_at,
            "url": self.url,
            "port": self.port,
            "ready": self.ready,
        }


@dataclass
class _WorkspaceState:
    backends: dict[str, object] = field(default_factory=dict)  # backend_id -> backend
    procs: dict[str, _Process] = field(default_factory=dict)  # composite key -> process
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    task: asyncio.Task | None = None
    # The most-recently-registered backend (the current/last run). Kept alive
    # even while it has no processes, so the agent has time to start a server
    # after the run begins; older idle backends are pruned. Without this the
    # first scan (right after register, before any tool ran) would drop the
    # backend and the dev server started moments later would never be seen.
    latest_backend_id: str | None = None


class PreviewService:
    """Owns per-workspace scan loops and fans process lists out to watchers."""

    def __init__(self) -> None:
        self._ws: dict[str, _WorkspaceState] = {}

    # --- registration ------------------------------------------------------------

    def register(self, workspace_id: str, backend: object) -> None:
        """Track ``backend`` for ``workspace_id`` and make sure a poll loop runs.

        Called when a chat run starts. Holding the backend keeps its background
        processes inspectable after the run ends. Idempotent per backend id.
        """
        if backend is None or not workspace_id:
            return
        state = self._ws.setdefault(workspace_id, _WorkspaceState())
        backend_id = self._backend_id(backend)
        state.backends[backend_id] = backend
        state.latest_backend_id = backend_id
        self._ensure_task(workspace_id)

    # --- subscription ------------------------------------------------------------

    def subscribe(self, workspace_id: str) -> tuple[asyncio.Queue, list[dict]]:
        """Register a subscriber; returns its queue and the current snapshot."""
        state = self._ws.setdefault(workspace_id, _WorkspaceState())
        queue: asyncio.Queue = asyncio.Queue(maxsize=64)
        state.subscribers.add(queue)
        self._ensure_task(workspace_id)
        return queue, self._snapshot(state)

    def unsubscribe(self, workspace_id: str, queue: asyncio.Queue) -> None:
        state = self._ws.get(workspace_id)
        if state is None:
            return
        state.subscribers.discard(queue)

    # --- process control ---------------------------------------------------------

    async def kill(self, workspace_id: str, process_id: str) -> bool:
        """Stop a tracked background process. Returns True if it was running."""
        state = self._ws.get(workspace_id)
        proc = state.procs.get(process_id) if state else None
        if state is None or proc is None:
            return False
        backend = state.backends.get(proc.backend_id)
        killer = getattr(backend, "kill_background", None)
        if not callable(killer):
            return False
        try:
            result = killer(proc.shell_id)
            if inspect.isawaitable(result):
                result = await result
        except Exception:
            return False
        # Reflect the kill immediately rather than waiting for the next tick.
        await self._scan(workspace_id)
        return bool(result)

    def output(self, workspace_id: str, process_id: str) -> str | None:
        """Return the captured stdout+stderr tail for a process, or None."""
        state = self._ws.get(workspace_id)
        proc = state.procs.get(process_id) if state else None
        if state is None or proc is None:
            return None
        backend = state.backends.get(proc.backend_id)
        if backend is None:
            return None
        return read_background_output(backend, proc.shell_id)

    # --- internals ---------------------------------------------------------------

    @staticmethod
    def _backend_id(backend: object) -> str:
        return str(getattr(backend, "id", None) or id(backend))

    @staticmethod
    def _snapshot(state: _WorkspaceState) -> list[dict]:
        return [p.as_dict() for p in state.procs.values()]

    def _ensure_task(self, workspace_id: str) -> None:
        state = self._ws[workspace_id]
        if state.task is None or state.task.done():
            state.task = asyncio.create_task(self._poll_loop(workspace_id))

    async def _poll_loop(self, workspace_id: str) -> None:
        state = self._ws[workspace_id]
        try:
            while True:
                await self._scan(workspace_id)
                # No running processes and nobody watching — let the loop retire;
                # a future register()/subscribe() spins it back up. (The retained
                # latest backend is ignored here, else the loop would never idle.)
                if not state.procs and not state.subscribers:
                    break
                await asyncio.sleep(_SCAN_INTERVAL)
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - never let detection wedge
            logger.exception("preview poll loop crashed for workspace %s", workspace_id)
        finally:
            state.task = None

    async def _scan(self, workspace_id: str) -> None:
        state = self._ws[workspace_id]
        before = self._signature(state)
        seen: set[str] = set()

        for backend_id, backend in list(state.backends.items()):
            infos = self._list_background(backend)
            if inspect.isawaitable(infos):
                with contextlib.suppress(Exception):
                    infos = await infos
            if not isinstance(infos, (list, tuple)):
                infos = []

            any_live = False
            for info in infos:
                shell_id = getattr(info, "shell_id", None)
                if not shell_id:
                    continue
                # Only running processes are surfaced; an exited one drops off.
                if not getattr(info, "running", False):
                    continue
                any_live = True
                key = f"{backend_id}:{shell_id}"
                seen.add(key)

                proc = state.procs.get(key)
                if proc is None:
                    proc = _Process(
                        key=key,
                        backend_id=backend_id,
                        shell_id=shell_id,
                        command=getattr(info, "command", "") or "",
                        started_at=time.time(),
                    )
                    state.procs[key] = proc

                if proc.url is None:
                    # Scan stdout+stderr — webpack/CRA and friends print the
                    # served URL to stderr, not stdout.
                    parsed = parse_server_url(read_background_output(backend, shell_id))
                    if parsed is not None:
                        proc.url, proc.port = parsed

                if proc.url and not proc.ready and await probe_ready(proc.url):
                    proc.ready = True

            # Release an *older* backend whose processes have all exited. The
            # current run's backend (latest) is kept even when idle, so a server
            # the agent is about to start still gets tracked.
            if not any_live and backend_id != state.latest_backend_id:
                state.backends.pop(backend_id, None)

        # Drop processes whose shell vanished (exited, killed, or reaped).
        for key in [k for k in state.procs if k not in seen]:
            state.procs.pop(key, None)

        if self._signature(state) != before:
            self._broadcast(state)

    @staticmethod
    def _list_background(backend: object):
        fn = getattr(backend, "list_background", None)
        if not callable(fn):
            return []
        try:
            return fn()
        except Exception:
            return []

    @staticmethod
    def _signature(state: _WorkspaceState) -> tuple:
        return tuple(
            sorted((p.key, p.command, p.url or "", p.ready) for p in state.procs.values())
        )

    def _broadcast(self, state: _WorkspaceState) -> None:
        snapshot = self._snapshot(state)
        for queue in list(state.subscribers):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(snapshot)


# Module-level singleton shared across requests.
preview_service = PreviewService()
