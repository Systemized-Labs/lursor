"""A server-side error has to reach the browser as an error.

When the agent build started failing on a malformed skill, the UI reported
``Failed to fetch`` — the message a browser gives for a *network* failure. The
backend was up and answering; the answer was simply unreadable.

Starlette's ``ServerErrorMiddleware`` is installed outside every other middleware,
so an unhandled exception is turned into a bare ``text/plain`` 500 *after*
``CORSMiddleware`` has been bypassed. No ``access-control-allow-origin``, so the
browser refuses the response and ``fetch`` rejects before any of our code sees a
status code. The real error existed only in a terminal, and every backend bug
looked identical to the backend being down.

So: unhandled errors are answered by our own handler, which sets the CORS headers
by hand, and the routes most likely to fail on user configuration catch their own
failure and say what broke.
"""

from __future__ import annotations

from fastapi import APIRouter
from httpx import AsyncClient

from app.main import app

ORIGIN = "http://localhost:8888"

_router = APIRouter()


@_router.get("/boom")
async def _boom() -> None:
    raise RuntimeError("something the user cannot see")


app.include_router(_router, prefix="/api/_test")


async def test_unhandled_error_is_json_the_browser_can_read(
    raising_client: AsyncClient,
) -> None:
    response = await raising_client.get("/_test/boom", headers={"origin": ORIGIN})

    assert response.status_code == 500
    # The header whose absence turned a 500 into "Failed to fetch".
    assert response.headers.get("access-control-allow-origin") == ORIGIN
    assert response.headers.get("access-control-allow-credentials") == "true"
    assert response.headers.get("content-type", "").startswith("application/json")
    detail = response.json()["detail"]
    assert "RuntimeError" in detail
    assert "something the user cannot see" in detail


async def test_the_origin_is_reflected_not_wildcarded(
    raising_client: AsyncClient,
) -> None:
    """Mirrors the CORS middleware: credentialed requests reject ``*``."""
    other = "http://127.0.0.1:5173"
    response = await raising_client.get("/_test/boom", headers={"origin": other})
    assert response.headers.get("access-control-allow-origin") == other
    assert "Origin" in response.headers.get("vary", "")


async def test_a_request_without_an_origin_still_gets_json(
    raising_client: AsyncClient,
) -> None:
    """Electron and curl send no ``Origin``; there is then nothing to reflect."""
    response = await raising_client.get("/_test/boom")
    assert response.status_code == 500
    assert "access-control-allow-origin" not in response.headers
    assert response.json()["detail"]


async def test_a_handled_error_is_untouched(client: AsyncClient) -> None:
    """The handler is a backstop for *unhandled* errors, not a blanket rewrite."""
    response = await client.get("/threads/does-not-exist", headers={"origin": ORIGIN})
    assert response.status_code == 404
    assert response.json()["detail"]
