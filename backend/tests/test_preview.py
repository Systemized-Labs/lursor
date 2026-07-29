"""Dev-server preview detection.

Covers the two pieces that carry the logic: the stdout → URL/port parser and the
long-lived :class:`PreviewService` (register a backend, detect a running dev
server, broadcast it to subscribers, and drop it when the process exits). The
WebSocket endpoint itself is thin glue mirroring the file-watch socket and is not
exercised here (it would fight pytest's cross-event-loop TestClient).
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

import app.agents.preview_service as preview_service_mod
from app.agents.preview_detect import _probe_candidates, parse_server_url
from app.agents.preview_service import PreviewService, preview_service


@pytest.mark.parametrize(
    "text,expected",
    [
        # Host is normalized to `localhost` (not a literal IP) so the browser
        # reaches whichever family the server bound — Vite binds IPv6 `::1`.
        ("  ➜  Local:   http://localhost:5173/", ("http://localhost:5173", 5173)),
        (
            "Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C)",
            ("http://localhost:8000", 8000),
        ),
        ("- Local:        http://localhost:3000", ("http://localhost:3000", 3000)),
        # Wildcard bind is normalized to a framable loopback host.
        ("listening at http://0.0.0.0:4000", ("http://localhost:4000", 4000)),
        # Bare-port fallback when no scheme is printed.
        ("Server listening on port 3001", ("http://localhost:3001", 3001)),
        # Nothing to detect yet (server still booting).
        ("Starting compiler...", None),
    ],
)
def test_parse_server_url(text, expected):
    assert parse_server_url(text) == expected


def test_parse_server_url_prefers_last_url():
    """A proxy/network line printed after the local one wins — it's the real target."""
    text = "Local: http://localhost:3000\nNetwork: http://127.0.0.1:3005"
    assert parse_server_url(text) == ("http://localhost:3005", 3005)


def test_probe_candidates_covers_both_ip_families():
    """A loopback URL is probed on both IPv4 and IPv6, so a server bound to only
    one family (Vite → `::1`) is still detected as ready."""
    got = _probe_candidates("http://localhost:5173")
    assert got == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://[::1]:5173",
    ]
    # A non-loopback host is probed as-is, with no alternates invented.
    assert _probe_candidates("http://example.test:9000") == ["http://example.test:9000"]


class _Info:
    def __init__(self, shell_id: str, command: str, running: bool) -> None:
        self.shell_id = shell_id
        self.command = command
        self.running = running


class _Proc:
    def __init__(self, stdout_path) -> None:
        self.stdout_path = stdout_path


class _FakeBackend:
    """Mimics the LocalBackend surface the service reaches into."""

    def __init__(self, backend_id: str) -> None:
        self.id = backend_id
        self._bg: dict = {}
        self._infos: list[_Info] = []
        self.killed: list[str] = []

    def list_background(self) -> list[_Info]:
        return self._infos

    def kill_background(self, shell_id: str) -> bool:
        self.killed.append(shell_id)
        # Mark the process exited so the next scan drops it, like the real one.
        self._infos = [i for i in self._infos if i.shell_id != shell_id]
        return True


async def test_preview_service_detects_broadcasts_and_drops(tmp_path, monkeypatch):
    # Probe would otherwise hit the network; force "serving".
    async def _always_ready(_url: str) -> bool:
        return True

    monkeypatch.setattr(preview_service_mod, "probe_ready", _always_ready)

    log = tmp_path / "out.log"
    log.write_text("VITE ready\n  ➜  Local:   http://localhost:3001/\n")

    backend = _FakeBackend("be-A")
    backend._bg = {"bg_1": _Proc(log)}
    backend._infos = [_Info("bg_1", "npm run dev", True)]

    service = PreviewService()
    service.register("ws1", backend)
    queue, snapshot = service.subscribe("ws1")
    assert snapshot == []  # nothing detected yet on connect

    # First scan: process tracked, URL parsed, probe succeeds → ready, broadcast.
    await service._scan("ws1")
    msg = queue.get_nowait()
    assert len(msg) == 1
    proc = msg[0]
    assert proc["id"] == "be-A:bg_1"
    assert proc["command"] == "npm run dev"
    assert proc["url"] == "http://localhost:3001"
    assert proc["port"] == 3001
    assert proc["ready"] is True
    assert isinstance(proc["startedAt"], (int, float)) and proc["startedAt"] > 0

    # Process exits → drops out of the snapshot. The backend is kept because it
    # is still the latest (current-run) backend; a newer run supersedes it below.
    backend._infos = [_Info("bg_1", "npm run dev", False)]
    await service._scan("ws1")
    assert queue.get_nowait() == []
    assert "be-A" in service._ws["ws1"].backends

    # A newer run registers → be-A is no longer latest, so once idle it's pruned.
    service.register("ws1", _FakeBackend("be-A2"))
    await service._scan("ws1")
    assert "be-A" not in service._ws["ws1"].backends


async def test_preview_service_keeps_current_backend_until_server_starts(
    tmp_path, monkeypatch
):
    """Regression: register happens at run start, before any tool runs. The first
    scan sees no processes; the backend must NOT be dropped, or the dev server the
    agent starts moments later is never detected."""

    async def _always_ready(_url: str) -> bool:
        return True

    monkeypatch.setattr(preview_service_mod, "probe_ready", _always_ready)

    log = tmp_path / "out.log"
    log.write_text("")  # nothing yet — agent hasn't started the server

    backend = _FakeBackend("be-D")
    backend._bg = {"bg_1": _Proc(log)}
    backend._infos = []  # no background processes at run start

    service = PreviewService()
    service.register("ws4", backend)
    queue, _ = service.subscribe("ws4")

    # First scan (right after register): no processes, but the backend stays.
    await service._scan("ws4")
    assert "be-D" in service._ws["ws4"].backends
    assert queue.empty()

    # The agent now starts the dev server; the next scan detects it.
    log.write_text("Local: http://localhost:3000\n")
    backend._infos = [_Info("bg_1", "npm run dev", True)]
    await service._scan("ws4")
    msg = queue.get_nowait()
    assert len(msg) == 1 and msg[0]["url"] == "http://localhost:3000"


async def test_preview_service_tracks_process_without_url(tmp_path, monkeypatch):
    async def _never_ready(_url: str) -> bool:  # pragma: no cover - not reached
        return True

    monkeypatch.setattr(preview_service_mod, "probe_ready", _never_ready)

    log = tmp_path / "out.log"
    log.write_text("Compiling...\n")  # running, but no address printed yet

    backend = _FakeBackend("be-B")
    backend._bg = {"bg_1": _Proc(log)}
    backend._infos = [_Info("bg_1", "webpack --watch", True)]

    service = PreviewService()
    service.register("ws2", backend)
    queue, _ = service.subscribe("ws2")

    # A running process is tracked even with no URL (it's still a live terminal).
    await service._scan("ws2")
    msg = queue.get_nowait()
    assert len(msg) == 1
    assert msg[0]["url"] is None and msg[0]["command"] == "webpack --watch"


async def test_preview_service_kill_and_output(tmp_path, monkeypatch):
    async def _always_ready(_url: str) -> bool:
        return True

    monkeypatch.setattr(preview_service_mod, "probe_ready", _always_ready)

    log = tmp_path / "out.log"
    log.write_text("Local: http://localhost:5173\n")
    err = tmp_path / "err.log"
    err.write_text("a warning\n")

    class _Proc2:
        def __init__(self, out, errp):
            self.stdout_path = out
            self.stderr_path = errp

    backend = _FakeBackend("be-C")
    backend._bg = {"bg_1": _Proc2(log, err)}
    backend._infos = [_Info("bg_1", "npm run dev", True)]

    service = PreviewService()
    service.register("ws3", backend)
    service.subscribe("ws3")
    await service._scan("ws3")

    # Output combines stdout and stderr.
    out = service.output("ws3", "be-C:bg_1")
    assert "http://localhost:5173" in out and "a warning" in out
    assert service.output("ws3", "nope") is None

    # Kill stops the process and it drops from the tracked list.
    assert await service.kill("ws3", "be-C:bg_1") is True
    assert backend.killed == ["bg_1"]
    assert "be-C:bg_1" not in service._ws["ws3"].procs
    assert await service.kill("ws3", "be-C:bg_1") is False  # already gone


async def test_preview_rest_output_and_kill(client: AsyncClient, tmp_path, monkeypatch):
    """The output/kill REST endpoints drive the shared service end to end."""

    async def _always_ready(_url: str) -> bool:
        return True

    monkeypatch.setattr(preview_service_mod, "probe_ready", _always_ready)

    ws = (await client.post("/workspaces", json={"name": "Procs"})).json()
    wid = ws["id"]

    log = tmp_path / "out.log"
    log.write_text("Local: http://localhost:5199\n")
    backend = _FakeBackend("be-rest")
    backend._bg = {"bg_1": _Proc(log)}
    backend._infos = [_Info("bg_1", "npm run dev", True)]

    preview_service.register(wid, backend)
    await preview_service._scan(wid)  # populate the tracked process

    pid = "be-rest:bg_1"
    out = await client.get(f"/workspaces/{wid}/preview/output?id={pid}")
    assert out.status_code == 200
    assert "http://localhost:5199" in out.json()["output"]

    killed = await client.post(f"/workspaces/{wid}/preview/kill?id={pid}")
    assert killed.status_code == 200 and killed.json() == {"killed": True}
    assert backend.killed == ["bg_1"]

    # Unknown ids 404 on both endpoints.
    assert (await client.get(f"/workspaces/{wid}/preview/output?id=nope")).status_code == 404
    assert (await client.post(f"/workspaces/{wid}/preview/kill?id=nope")).status_code == 404
