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

That per-read behaviour cuts the other way for a *non-streaming* call, which is
the second regression pinned here. Nothing arrives until generation finishes, so
there is no chunk to reset on and the read timeout silently becomes the total
request budget. Sharing the streaming stall value with one-shot callers
therefore capped whole-response latency at ``model_stream_stall_timeout`` —
observed in production as compaction runs aborting at exactly 300.0s having
received zero bytes, while the relay was still waiting and logged nothing. The
two regimes now have separate settings and separate clients; the tests below
pin that a slow one-shot response survives the stall timeout but is still
bounded by something.
"""

from __future__ import annotations

import asyncio
import socket

import httpx
import pytest

from app.agents import builder
from app.agents.builder import (
    _keepalive_socket_options,
    _model_http_timeout,
    _shared_local_http_client,
    _shared_openrouter_http_client,
    _summarizer_model,
    resolve_model,
)
from app.config import get_settings
from app.db.models import CustomProvider

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


async def _read_oneshot(port: int, *, read_timeout: float) -> bytes:
    """Await a whole non-streaming response, returning its body."""
    timeout = httpx.Timeout(timeout=30.0, connect=15.0, read=read_timeout)
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.get(f"http://127.0.0.1:{port}/")
        return response.content


def _silent_then_json(delay: float):
    """A server that sends nothing for ``delay``, then one complete response.

    The shape of every non-streaming model call: no bytes at all while the model
    prefills and generates, then the entire body at once.
    """

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        await reader.readuntil(b"\r\n\r\n")
        await asyncio.sleep(delay)
        body = b'{"ok": true}'
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: %d\r\n\r\n%s" % (len(body), body)
        )
        await writer.drain()
        writer.close()

    return handler


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


async def test_slow_oneshot_response_is_not_cut_off_by_the_stall_timeout():
    """A silent-then-complete response outlives the *streaming* stall value.

    The compaction regression in miniature: the server sends nothing at all for
    longer than the per-chunk stall timeout, then answers in full. Because there
    is no chunk to reset on, this passes only when the one-shot budget — not the
    stall timeout — is what bounds the call.
    """
    delay = _TEST_READ_TIMEOUT * 2  # well past the streaming stall ceiling

    server, port = await _serve_once(_silent_then_json(delay))
    try:
        body = await _read_oneshot(port, read_timeout=_TEST_READ_TIMEOUT * 10)
        assert body == b'{"ok": true}'
    finally:
        server.close()


async def test_oneshot_read_timeout_is_the_total_budget():
    """The same call fails under the stall timeout — the bug being fixed.

    Pins *why* the two regimes cannot share a number: for a non-streaming
    response the read timeout bounds the whole request, so reusing the streaming
    value silently caps total latency at it.
    """
    delay = _TEST_READ_TIMEOUT * 2

    server, port = await _serve_once(_silent_then_json(delay))
    try:
        with pytest.raises(httpx.ReadTimeout):
            await asyncio.wait_for(
                _read_oneshot(port, read_timeout=_TEST_READ_TIMEOUT),
                timeout=_TEST_READ_TIMEOUT * 10,
            )
    finally:
        server.close()


@pytest.mark.parametrize("streaming", [True, False])
def test_model_timeout_is_finite_and_follows_settings(streaming):
    """The read ceiling exists and is driven by the tunable, not hardcoded."""
    settings = get_settings()
    timeout = _model_http_timeout(streaming=streaming)
    assert timeout.read is not None, "read=None strands a run on a dead socket"
    expected = (
        settings.model_stream_stall_timeout
        if streaming
        else settings.one_shot_request_timeout
    )
    assert timeout.read == expected
    # Setup faults must still surface quickly rather than inheriting the ceiling.
    assert timeout.connect is not None
    assert timeout.connect < timeout.read


def test_oneshot_budget_exceeds_the_streaming_stall_timeout():
    """The one-shot budget must be the looser of the two.

    A one-shot call waits out prefill *and* the whole generation with nothing on
    the wire, so anything at or below the stall value would reintroduce the cap
    this split exists to remove.
    """
    settings = get_settings()
    assert settings.one_shot_request_timeout > settings.model_stream_stall_timeout


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
@pytest.mark.parametrize("streaming", [True, False])
def test_shared_clients_are_reused_and_bounded(factory, streaming):
    """Both shared clients carry the finite ceiling, and are not rebuilt per call.

    The clients are process-shared precisely because OpenAIProvider does not own
    a passed-in client and the agent is rebuilt every turn, so a fresh client
    per turn would leak connections.
    """
    settings = get_settings()
    client = factory(streaming=streaming)
    assert client is factory(streaming=streaming)
    assert client.timeout.read is not None
    assert client.timeout.read == (
        settings.model_stream_stall_timeout
        if streaming
        else settings.one_shot_request_timeout
    )


@pytest.mark.parametrize(
    "factory", [_shared_local_http_client, _shared_openrouter_http_client]
)
def test_streaming_and_oneshot_clients_are_distinct(factory):
    """The regimes must not share a client — the timeout is baked in at build.

    Handing a one-shot caller the streaming client is precisely the bug: it
    cannot be corrected per-request, because httpx fixes the timeout when the
    client is constructed.
    """
    assert factory(streaming=True) is not factory(streaming=False)


# --- wiring: the regime must survive the trip through resolve_model ----------
#
# The settings split is inert if a call site forgets to ask for it, and a
# forgotten flag fails silently — the call just inherits the streaming ceiling
# again. These pin the wiring end to end rather than the timeout in isolation.


def _httpx_client_of(model) -> httpx.AsyncClient:
    """The httpx client a resolved pydantic-ai model will actually send on."""
    return model.client._client


def _custom_providers() -> dict[str, CustomProvider]:
    return {"p1": CustomProvider(id="p1", name="local", base_url="http://127.0.0.1:9/v1")}


@pytest.mark.parametrize("streaming", [True, False])
def test_resolve_model_wires_the_openrouter_client_for_its_regime(streaming):
    model = resolve_model("openrouter:test/model", {}, streaming=streaming)
    assert _httpx_client_of(model) is _shared_openrouter_http_client(streaming=streaming)


@pytest.mark.parametrize("streaming", [True, False])
def test_resolve_model_wires_the_local_client_for_its_regime(streaming):
    model = resolve_model("custom:p1:llama", _custom_providers(), streaming=streaming)
    assert _httpx_client_of(model) is _shared_local_http_client(streaming=streaming)


def test_unknown_provider_fallback_keeps_the_regime():
    """The internal re-resolve must not silently drop back to streaming."""
    model = resolve_model("custom:missing:llama", {}, streaming=False)
    assert _httpx_client_of(model) is _shared_openrouter_http_client(streaming=False)


def test_summarizer_model_is_wired_one_shot():
    """Compaction is the call that was aborting at exactly the stall timeout."""
    model = _summarizer_model("openrouter:small/model", {}, fallback="unused")
    assert _httpx_client_of(model) is _shared_openrouter_http_client(streaming=False)


def test_summarizer_fallback_is_rebuilt_on_the_one_shot_client(monkeypatch):
    """The local-only path must not reuse the run's streaming-wired model.

    When the compaction model can't be built (no OpenRouter key), compaction
    falls back to the run's own model — which was resolved for the streaming
    turn. Taking it verbatim would reinstate the very cap this split removes, on
    exactly the installs that hit it.
    """
    real = builder.resolve_model

    def flaky(model_str, providers, *, streaming=True):
        if model_str == "openrouter:unavailable/model":
            raise RuntimeError("no API key configured")
        return real(model_str, providers, streaming=streaming)

    monkeypatch.setattr(builder, "resolve_model", flaky)

    run_model = real("openrouter:run/model", {})  # the streaming turn's model
    summarizer = _summarizer_model(
        "openrouter:unavailable/model",
        {},
        fallback=run_model,
        fallback_model_str="openrouter:run/model",
    )

    assert summarizer is not run_model
    assert _httpx_client_of(summarizer) is _shared_openrouter_http_client(streaming=False)


def test_summarizer_fallback_without_a_string_still_returns_something():
    """No rebuild possible: a streaming-wired summarizer beats no compaction."""
    run_model = resolve_model("openrouter:run/model", {})
    summarizer = _summarizer_model("custom:missing-and-broken", {}, fallback=run_model)
    assert summarizer is not None
