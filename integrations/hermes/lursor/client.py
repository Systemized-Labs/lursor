"""HTTP access to a local Lursor backend.

Deliberately stdlib-only. A Hermes plugin is imported by whatever interpreter the
user's Hermes runs in, so depending on ``httpx``/``requests`` would make the whole
plugin fail to load on an install that happens not to have it.

Two shapes of call live here:

* :func:`request` — ordinary JSON REST, used for every read and for thread setup.
* :func:`stream_chat` — the AG-UI SSE run at ``POST /threads/{id}/chat``.

The second one is the interesting one. Lursor owns a chat run as a *detached*
task (``app/agents/chat_run_manager.py``): the SSE response is only a subscriber,
so hanging up cancels nothing. That is what makes fire-and-forget delegation
safe, and what lets a timed-out wait be resumed later against the same thread.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

DEFAULT_API_BASE = "http://127.0.0.1:8791/api"
API_BASE_ENV = "LURSOR_API_BASE"

# Lursor emits a ": keepalive" comment every 25s on an idle stream, so a read
# that blocks appreciably longer than that means the connection died rather than
# the agent merely thinking. Keepalives are also what bound how long we can sit
# inside a blocking read while a wall-clock deadline is pending.
KEEPALIVE_SECONDS = 25.0
_STREAM_READ_TIMEOUT = 60.0
_UNARY_TIMEOUT = 30.0

# AG-UI event types this plugin reads. The rest (reasoning, state, steps) stream
# past us untouched.
EVT_TEXT_CONTENT = "TEXT_MESSAGE_CONTENT"
EVT_TEXT_START = "TEXT_MESSAGE_START"
EVT_TEXT_END = "TEXT_MESSAGE_END"
EVT_TOOL_START = "TOOL_CALL_START"
EVT_RUN_FINISHED = "RUN_FINISHED"
EVT_RUN_ERROR = "RUN_ERROR"
EVT_CUSTOM = "CUSTOM"

# Names of the two CUSTOM events Lursor adds on top of AG-UI proper.
GOAL_STATUS_EVENT = "goal_status"
TODOS_EVENT = "todos"


class LursorError(Exception):
    """A Lursor call failed.

    ``message`` is written to be read by a model: it says what broke and, where
    there is one, what to do about it.
    """

    def __init__(self, message, status=None):
        super().__init__(message)
        self.message = message
        self.status = status


def api_base():
    """REST root of the backend, overridable for a non-default host or port."""
    return (os.environ.get(API_BASE_ENV) or DEFAULT_API_BASE).rstrip("/")


def _url(path, params=None):
    url = api_base() + path
    if params:
        pairs = [(k, v) for k, v in params.items() if v is not None]
        if pairs:
            url += "?" + urllib.parse.urlencode(pairs)
    return url


def _unreachable(exc):
    return LursorError(
        "Lursor is not reachable at {base} ({reason}). Start it with "
        "./scripts/dev.sh (or open the desktop app), and set {env} if the "
        "backend listens somewhere other than the default.".format(
            base=api_base(), reason=getattr(exc, "reason", exc), env=API_BASE_ENV
        )
    )


def _format_detail(detail):
    """Render FastAPI's ``detail`` as one readable line.

    A hand-raised ``HTTPException`` puts a string here, but a schema rejection
    (422) puts a *list* of ``{loc, msg, type}`` entries — which is exactly the
    case worth reporting well, since it names the field the caller got wrong.
    """
    if isinstance(detail, str):
        return detail
    if isinstance(detail, list):
        parts = []
        for item in detail:
            if isinstance(item, dict) and item.get("msg"):
                # loc is like ["body", "cron"]; the "body" prefix is noise.
                loc = [str(p) for p in (item.get("loc") or []) if p != "body"]
                field = ".".join(loc)
                parts.append(
                    "{field}: {msg}".format(field=field, msg=item["msg"])
                    if field
                    else str(item["msg"])
                )
            else:
                parts.append(str(item))
        return "; ".join(p for p in parts if p)
    if detail:
        return json.dumps(detail)
    return ""


def _http_error(exc):
    """Turn an HTTPError into a LursorError carrying FastAPI's ``detail``."""
    detail = ""
    try:
        body = exc.read().decode("utf-8", "replace")
        parsed = json.loads(body)
        if isinstance(parsed, dict):
            detail = _format_detail(parsed.get("detail") or parsed.get("message") or "")
        detail = detail or body
    except Exception:
        detail = ""
    detail = (detail or "").strip()[:500]
    return LursorError(
        "Lursor returned HTTP {code}{sep}{detail}".format(
            code=exc.code, sep=": " if detail else "", detail=detail
        ),
        status=exc.code,
    )


def request(method, path, body=None, params=None, timeout=_UNARY_TIMEOUT):
    """One JSON REST call. Returns parsed JSON, or ``None`` on an empty body."""
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        _url(path, params), data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        raise _http_error(exc) from exc
    except urllib.error.URLError as exc:
        raise _unreachable(exc) from exc
    except OSError as exc:
        raise LursorError(
            "Lursor call to {path} failed: {exc}".format(path=path, exc=exc)
        ) from exc
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        raise LursorError(
            "Lursor sent a malformed response for {path}: {exc}".format(path=path, exc=exc)
        ) from exc


def build_run_input(thread_id, messages, forwarded_props):
    """The AG-UI ``RunAgentInput`` body for a chat run.

    Every field is required by the protocol model even when empty, and the keys
    are camelCase because ag-ui aliases them that way. ``tools``/``context`` stay
    empty: the tools the run may use are the Lursor agent's own, configured in
    Lursor, not ones passed in from here.
    """
    return {
        "threadId": thread_id,
        "runId": uuid.uuid4().hex,
        "state": {},
        "messages": messages,
        "tools": [],
        "context": [],
        "forwardedProps": forwarded_props,
    }


def _open_chat(thread_id, run_input, timeout):
    req = urllib.request.Request(
        _url("/threads/{tid}/chat".format(tid=thread_id)),
        data=json.dumps(run_input).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
        method="POST",
    )
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as exc:
        raise _http_error(exc) from exc
    except urllib.error.URLError as exc:
        raise _unreachable(exc) from exc


def start_chat(thread_id, run_input):
    """Kick a run off and hang up without waiting for it.

    Safe because Lursor spawns the driver task *before* it starts the response
    body, so the run is already running by the time these headers arrive.
    """
    resp = _open_chat(thread_id, run_input, _UNARY_TIMEOUT)
    resp.close()


def stream_chat(thread_id, run_input, deadline=None):
    """Yield parsed AG-UI events from a run until it ends or ``deadline`` passes.

    ``deadline`` is a :func:`time.monotonic` stamp. It is only checked between
    frames, so it can overshoot by up to one keepalive interval — we never
    interrupt a blocking read. Giving up early just unsubscribes; the run itself
    carries on and can be picked up again via ``/threads/{id}/stream``.
    """
    resp = _open_chat(thread_id, run_input, _STREAM_READ_TIMEOUT)
    try:
        pending = []
        for raw in resp:
            if deadline is not None and time.monotonic() > deadline:
                return
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if line.startswith(":"):  # keepalive comment
                continue
            if line.startswith("data:"):
                pending.append(line[5:].lstrip())
                continue
            if line == "" and pending:
                blob = "\n".join(pending)
                pending = []
                try:
                    event = json.loads(blob)
                except ValueError:
                    continue
                if isinstance(event, dict):
                    yield event
        if pending:  # stream ended without its trailing blank line
            try:
                event = json.loads("\n".join(pending))
            except ValueError:
                return
            if isinstance(event, dict):
                yield event
    except OSError as exc:
        raise LursorError(
            "Lost the stream for conversation {tid}: {exc}. The run may still be "
            "going — check with lursor_run_status.".format(tid=thread_id, exc=exc)
        ) from exc
    finally:
        resp.close()


# --- local environment -----------------------------------------------------------


def local_timezone():
    """Best-effort IANA zone name for this machine, falling back to UTC.

    ``ScheduleCreate`` requires a real zone (a schedule's whole point is that 9am
    survives DST), but a model has no reliable way to know the operator's. Read it
    off the ``/etc/localtime`` symlink, which is how macOS and Linux both record
    it; the caller can always pass one explicitly.
    """
    try:
        target = os.readlink("/etc/localtime")
    except OSError:
        return "UTC"
    parts = target.split("/zoneinfo/", 1)
    if len(parts) == 2 and parts[1]:
        return parts[1]
    return "UTC"


# --- resource lookup -------------------------------------------------------------


def resolve(rows, ref, kind):
    """Find one row by id, then by exact name, then by unique partial name.

    Lets a model say "the lursor workspace" instead of carrying ids around, while
    still refusing an ambiguous match rather than guessing between two.
    """
    if not ref:
        raise LursorError("No {kind} given.".format(kind=kind))
    for row in rows:
        if row.get("id") == ref:
            return row
    needle = ref.strip().lower()
    exact = [r for r in rows if (r.get("name") or "").strip().lower() == needle]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise LursorError(
            "{n} {kind}s are named {ref!r}. Use an id instead — see the id field "
            "from the listing tool.".format(n=len(exact), kind=kind, ref=ref)
        )
    partial = [r for r in rows if needle in (r.get("name") or "").lower()]
    if len(partial) == 1:
        return partial[0]
    if len(partial) > 1:
        names = ", ".join(sorted((r.get("name") or "?") for r in partial)[:8])
        raise LursorError(
            "{ref!r} matches several {kind}s ({names}). Be more specific or pass "
            "an id.".format(ref=ref, kind=kind, names=names)
        )
    known = ", ".join(sorted((r.get("name") or "?") for r in rows)[:12]) or "none"
    raise LursorError(
        "No {kind} matches {ref!r}. Available: {known}.".format(
            kind=kind, ref=ref, known=known
        )
    )
