"""The model HTTP clients must survive slow streams but not dead ones.

Guards the regression where a conversation hung for 90 minutes: the shared
client for custom providers was built with ``read=None``, so when the TLS
connection to a remote model gateway died mid-stream — no FIN, socket left
ESTABLISHED with an empty receive queue — nothing anywhere held a stopwatch.
The turn never failed, so the goal loop never retried and the run never ended,
while the SSE keep-alive kept the UI's "running" pill spinning.

The fix is a *finite* read timeout, which works only because httpx applies it
per socket read rather than to the stream as a whole. That distinction is the
whole design, and it is not obvious from the config alone, so both halves are
pinned here against real sockets:

- a stream that keeps producing bytes outlives the timeout many times over
- a stream that stops producing bytes fails promptly

If httpx ever changed the read timeout to bound the whole response, the first
test would fail rather than silently reintroducing 600s-per-turn ceilings.
"""

from __future__ import annotations

import asyncio
import socket

import httpx
import pytest

from app.agents.builder import (
    _keepalive_socket_options,
    _model_http_timeout,
    _shared_local_http_client,
    _shared_openrouter_http_client,
)
from app.config import get_settings

# Short enough to keep the tests fast; the ratios below are what matter.
_TEST_READ_TIMEOUT = 0.75
_CHUNK_GAP = 0.05


def _response_head() -> bytes:
    return (
        b"HTTP/1.1 200 OK\r\n"
        b"Content-Type: text/event-stream\r\n"
        b"Transfer-Encoding: chunked\r\n\r\n"
    )


def _chunk(payload: bytes) -> bytes:
    return b"%x\r\n%s\r\n" % (len(payload), payload)


async def _serve_once(handler):
    """Start a one-shot HTTP server on a free port; yields the port."""
    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


async def _read_stream(port: int, *, read_timeout: float) -> int:
    """Consume a streamed response, returning the chunk count."""
    timeout = httpx.Timeout(timeout=30.0, connect=15.0, read=read_timeout)
    chunks = 0
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("GET", f"http://127.0.0.1:{port}/") as response:
            async for _ in response.aiter_bytes():
                chunks += 1
    return chunks


async def test_steady_stream_outlives_the_read_timeout():
    """A generation that keeps emitting tokens is never cut off.

    The stream runs for many multiples of the read timeout in total, but never
    pauses for longer than a fraction of it. This passes only if the timeout
    resets on each chunk -- i.e. it bounds *stalls*, not total duration.
    """
    total_chunks = 40  # 40 * 0.05s = ~2s, versus a 0.75s read timeout

    async def steady(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(_response_head())
        await writer.drain()
        for _ in range(total_chunks):
            writer.write(_chunk(b"data: token\n\n"))
            await writer.drain()
            await asyncio.sleep(_CHUNK_GAP)
        writer.write(b"0\r\n\r\n")
        await writer.drain()
        writer.close()

    server, port = await _serve_once(steady)
    try:
        chunks = await _read_stream(port, read_timeout=_TEST_READ_TIMEOUT)
        assert chunks >= total_chunks
    finally:
        server.close()


async def test_dead_stream_fails_instead_of_hanging():
    """A stream that goes silent mid-flight raises rather than waiting forever.

    Reproduces the original failure in miniature: headers and a first chunk
    arrive, then the peer stops speaking without closing the connection.
    """

    async def stalls(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(_response_head())
        await writer.drain()
        writer.write(_chunk(b"data: token\n\n"))
        await writer.drain()
        await asyncio.sleep(3600)  # dead upstream, connection left open

    server, port = await _serve_once(stalls)
    try:
        with pytest.raises(httpx.ReadTimeout):
            await asyncio.wait_for(
                _read_stream(port, read_timeout=_TEST_READ_TIMEOUT),
                # Generously above the read timeout: if httpx does not raise,
                # this fails as a timeout instead of hanging the suite.
                timeout=_TEST_READ_TIMEOUT * 10,
            )
    finally:
        server.close()


def test_model_timeout_is_finite_and_follows_settings():
    """The read ceiling exists and is driven by the tunable, not hardcoded."""
    timeout = _model_http_timeout()
    assert timeout.read is not None, "read=None strands a run on a dead socket"
    assert timeout.read == get_settings().model_stream_stall_timeout
    # Setup faults must still surface quickly rather than inheriting the ceiling.
    assert timeout.connect is not None
    assert timeout.connect < timeout.read


def test_keepalive_options_enable_probes_on_this_platform():
    """SO_KEEPALIVE is always set; per-platform tuning knobs are best-effort."""
    options = _keepalive_socket_options()
    assert (socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1) in options
    # Whatever else this platform exposes must be well-formed 3-tuples that the
    # httpx transport can apply verbatim.
    assert all(len(option) == 3 for option in options)
    assert len(options) > 1, "expected at least one TCP-level keep-alive knob"


@pytest.mark.parametrize(
    "factory", [_shared_local_http_client, _shared_openrouter_http_client]
)
def test_shared_clients_are_reused_and_bounded(factory):
    """Both shared clients carry the finite ceiling, and are not rebuilt per call.

    The clients are process-shared precisely because OpenAIProvider does not own
    a passed-in client and the agent is rebuilt every turn, so a fresh client
    per turn would leak connections.
    """
    client = factory()
    assert client is factory()
    assert client.timeout.read == get_settings().model_stream_stall_timeout
    assert client.timeout.read is not None
