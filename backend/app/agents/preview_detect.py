"""Pure helpers for detecting a dev server behind a background process.

Parsing (stdout → URL/port) and probing (is it serving yet?) live here so they
stay small and unit-testable. The long-lived polling/broadcast machinery that
uses them is :mod:`app.agents.preview_service`.
"""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import httpx

# Readiness probe: any HTTP response (even 404/500) means the socket is serving.
_PROBE_TIMEOUT = 2.0

# Cap how much stdout we read while hunting for a URL, so a server that logs a
# firehose before printing its address can't make us read an unbounded file.
_MAX_STDOUT_SCAN = 64 * 1024

# A server URL printed by common dev servers, e.g.
#   ➜  Local:   http://localhost:5173/
#   Uvicorn running on http://127.0.0.1:8000
#   - Local:        http://localhost:3000
_URL_RE = re.compile(
    r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d{2,5}))?\b",
    re.IGNORECASE,
)

# Fallback when only a bare port is printed, e.g. "listening on port 3000".
_PORT_RE = re.compile(
    r"(?:listening on|running at|server (?:started|running)|port)\D{0,12}(\d{2,5})",
    re.IGNORECASE,
)


def parse_server_url(text: str) -> tuple[str, int] | None:
    """Extract ``(url, port)`` for a local dev server from captured stdout.

    Prefers the *last* explicit ``http://…`` match — dev servers often print a
    proxy/network line after the canonical local one, and the final address is
    the one worth previewing. Host is normalized to ``localhost`` (not a literal
    IP) so the browser resolves it to whichever family the server actually bound:
    modern Vite/Node bind ``localhost`` to IPv6 ``::1``, and a hardcoded
    ``127.0.0.1`` would refuse to connect. Falls back to a bare-port heuristic.
    Returns ``None`` when no address is present yet (server still starting).
    """
    matches = list(_URL_RE.finditer(text))
    if matches:
        last = matches[-1]
        port = int(last.group(1)) if last.group(1) else 80
        return f"http://localhost:{port}", port

    port_match = _PORT_RE.search(text)
    if port_match:
        port = int(port_match.group(1))
        if 1 <= port <= 65535:
            return f"http://localhost:{port}", port
    return None


def _read_stream(backend, shell_id: str, attr: str, limit: int) -> str:
    """Read a background shell's captured output file directly (tail only).

    The public ``read_background`` advances the shell's read offset, which would
    steal output from the agent's own ``read_output`` tool. Reading the backing
    file leaves the agent's cursor alone. Best-effort: reaches into the backend's
    private registry and returns ``""`` on any structural mismatch or IO error.
    """
    try:
        registry = getattr(backend, "_bg", None)
        proc = registry.get(shell_id) if registry else None
        stream_path = getattr(proc, attr, None)
        if not stream_path:
            return ""
        path = Path(stream_path)
        if not path.exists():
            return ""
        size = path.stat().st_size
        with path.open("rb") as fh:
            if size > limit:
                fh.seek(size - limit)
            return fh.read().decode("utf-8", errors="replace")
    except Exception:  # pragma: no cover - defensive; detection is best-effort
        return ""


def read_background_output(backend, shell_id: str, limit: int = _MAX_STDOUT_SCAN) -> str:
    """Combined stdout+stderr tail for the process-details view (non-draining)."""
    stdout = _read_stream(backend, shell_id, "stdout_path", limit)
    stderr = _read_stream(backend, shell_id, "stderr_path", limit)
    if stderr.strip():
        return f"{stdout}\n[stderr]\n{stderr}" if stdout else stderr
    return stdout


# Loopback hosts a dev server may advertise; all point at "this machine".
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "0.0.0.0"})


def _probe_candidates(url: str) -> list[str]:
    """The URL plus loopback-family alternates, so a server bound to only IPv4
    *or* only IPv6 is still reached.

    ``localhost`` resolves to whichever family the OS prefers (``::1`` on modern
    macOS), so probing the advertised URL alone can miss a server listening on
    the other family. For a loopback host we also probe ``127.0.0.1`` and
    ``[::1]`` explicitly.
    """
    parts = urlsplit(url)
    candidates = [url]
    if (parts.hostname or "") in _LOOPBACK_HOSTS:
        port = f":{parts.port}" if parts.port else ""
        for host in ("127.0.0.1", "[::1]"):
            alt = urlunsplit((parts.scheme, f"{host}{port}", parts.path or "", "", ""))
            if alt not in candidates:
                candidates.append(alt)
    return candidates


async def probe_ready(url: str) -> bool:
    """True once ``url`` answers any HTTP response; False if not serving yet.

    Tries the advertised URL and, for a loopback host, both IP families — a Vite
    server on ``::1`` would otherwise never look ready when probed on IPv4.
    """
    async with httpx.AsyncClient(follow_redirects=False) as client:
        for candidate in _probe_candidates(url):
            try:
                await client.get(candidate, timeout=_PROBE_TIMEOUT)
                return True
            except Exception:
                continue
    return False
