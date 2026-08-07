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

**Health is a live signal, not a latch.** The URL and the ready flag used to be
decided once and never revisited, which made the green dot mean "this answered at
some point" rather than "this is serving". A dev server that crashed its child,
started erroring, or moved to another port kept its address and its green dot for
as long as the wrapper process stayed alive. Each ready server is therefore
re-probed on a slower cadence (:data:`_HEALTH_INTERVAL`), and a server that stops
answering has its log re-read before it is called unhealthy — a stopped port is the
exact moment a server is most likely to have *moved*, and the new address is
usually already printed in the log.

**Duplicates are reconciled from observed state.** ``DedupingLocalBackend`` prevents
a second spawn of the same command, but a dev server that finds its port taken does
not fail — it auto-increments and quietly runs alongside the first, which is how
several identical-looking ``npm run dev`` terminals accumulate. Prevention can't
catch that, because the collision only becomes visible after both are up. So once
two live processes are seen serving the same
:func:`~app.agents.service_key.service_key`, the older is retired (see
:meth:`PreviewService._retire_superseded`) — but only after the newer one is
actually ready, so a replacement that fails to boot never costs a working server.
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
from app.agents.service_key import service_key as derive_service_key

logger = logging.getLogger(__name__)

# How often to re-scan a workspace's backends while anything is live/watched.
_SCAN_INTERVAL = 1.5

# How often a settled server — up, or down — is re-probed. A server still
# *starting* is probed on every scan instead: someone is waiting on it, and it
# resolves in seconds. Once settled, checking a local socket every scan is needless
# traffic against the app the agent is building.
_HEALTH_INTERVAL = 5.0


@dataclass
class _Process:
    key: str  # composite "{backend_id}:{shell_id}"
    backend_id: str
    shell_id: str
    command: str
    # Epoch seconds when we first observed the process — a close proxy for its
    # start time (within one scan interval), used to show elapsed running time.
    started_at: float
    # Which service this process provides, inferred from its command. Two live
    # processes sharing one are duplicates; see `_retire_superseded`.
    service_key: str = ""
    url: str | None = None
    port: int | None = None
    # Has answered at least once, i.e. this is a server rather than a process that
    # merely printed something URL-shaped.
    ready: bool = False
    # Whether the *last* probe answered. Only meaningful once `ready`.
    healthy: bool = True
    # `time.monotonic()` of the last probe attempt, for the cadence above.
    last_probe: float = 0.0

    @property
    def status(self) -> str:
        """``running`` | ``starting`` | ``ready`` | ``unhealthy``.

        ``running`` is a background process that never advertised an address (a
        watcher, an ffmpeg job) — live, but not something to preview.
        """
        if self.url is None:
            return "running"
        if not self.ready:
            return "starting"
        return "ready" if self.healthy else "unhealthy"

    def as_dict(self) -> dict:
        status = self.status
        return {
            "id": self.key,
            "shellId": self.shell_id,
            "command": self.command,
            "startedAt": self.started_at,
            "serviceKey": self.service_key,
            "url": self.url,
            "port": self.port,
            "status": status,
            # Kept for clients predating `status`. Now means "serving right now"
            # rather than "has served at some point", which is what the flag was
            # always read as anyway.
            "ready": status == "ready",
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
        if not await self._kill_proc(state, proc):
            return False
        # Reflect the kill immediately rather than waiting for the next tick.
        await self._scan(workspace_id)
        return True

    @staticmethod
    async def _kill_proc(state: _WorkspaceState, proc: _Process) -> bool:
        """Stop one process and forget it, without rescanning.

        Split out of :meth:`kill` so :meth:`_retire_superseded` — which runs *inside*
        a scan — can reap a duplicate without recursing back into one.
        """
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
        if result:
            state.procs.pop(proc.key, None)
        return bool(result)

    def current_preview_url(self, workspace_id: str) -> str | None:
        """Best dev-server URL for a workspace, or ``None`` if none is known yet.

        Prefers a server that is serving *right now*; falls back to the most
        recently detected URL that isn't confirmed ready, so a server still booting
        is still offered rather than nothing. A server that has stopped answering is
        never preferred over one that hasn't — screenshotting a dead port produces a
        browser error page, which the vision model then dutifully describes.

        Used by the browser-QA tools (default target for ``open_app``/``view_app``)
        and by the goal-mode visual evaluator. Last one wins among equals, so a
        server started later in the run takes precedence over an earlier one.
        """
        state = self._ws.get(workspace_id)
        if state is None:
            return None
        for accept in (
            lambda p: p.status == "ready",
            lambda p: p.status == "starting",
            lambda p: p.url is not None,
        ):
            matches = [p.url for p in state.procs.values() if p.url and accept(p)]
            if matches:
                return matches[-1]
        return None

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
        now = time.monotonic()

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
                    command = getattr(info, "command", "") or ""
                    proc = _Process(
                        key=key,
                        backend_id=backend_id,
                        shell_id=shell_id,
                        command=command,
                        started_at=time.time(),
                        service_key=derive_service_key(command),
                    )
                    state.procs[key] = proc

                if proc.url is None:
                    # Scan stdout+stderr — webpack/CRA and friends print the
                    # served URL to stderr, not stdout.
                    parsed = parse_server_url(read_background_output(backend, shell_id))
                    if parsed is not None:
                        proc.url, proc.port = parsed

                if proc.url and self._probe_due(proc, now):
                    await self._probe(proc, backend, now)

            # Release an *older* backend whose processes have all exited. The
            # current run's backend (latest) is kept even when idle, so a server
            # the agent is about to start still gets tracked.
            if not any_live and backend_id != state.latest_backend_id:
                state.backends.pop(backend_id, None)

        # Drop processes whose shell vanished (exited, killed, or reaped).
        for key in [k for k in state.procs if k not in seen]:
            state.procs.pop(key, None)

        await self._retire_superseded(state)

        if self._signature(state) != before:
            self._broadcast(state)

    @staticmethod
    def _probe_due(proc: _Process, now: float) -> bool:
        """Whether ``proc`` should be probed on this tick.

        Only a server that is *starting* gets the fast cadence: someone is waiting
        on it and it resolves within seconds. Ready and unhealthy are both steady
        states — polling either on every scan buys nothing and, for a port that
        hangs rather than refuses, would stall the workspace's whole scan loop.
        """
        if proc.status == "starting":
            return True
        return now - proc.last_probe >= _HEALTH_INTERVAL

    @staticmethod
    async def _probe(proc: _Process, backend: object, now: float) -> None:
        """Re-check ``proc``'s address, following it if the server has moved.

        A server that stops answering is the one case where re-reading the log is
        worth it: a dev server restarting itself (a config change, a port conflict
        resolved on the second try) prints its new address, and
        :func:`parse_server_url` takes the *last* one it finds. Following that is
        what keeps a restart from stranding the Preview panel on a dead port.
        """
        proc.last_probe = now
        if await probe_ready(proc.url or ""):
            proc.ready = True
            proc.healthy = True
            return

        moved = parse_server_url(read_background_output(backend, proc.shell_id))
        if moved is not None and moved[0] != proc.url:
            # Back to "starting" on the new address; the next tick probes it.
            proc.url, proc.port = moved
            proc.ready = False
            proc.healthy = True
            return

        # Nowhere to follow. A server that had been serving is now down; one that
        # has never answered is simply still booting, and stays "starting".
        if proc.ready:
            proc.healthy = False

    async def _retire_superseded(self, state: _WorkspaceState) -> None:
        """Kill older duplicates of a service a newer process has taken over.

        Two live processes with the same inferred service key are the same server
        started twice — the second having landed on a different port, because a dev
        server whose port is taken auto-increments rather than failing. Spawn-time
        dedup cannot see this: the collision only exists once both are running.

        Deliberately cautious, because this kills something the user might be
        looking at. It fires only when the *newest* process for the service is
        confirmed serving, so a replacement that fails to boot leaves the incumbent
        alone; and only among processes that advertised an address, so a watcher or
        a build job is never touched.
        """
        by_service: dict[str, list[_Process]] = {}
        for proc in state.procs.values():
            if proc.url and proc.service_key:
                by_service.setdefault(proc.service_key, []).append(proc)

        for procs in by_service.values():
            if len(procs) < 2:
                continue
            procs.sort(key=lambda p: p.started_at)
            newest = procs[-1]
            if newest.status != "ready":
                continue
            for stale in procs[:-1]:
                logger.info(
                    "retiring duplicate dev server %s (%s) — superseded by %s (%s)",
                    stale.key,
                    stale.url,
                    newest.key,
                    newest.url,
                )
                await self._kill_proc(state, stale)

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
        """What a subscriber can see. A change here — including one a re-probe
        caused, such as ready → unhealthy — is what triggers a broadcast."""
        return tuple(
            sorted(
                (p.key, p.command, p.url or "", p.status) for p in state.procs.values()
            )
        )

    def _broadcast(self, state: _WorkspaceState) -> None:
        snapshot = self._snapshot(state)
        for queue in list(state.subscribers):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(snapshot)


# Module-level singleton shared across requests.
preview_service = PreviewService()
