"""Bearer-token auth (``app/auth.py``).

These build their own tiny app rather than using the ``client`` fixture, for one
structural reason: ``get_settings`` is ``lru_cache``d and ``app.main`` reads
``auth_token`` at import to decide whether to install the middleware at all, so
the shared app object is permanently the no-token build. That is the right thing
for the rest of the suite — every other test file asserts unauthenticated
behaviour and must keep passing untouched, which is this feature's main
regression guarantee — and it means the token build has to be assembled here.

Assembling it here also puts the middleware *ordering* under test directly, which
is the part with a history: see the note in ``app/main.py``.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.auth import SUBPROTOCOL_PREFIX, TokenAuthMiddleware

TOKEN = "test-token-urlsafe-abc123"
WRONG = "test-token-urlsafe-abc124"


def build_app(token: str | None) -> FastAPI:
    """A stand-in for ``app.main``, wired in the same order for the same reasons."""
    app = FastAPI()

    if token:
        app.add_middleware(TokenAuthMiddleware, token=token)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=".*",
        allow_credentials=not token,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.websocket("/api/ws")
    async def ws(websocket: WebSocket) -> None:
        # Deliberately a bare ``accept()`` with no subprotocol argument — the four
        # real WebSocket routes all look like this, and the point of doing the
        # subprotocol echo in middleware is that they never have to change.
        await websocket.accept()
        await websocket.send_json({"hello": "world"})
        await websocket.close()

    return app


@pytest.fixture
def authed() -> TestClient:
    return TestClient(build_app(TOKEN))


@pytest.fixture
def open_app() -> TestClient:
    return TestClient(build_app(None))


# --- HTTP ------------------------------------------------------------------


def test_no_token_rejects(authed: TestClient) -> None:
    res = authed.get("/api/health")
    assert res.status_code == 401
    assert res.json()["detail"]
    # Names the scheme, so a client can tell "wrong credential" from "wrong URL".
    assert res.headers["www-authenticate"].startswith("Bearer")


def test_correct_token_passes(authed: TestClient) -> None:
    res = authed.get("/api/health", headers={"Authorization": f"Bearer {TOKEN}"})
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


@pytest.mark.parametrize(
    "header",
    [
        f"Bearer {WRONG}",  # right shape, wrong secret
        f"bearer {TOKEN}",  # scheme is case-insensitive per RFC 7235
        f"Token {TOKEN}",  # wrong scheme
        TOKEN,  # no scheme at all
        "Bearer",  # no credential
        "Bearer ",
        "",
    ],
)
def test_bad_authorization_headers(authed: TestClient, header: str) -> None:
    res = authed.get("/api/health", headers={"Authorization": header})
    # The one that must *pass* is the lowercase scheme; everything else is a 401.
    expected = 200 if header == f"bearer {TOKEN}" else 401
    assert res.status_code == expected, header


def test_token_not_accepted_from_query_string_on_http(authed: TestClient) -> None:
    """The query fallback is WebSocket-only.

    A credential in an HTTP query string ends up in access logs, proxy traces and
    browser history, and unlike the WebSocket case there is no reason to allow it:
    every HTTP caller can set a header.
    """
    res = authed.get(f"/api/health?token={TOKEN}")
    assert res.status_code == 401


def test_401_carries_cors_headers(authed: TestClient) -> None:
    """The ordering guarantee, asserted.

    If auth is ever registered *after* CORS it becomes the outer layer, this header
    goes missing, and the browser turns every 401 into ``TypeError: Failed to
    fetch`` — an auth failure that reads as the backend being down.
    """
    res = authed.get("/api/health", headers={"Origin": "file://"})
    assert res.status_code == 401
    assert res.headers["access-control-allow-origin"] == "file://"


def test_preflight_needs_no_token(authed: TestClient) -> None:
    """A browser cannot attach ``Authorization`` to a preflight, so it must pass."""
    res = authed.options(
        "/api/health",
        headers={
            "Origin": "file://",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == "file://"


def test_credentials_not_allowed_when_token_set(authed: TestClient) -> None:
    res = authed.get(
        "/api/health",
        headers={"Authorization": f"Bearer {TOKEN}", "Origin": "file://"},
    )
    assert "access-control-allow-credentials" not in res.headers


# --- WebSocket -------------------------------------------------------------


def test_ws_rejected_without_token(authed: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as exc:
        with authed.websocket_connect("/api/ws"):
            pass
    assert exc.value.code == 1008


def test_ws_rejected_with_wrong_subprotocol_token(authed: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect):
        with authed.websocket_connect(
            "/api/ws", subprotocols=[f"{SUBPROTOCOL_PREFIX}{WRONG}"]
        ):
            pass


def test_ws_accepts_subprotocol_token_and_echoes_it(authed: TestClient) -> None:
    offered = f"{SUBPROTOCOL_PREFIX}{TOKEN}"
    with authed.websocket_connect("/api/ws", subprotocols=[offered]) as ws:
        assert ws.accepted_subprotocol == offered
        assert ws.receive_json() == {"hello": "world"}


def test_ws_accepts_query_token(authed: TestClient) -> None:
    """For ``websocat`` and friends, which can't offer a subprotocol as easily."""
    with authed.websocket_connect(f"/api/ws?token={TOKEN}") as ws:
        assert ws.receive_json() == {"hello": "world"}
        # Nothing was offered, so nothing is selected.
        assert ws.accepted_subprotocol is None


def test_ws_accepts_header_token(authed: TestClient) -> None:
    with authed.websocket_connect(
        "/api/ws", headers={"Authorization": f"Bearer {TOKEN}"}
    ) as ws:
        assert ws.receive_json() == {"hello": "world"}


# --- the default build -----------------------------------------------------


def test_open_app_unchanged(open_app: TestClient) -> None:
    """No token configured means no middleware and no behaviour change."""
    assert open_app.get("/api/health").status_code == 200
    with open_app.websocket_connect("/api/ws") as ws:
        assert ws.receive_json() == {"hello": "world"}


def test_open_app_ignores_a_token(open_app: TestClient) -> None:
    """A client that sends one anyway (a stale saved connection) still works."""
    res = open_app.get("/api/health", headers={"Authorization": f"Bearer {TOKEN}"})
    assert res.status_code == 200
