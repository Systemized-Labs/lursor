"""TCP forwarding over the API socket (``app/api/tunnel.py``).

Exercised against a throwaway TCP server on a loopback port, which is exactly the
shape of the real thing: a dev server the agent started, reachable only from the
backend host.

``TestClient`` runs the ASGI app on its own event loop in a background thread, so
the echo server here is a plain ``socketserver`` in yet another thread rather than
an asyncio one — mixing a test-owned loop with the client's leads to tests that
pass alone and hang in a suite.
"""

from __future__ import annotations

import socket
import socketserver
import threading
from collections.abc import Iterator

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import app


class _EchoHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        while True:
            data = self.request.recv(4096)
            if not data:
                return
            self.request.sendall(data.upper())


@pytest.fixture
def echo_port() -> Iterator[int]:
    """A loopback TCP server that upper-cases whatever it is sent."""
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _EchoHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture
def closed_port() -> int:
    """A port with nothing listening: bound to find a free one, then released."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


def test_bytes_round_trip(client: TestClient, echo_port: int) -> None:
    with client.websocket_connect(f"/api/tunnel?port={echo_port}") as ws:
        ws.send_bytes(b"hello dev server")
        assert ws.receive_bytes() == b"HELLO DEV SERVER"


def test_multiple_writes_stream(client: TestClient, echo_port: int) -> None:
    """A byte stream, not a request/response pair — an HTTP proxy needs both ways
    to stay open across many frames."""
    with client.websocket_connect(f"/api/tunnel?port={echo_port}") as ws:
        for i in range(5):
            payload = f"chunk-{i}".encode()
            ws.send_bytes(payload)
            assert ws.receive_bytes() == payload.upper()


def test_binary_safe(client: TestClient, echo_port: int) -> None:
    """Bytes that aren't valid UTF-8 must survive: most of what a dev server sends
    (images, fonts, compressed responses) isn't text."""
    with client.websocket_connect(f"/api/tunnel?port={echo_port}") as ws:
        ws.send_bytes(bytes(range(256)))
        assert ws.receive_bytes() == bytes(range(256)).upper()


class _ReplyThenCloseHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        data = self.request.recv(4096)
        self.request.sendall(b"REPLY:" + data)
        # Hang up immediately, the way an HTTP/1.0 server or any `Connection: close`
        # response does.
        self.request.close()


@pytest.fixture
def reply_then_close_port() -> Iterator[int]:
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _ReplyThenCloseHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_reply_survives_an_immediate_upstream_close(
    client: TestClient, reply_then_close_port: int
) -> None:
    """The response must arrive even when the service hangs up straight after it.

    This is a regression test for a real data-loss bug, found against a dev server on
    a remote host rather than by any unit test: the tunnel used to close the
    WebSocket as soon as the upstream hit EOF, and uvicorn's close path does not
    drain frames already queued — so the reply was silently discarded and the client
    saw an abnormal 1006 with an empty body. Every `HTTP/1.0` response and anything
    sending `Connection: close` would have been affected, intermittently, depending
    on whether the flush happened to win the race.

    The fix is that the backend never closes mid-stream; it sends `_EOF_MARKER` and
    lets the client close. Frame ordering then guarantees the body arrives first.
    """
    with client.websocket_connect(f"/api/tunnel?port={reply_then_close_port}") as ws:
        ws.send_bytes(b"hello")
        assert ws.receive_bytes() == b"REPLY:hello"
        # The marker comes after the payload, which is the whole point.
        assert ws.receive_text() == "eof"


def test_eof_marker_is_text_so_it_cannot_be_mistaken_for_payload(
    client: TestClient, reply_then_close_port: int
) -> None:
    """A binary stream plus a text control frame — the client tells them apart by
    frame type, so no byte sequence in a response can spoof end-of-stream."""
    with client.websocket_connect(f"/api/tunnel?port={reply_then_close_port}") as ws:
        # Ask the upstream to echo back the marker's own bytes.
        ws.send_bytes(b"eof")
        payload = ws.receive()
        # From the client's side of the ASGI channel, what the server sends arrives
        # as "websocket.send".
        assert payload["type"] == "websocket.send"
        assert payload.get("bytes") == b"REPLY:eof"
        assert payload.get("text") is None

        marker = ws.receive()
        assert marker.get("text") == "eof"
        assert marker.get("bytes") is None


def test_closed_port_is_refused(client: TestClient, closed_port: int) -> None:
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/api/tunnel?port={closed_port}"):
            pass
    assert exc.value.code == 4502


@pytest.mark.parametrize("port", [0, -1, 65536, 999999])
def test_out_of_range_ports_are_refused(client: TestClient, port: int) -> None:
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/api/tunnel?port={port}"):
            pass
    assert exc.value.code == 4400


def test_non_numeric_port_is_rejected(client: TestClient) -> None:
    """FastAPI validates the query parameter before the handler runs."""
    with pytest.raises(Exception):  # noqa: B017 — the transport's own validation error
        with client.websocket_connect("/api/tunnel?port=not-a-port"):
            pass


def test_no_host_parameter_is_honoured(client: TestClient, echo_port: int) -> None:
    """The destination host is hardcoded to loopback.

    Passing ``host`` must not redirect the tunnel anywhere — if it ever did, an
    authenticated preview helper would become a way to reach the backend's whole
    private network. An ignored parameter still connects to the loopback echo
    server, which is the assertion.
    """
    with client.websocket_connect(
        f"/api/tunnel?port={echo_port}&host=example.com"
    ) as ws:
        ws.send_bytes(b"still local")
        assert ws.receive_bytes() == b"STILL LOCAL"
