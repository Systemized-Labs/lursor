"""Bearer-token authentication, for backends reachable from off the machine.

Lursor's default posture is unauthenticated on loopback: one trusted operator,
one machine, no tenancy boundary (see ``SECURITY.md``). That stays the default —
with ``Settings.auth_token`` unset this middleware is never installed and nothing
about the app changes.

Set it (``LURSOR_AUTH_TOKEN``) and every route needs the token. That is what makes
a remote backend possible: the desktop app can then talk to a VPS over TLS and be
the only thing that can. The token is worth exactly as much as an SSH key to that
host — ``/api/terminal/ws`` is a real PTY and ``GET /api/settings`` returns
provider keys in plaintext — so it is compared in constant time and never logged.

Two things about the shape of this module:

*It is raw ASGI, not a route dependency.* A dependency would have to be added to
every router, and forgetting one on a route that hands out a shell is not a
mistake worth leaving available. Middleware also sees WebSocket connections,
which ``Depends`` on a ``@router.websocket`` handler covers awkwardly at best.

*WebSockets authenticate by subprotocol.* The browser WebSocket API cannot set
request headers, so there is nowhere to put ``Authorization``. The token travels
as a ``lursor.bearer.<token>`` subprotocol instead — the standard workaround, and
better than a query parameter, which would land the credential in every access
log and proxy trace along the way. The query parameter is still accepted for
non-browser clients (``websocat``, tests), where that tradeoff is the caller's to
make.
"""

from __future__ import annotations

import json
import secrets
from urllib.parse import parse_qs

from starlette.types import ASGIApp, Message, Receive, Scope, Send

# What a client prepends to the token when passing it as a WebSocket subprotocol.
# ``secrets.token_urlsafe`` output is already a valid subprotocol token (RFC 6455
# requires an HTTP token: no spaces, no separators), which is why ``docs/REMOTE.md``
# hands out that generator specifically.
SUBPROTOCOL_PREFIX = "lursor.bearer."

_UNAUTHORIZED_BODY = json.dumps(
    {"detail": "Missing or invalid bearer token"}
).encode()

# RFC 6455 close code for a policy violation. A rejected handshake surfaces to the
# client as an HTTP error rather than a close frame, but ASGI servers expect the
# close message either way.
_WS_POLICY_VIOLATION = 1008


class TokenAuthMiddleware:
    """Require a bearer token on every HTTP request and WebSocket connection.

    Install this **before** ``CORSMiddleware``. Starlette's ``add_middleware``
    inserts at the front of the list and ``build_middleware_stack`` wraps in
    reverse, so the *last* middleware added is the outermost one — meaning CORS
    only wraps this if CORS is added second. Get it backwards and a 401 goes out
    with no ``access-control-allow-origin``, the browser refuses to let the app
    read it, and every auth failure surfaces as ``TypeError: Failed to fetch``.
    That is invariant 11 in ``AGENTS.md``, arrived at the hard way for 500s.
    """

    def __init__(self, app: ASGIApp, token: str) -> None:
        self.app = app
        self._token = token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        kind = scope.get("type")

        if kind == "http":
            # A CORS preflight carries no ``Authorization`` header — the spec does
            # not let the browser attach one — so it could never authenticate.
            # CORSMiddleware sits outside us and answers preflights itself, so in
            # practice one never arrives here; the exemption means that if the
            # ordering above is ever broken, preflights still work instead of the
            # whole API going dark.
            if scope.get("method") == "OPTIONS" or self._http_authorized(scope):
                await self.app(scope, receive, send)
                return
            await self._reject_http(send)
            return

        if kind == "websocket":
            offered = self._offered_subprotocol(scope)
            if not self._ws_authorized(scope, offered):
                await send({"type": "websocket.close", "code": _WS_POLICY_VIOLATION})
                return
            # Echo the subprotocol we accepted the connection on. RFC 6455 only
            # *requires* a selection to be one the client offered, so omitting it
            # would also connect — but answering a subprotocol handshake with
            # silence is the kind of detail strict clients and proxies are within
            # their rights to reject. Injecting it here keeps all four existing
            # WebSocket routes unaware that any of this happens.
            await self.app(scope, receive, _echo_subprotocol(send, offered))
            return

        # "lifespan" and anything else ASGI grows later: not a client request,
        # nothing to authenticate.
        await self.app(scope, receive, send)

    # --- token extraction -------------------------------------------------

    def _matches(self, candidate: str | None) -> bool:
        if not candidate:
            return False
        return secrets.compare_digest(candidate, self._token)

    def _http_authorized(self, scope: Scope) -> bool:
        for name, value in scope.get("headers", ()):
            if name == b"authorization":
                decoded = value.decode("latin-1")
                scheme, _, credential = decoded.partition(" ")
                if scheme.lower() != "bearer":
                    return False
                return self._matches(credential.strip())
        return False

    def _ws_authorized(self, scope: Scope, offered: str | None) -> bool:
        if offered is not None and self._matches(offered):
            return True
        # Header first for non-browser clients that can send one, then the query
        # parameter. Both are second-class next to the subprotocol; see the module
        # docstring on why the query parameter is a caller's-choice tradeoff.
        if self._http_authorized(scope):
            return True
        query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
        values = query.get("token") or []
        return any(self._matches(v) for v in values)

    def _offered_subprotocol(self, scope: Scope) -> str | None:
        """The token a client offered as a subprotocol, if it did.

        Returns the bare token, or ``None`` when no ``lursor.bearer.*`` entry was
        offered. An offered-but-wrong token is returned as-is so the caller
        compares it in constant time like any other candidate.
        """
        for proto in scope.get("subprotocols", ()) or ():
            if proto.startswith(SUBPROTOCOL_PREFIX):
                return proto[len(SUBPROTOCOL_PREFIX) :]
        return None

    # --- rejection --------------------------------------------------------

    async def _reject_http(self, send: Send) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(_UNAUTHORIZED_BODY)).encode()),
                    # Names the scheme the client should retry with, and is what
                    # tells a caller "wrong credential", not "wrong URL".
                    (b"www-authenticate", b'Bearer realm="lursor"'),
                ],
            }
        )
        await send({"type": "http.response.body", "body": _UNAUTHORIZED_BODY})


def _echo_subprotocol(send: Send, offered: str | None) -> Send:
    """Wrap ``send`` so ``websocket.accept`` names the subprotocol we authenticated on."""
    if offered is None:
        return send

    selected = f"{SUBPROTOCOL_PREFIX}{offered}"

    async def wrapped(message: Message) -> None:
        if message.get("type") == "websocket.accept" and not message.get("subprotocol"):
            message = {**message, "subprotocol": selected}
        await send(message)

    return wrapped
