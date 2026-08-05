"""Raw TCP forwarding over the API socket, so a remote backend's dev servers are
reachable from the desktop app.

The problem this solves: when the backend runs on a VPS, an agent's dev server
comes up on ``127.0.0.1:5173`` *inside that host*. The Preview panel's existing
trick — rewrite a loopback host to whatever host served the page — assumes the
client can reach the port directly. Across the internet with only 443 open, it
can't.

The obvious fix is an HTTP reverse proxy at a path prefix. It is the wrong fix.
Vite, Next and friends emit root-absolute asset paths (``/@vite/client``,
``/_next/...``) and open their own HMR WebSocket, so a ``/proxy/5173/`` prefix
means rewriting HTML, CSS, JS and socket payloads and getting it right for every
framework. That is why Codespaces gives each port its own subdomain instead — and
per-port subdomains need wildcard DNS and a wildcard certificate on the server,
which is exactly the kind of setup the desktop app is supposed to save you.

So forward the port instead. This endpoint is one half of ``ssh -L``: the client
listens on the *same* port number locally, and pipes each TCP connection here over
its own WebSocket (see ``frontend/electron/port-forward.cjs``). The dev server then
answers on ``localhost:5173`` on the client machine, and every absolute path, HMR
socket and framework assumption holds because nothing was rewritten.

Scope of what this hands out: any TCP port on the backend host's **loopback
interface**. Two things make that the right line. It is not an increase in
privilege — anyone who can reach this route holds the token, and the token already
grants a PTY on the host via ``/api/terminal/ws``, which can reach the same ports
and more. And narrowing it to ports the preview service has detected would break
the Preview panel's type-your-own-address field, which is how you reach a server
the detector didn't spot. Non-loopback destinations *are* refused, so this cannot
be turned into a port scanner for the backend's private network.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect, WebSocketState

logger = logging.getLogger(__name__)

router = APIRouter(tags=["tunnel"])

# Chunk size for server → client reads. 64 KiB is large enough that a page load
# isn't dominated by frame overhead and small enough to keep memory flat under a
# few dozen concurrent connections.
_READ_CHUNK = 64 * 1024

# Close codes. 1008 (policy violation) is already used by the auth middleware for
# a bad token; these two say "your token was fine, the request wasn't".
_WS_BAD_PORT = 4400
_WS_UNREACHABLE = 4502

# How long to let each direction finish after the client side is closed, before
# cancelling it. Only reached by a direction wedged on a stalled peer.
_DRAIN_TIMEOUT = 5.0

# Text frame sent to the client when the forwarded service closes its end.
#
# The stream itself is binary, so a text frame is unambiguously out-of-band. It
# exists because **the server must not be the side that closes**: uvicorn's
# WebSocket close path does not drain frames already queued, so closing right after
# the last ``send_bytes`` throws that data away — observed against a dev server that
# replies and immediately hangs up (every HTTP/1.0 response, and anything sending
# ``Connection: close``), which arrived as an abnormal 1006 with the body missing.
#
# So we tell the client the stream ended and let *it* close. WebSocket frames are
# ordered, so receiving this marker means every preceding data frame has already
# arrived — a guarantee no timing workaround can offer.
_EOF_MARKER = "eof"


@router.websocket("/tunnel")
async def tunnel(websocket: WebSocket, port: int) -> None:
    """Pipe this WebSocket to ``127.0.0.1:{port}`` on the backend host.

    Authentication is the ``TokenAuthMiddleware``'s job — it runs outside every
    route and rejects the handshake before we are called, which is the whole reason
    it is middleware and not a dependency.
    """
    if not 1 <= port <= 65535:
        await websocket.close(code=_WS_BAD_PORT, reason="port out of range")
        return

    # Hardcoded, not a parameter. A caller-supplied host would turn an
    # authenticated preview helper into a way to reach anything the backend's
    # network can reach — a different and much larger grant than the one the
    # module docstring argues for.
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
    except OSError as exc:
        # Nothing listening is the common case (the dev server died, or the panel
        # was pointed at a port by hand), and it is the client's business, not an
        # error on our side.
        logger.debug("tunnel: cannot connect to 127.0.0.1:%d (%s)", port, exc)
        await websocket.close(code=_WS_UNREACHABLE, reason="connection refused")
        return

    await websocket.accept()

    async def upstream() -> None:
        """Client → dev server."""
        try:
            while True:
                message = await websocket.receive()
                kind = message["type"]
                if kind == "websocket.disconnect":
                    break
                data = message.get("bytes")
                if data is None:
                    # The forwarder only ever sends binary frames. A text frame is
                    # a client bug; encoding it would corrupt a byte stream, so
                    # treat it as the end of the conversation.
                    text = message.get("text")
                    if text is not None:
                        logger.warning("tunnel: text frame on a byte stream, closing")
                        break
                    continue
                writer.write(data)
                await writer.drain()
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
        finally:
            # Half-close so the dev server sees EOF and can finish its response
            # (some servers wait for it on a request without content-length).
            with contextlib.suppress(OSError, RuntimeError):
                if writer.can_write_eof():
                    writer.write_eof()

    async def downstream() -> None:
        """Dev server → client."""
        try:
            while True:
                chunk = await reader.read(_READ_CHUNK)
                if not chunk:
                    # End of stream. Say so and leave the closing to the client; see
                    # ``_EOF_MARKER`` for why closing here would lose the response.
                    await websocket.send_text(_EOF_MARKER)
                    break
                await websocket.send_bytes(chunk)
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass

    up = asyncio.create_task(upstream())
    down = asyncio.create_task(downstream())
    try:
        # Either direction ending ends the connection: a dev server that closed has
        # nothing more to say, and a client that vanished has nobody to say it to.
        await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)

        # The dev server finished and ``downstream`` has sent the EOF marker. Wait for
        # the client to close in response, which is what gets the queued response
        # frames flushed. Bounded, so a client that ignores the marker can't pin the
        # connection open — the close below is the backstop.
        if down.done() and not up.done():
            await asyncio.wait({up}, timeout=_DRAIN_TIMEOUT)
    finally:
        # ORDER MATTERS HERE, and getting it wrong silently truncates responses.
        #
        # Close the client side *first* and *gracefully*. Two reasons, both learned
        # the hard way against a real dev server:
        #
        # 1. `close()` flushes frames already queued on the transport before sending
        #    the close frame. Tearing the connection down first discards them, so a
        #    server that replies and immediately hangs up — every HTTP/1.0 response,
        #    and anything sending `Connection: close` — loses the tail of its reply,
        #    or all of it.
        # 2. It is what lets ``upstream`` finish on its own. Cancelling a task parked
        #    in ``websocket.receive()`` aborts uvicorn's connection mid-state-machine:
        #    the peer sees an abnormal 1006 close with no data, and uvicorn can go on
        #    to raise "Expected ASGI message 'websocket.send' or 'websocket.close'".
        #    Closing makes that pending receive return a disconnect instead.
        if websocket.client_state is WebSocketState.CONNECTED:
            with contextlib.suppress(Exception):
                await websocket.close()

        # Both directions should now end by themselves. Cancellation is the fallback
        # for one that is wedged (a `drain()` against a stalled peer), not the plan.
        _, pending = await asyncio.wait({up, down}, timeout=_DRAIN_TIMEOUT)
        for task in pending:
            task.cancel()
        with contextlib.suppress(Exception):
            await asyncio.gather(up, down, return_exceptions=True)

        writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()
