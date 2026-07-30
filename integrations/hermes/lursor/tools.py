"""Tool handlers.

House rules for everything in here, per the Hermes plugin contract: the signature
is ``(args: dict, **kwargs) -> str``, the return value is always a JSON string,
and nothing ever raises — a failure comes back as ``{"error": ...}`` so the model
can read it and adjust.
"""

from __future__ import annotations

import functools
import json
import time
import uuid

from . import client
from .client import LursorError

# Reply text is for a model to read, not an archive: a long goal run narrates for
# tens of thousands of characters and would swamp Hermes's own context. Truncation
# is always reported rather than silent.
_MAX_REPLY_CHARS = 8000
_MAX_PATCH_CHARS = 4000
_MAX_MESSAGE_CHARS = 2000

# How much of a continued conversation to resend. Lursor rebuilds history purely
# from the request body (``message_history=None`` in its chat driver), so this is
# the agent's entire memory of the conversation — hence generous, and reported
# when it bites.
_MAX_HISTORY_MESSAGES = 60

_DEFAULT_TIMEOUT = 180
_MAX_TIMEOUT = 900

_TURNS = ("chat", "ask", "goal", "plan", "execute_plan")
_ASYNC_TURNS = ("goal", "execute_plan")

# Delegations this Hermes session started and has not yet seen finish, so the
# pre_llm_call hook can mention when one lands. Handlers run on the agent's main
# thread, so a plain dict needs no lock.
_watched = {}


def handler(fn):
    """Wrap a handler so it always returns JSON and never raises."""

    @functools.wraps(fn)
    def wrapped(args, **kwargs):
        try:
            return fn(args if isinstance(args, dict) else {}, **kwargs)
        except LursorError as exc:
            return _fail(exc.message)
        except Exception as exc:  # nothing escapes into the agent loop
            return _fail("{kind}: {exc}".format(kind=type(exc).__name__, exc=exc))

    return wrapped


def _ok(payload):
    return json.dumps(payload, default=str)


def _fail(message, **extra):
    payload = {"error": message}
    payload.update(extra)
    return json.dumps(payload, default=str)


def _clip(text, limit):
    """Return ``(text, was_truncated)`` with the tail dropped past ``limit``."""
    text = text or ""
    if len(text) <= limit:
        return text, False
    return text[:limit] + "\n[truncated]", True


def _int(args, key, default, low, high):
    try:
        value = int(args.get(key) or default)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, value))


# --- discovery -------------------------------------------------------------------


@handler
def workspaces(args, **kwargs):
    rows = client.request("GET", "/workspaces") or []
    return _ok(
        {
            "workspaces": [
                {
                    "id": r.get("id"),
                    "name": r.get("name"),
                    "path": r.get("path"),
                    "description": r.get("description") or "",
                    # Lursor's own skills catalog, not a project to work in.
                    "is_system": bool(r.get("is_system")),
                }
                for r in rows
            ],
            "count": len(rows),
        }
    )


@handler
def agents(args, **kwargs):
    rows = client.request("GET", "/agents") or []
    out = []
    for r in rows:
        capabilities = [
            key
            for key, flag in (
                ("todo", r.get("include_todo")),
                ("subagents", r.get("include_subagents")),
                ("skills", r.get("include_skills")),
                ("memory", r.get("include_memory")),
                ("plan", r.get("include_plan")),
                ("web_search", r.get("web_search")),
                ("browser_qa", r.get("browser_qa")),
            )
            if flag
        ]
        out.append(
            {
                "id": r.get("id"),
                "name": r.get("name"),
                "description": r.get("description") or "",
                "model": r.get("model") or "(instance default)",
                "thinking": r.get("thinking"),
                "capabilities": capabilities,
            }
        )
    return _ok({"agents": out, "count": len(out)})


@handler
def threads(args, **kwargs):
    limit = _int(args, "limit", 20, 1, 100)
    workspace_id = None
    if args.get("workspace"):
        rows = client.request("GET", "/workspaces") or []
        workspace_id = client.resolve(rows, args["workspace"], "workspace")["id"]
    rows = client.request("GET", "/threads", params={"workspace_id": workspace_id}) or []
    active = set(client.request("GET", "/threads/active-runs") or [])
    total = len(rows)
    rows = rows[:limit]
    return _ok(
        {
            "threads": [
                {
                    "thread_id": r.get("id"),
                    "title": r.get("title"),
                    "workspace_id": r.get("workspace_id"),
                    "agent_id": r.get("agent_id"),
                    "status": r.get("status"),
                    "mode": r.get("mode"),
                    "running": r.get("id") in active,
                    "updated_at": r.get("updated_at"),
                }
                for r in rows
            ],
            "returned": len(rows),
            "total": total,
        }
    )


@handler
def messages(args, **kwargs):
    thread_id = (args.get("thread_id") or "").strip()
    if not thread_id:
        return _fail("No thread_id given.")
    limit = _int(args, "limit", 20, 1, 100)
    rows = client.request("GET", "/threads/{tid}/messages".format(tid=thread_id)) or []
    total = len(rows)
    rows = rows[-limit:]
    out = []
    for r in rows:
        content, clipped = _clip(r.get("content") or "", _MAX_MESSAGE_CHARS)
        out.append(
            {
                "role": r.get("role"),
                "kind": r.get("kind"),
                "agent": r.get("agent_name") or "",
                "content": content,
                "content_truncated": clipped,
                "tools": [
                    c.get("name")
                    for c in (r.get("tool_calls") or [])
                    if isinstance(c, dict) and c.get("name")
                ],
                "created_at": r.get("created_at"),
            }
        )
    return _ok(
        {"thread_id": thread_id, "messages": out, "returned": len(out), "total": total}
    )


# --- delegation ------------------------------------------------------------------


def _history_messages(thread_id):
    """Rebuild a conversation as AG-UI messages, newest ``_MAX_HISTORY_MESSAGES``.

    Only user and assistant text is resent. Tool rows are skipped deliberately:
    Lursor stores an assistant turn's tool calls on the message itself rather than
    as separate rows, so there is no way to resend a call paired with its result,
    and an unpaired one is worse than none.
    """
    rows = client.request("GET", "/threads/{tid}/messages".format(tid=thread_id)) or []
    kept = [
        r
        for r in rows
        if r.get("role") in ("user", "assistant") and (r.get("content") or "").strip()
    ]
    truncated = len(kept) > _MAX_HISTORY_MESSAGES
    kept = kept[-_MAX_HISTORY_MESSAGES:]
    return (
        [
            {
                "id": r.get("id") or uuid.uuid4().hex,
                "role": r["role"],
                "content": r["content"],
            }
            for r in kept
        ],
        truncated,
    )


def _pick(rows, ref, kind, allow_sole=True):
    """Resolve a named resource, falling back to the only candidate there is."""
    if ref:
        return client.resolve(rows, ref, kind)
    usable = [r for r in rows if not r.get("is_system")]
    if allow_sole and len(usable) == 1:
        return usable[0]
    names = ", ".join(sorted((r.get("name") or "?") for r in usable)[:12]) or "none"
    raise LursorError(
        "Which {kind}? Lursor has: {names}. Pass '{kind}' explicitly.".format(
            kind=kind, names=names
        )
    )


def _collect(thread_id, run_input, deadline):
    """Follow a run's SSE stream and reduce it to a result summary."""
    texts = {}
    order = []
    tool_names = []
    status = "running"
    error = None
    goal = None

    for event in client.stream_chat(thread_id, run_input, deadline=deadline):
        etype = event.get("type")
        if etype == client.EVT_TEXT_CONTENT:
            mid = event.get("messageId") or ""
            if mid not in texts:
                texts[mid] = []
                order.append(mid)
            texts[mid].append(event.get("delta") or "")
        elif etype == client.EVT_TOOL_START:
            name = event.get("toolCallName")
            if name:
                tool_names.append(name)
        elif etype == client.EVT_CUSTOM and event.get("name") == client.GOAL_STATUS_EVENT:
            goal = event.get("value") or goal
        elif etype == client.EVT_RUN_FINISHED:
            status = "finished"
            break
        elif etype == client.EVT_RUN_ERROR:
            status = "error"
            error = event.get("message") or "the run failed"
            break

    reply = "\n\n".join("".join(texts[mid]).strip() for mid in order if "".join(texts[mid]).strip())
    counts = []
    for name in tool_names:
        for entry in counts:
            if entry["name"] == name:
                entry["count"] += 1
                break
        else:
            counts.append({"name": name, "count": 1})
    return {
        "status": status,
        "error": error,
        "reply": reply,
        "tool_calls": counts,
        "goal": goal,
    }


@handler
def delegate(args, **kwargs):
    message = (args.get("message") or "").strip()
    if not message:
        return _fail("No message given — say what the Lursor agent should do.")

    turn = (args.get("turn") or "chat").strip() or "chat"
    if turn not in _TURNS:
        return _fail(
            "Unknown turn {turn!r}. Use one of: {opts}.".format(
                turn=turn, opts=", ".join(_TURNS)
            )
        )

    thread_id = (args.get("thread_id") or "").strip()
    history = []
    history_truncated = False
    opened = False

    if thread_id:
        thread = client.request("GET", "/threads/{tid}".format(tid=thread_id))
        workspace_id = thread.get("workspace_id")
        agent_id = thread.get("agent_id")
        if args.get("agent"):
            rows = client.request("GET", "/agents") or []
            agent_id = client.resolve(rows, args["agent"], "agent")["id"]
        history, history_truncated = _history_messages(thread_id)
    else:
        if turn == "execute_plan":
            return _fail(
                "execute_plan needs a thread_id — it carries out the plan a "
                "previous plan turn parked on that conversation."
            )
        workspace = _pick(
            client.request("GET", "/workspaces") or [], args.get("workspace"), "workspace"
        )
        agent = _pick(client.request("GET", "/agents") or [], args.get("agent"), "agent")
        workspace_id = workspace["id"]
        agent_id = agent["id"]
        payload = {
            "workspace_id": workspace_id,
            "agent_id": agent_id,
            "title": (args.get("title") or message[:60] or "Hermes delegation").strip(),
        }
        if args.get("max_iterations"):
            payload["max_iterations"] = _int(args, "max_iterations", 25, 1, 200)
        thread = client.request("POST", "/threads", body=payload)
        thread_id = thread["id"]
        opened = True

    run_input = client.build_run_input(
        thread_id,
        history + [{"id": uuid.uuid4().hex, "role": "user", "content": message}],
        {"turn": turn, "agent_id": agent_id},
    )

    wait = args.get("wait")
    if not isinstance(wait, bool):
        wait = turn not in _ASYNC_TURNS

    base = {
        "thread_id": thread_id,
        "workspace_id": workspace_id,
        "agent_id": agent_id,
        "turn": turn,
        "conversation_opened": opened,
        "history_resent": len(history),
    }
    if history_truncated:
        base["history_truncated"] = True
        base["note"] = (
            "Only the most recent {n} messages were resent, so the agent does not "
            "see the start of this conversation.".format(n=_MAX_HISTORY_MESSAGES)
        )

    if not wait:
        client.start_chat(thread_id, run_input)
        _watched[thread_id] = {"turn": turn, "started": time.monotonic()}
        base.update(
            {
                "status": "started",
                "next": (
                    "The run is going in the background. Poll it with "
                    "lursor_run_status on this thread_id; stop it with "
                    "lursor_stop_run."
                ),
            }
        )
        return _ok(base)

    timeout = _int(args, "timeout_seconds", _DEFAULT_TIMEOUT, 5, _MAX_TIMEOUT)
    deadline = time.monotonic() + timeout
    result = _collect(thread_id, run_input, deadline)

    if result["status"] == "running":
        # No terminal event arrived. Either we ran out of budget (the run carries
        # on regardless — hanging up only unsubscribes) or the stream ended early.
        timed_out = time.monotonic() > deadline
        still = thread_id in set(client.request("GET", "/threads/active-runs") or [])
        if still:
            result["status"] = "running"
            _watched[thread_id] = {"turn": turn, "started": time.monotonic()}
            base["next"] = (
                "Stopped waiting after {t}s but the agent is still working. Poll "
                "lursor_run_status on this thread_id.".format(t=timeout)
            )
            base["timed_out"] = timed_out
        else:
            result["status"] = "finished"
            base["note"] = (
                "The stream ended without a completion event; the run is no longer active."
            )

    reply, clipped = _clip(result["reply"], _MAX_REPLY_CHARS)
    base.update(
        {
            "status": result["status"],
            "reply": reply,
            "reply_truncated": clipped,
            "tool_calls": result["tool_calls"],
        }
    )
    if result["goal"]:
        base["goal"] = result["goal"]
    if result["error"]:
        base["error"] = result["error"]
    if result["status"] == "finished":
        _watched.pop(thread_id, None)
        if turn not in ("ask", "plan"):
            base["next"] = (
                "Check what changed on disk with lursor_diff on this workspace."
            )
    return _ok(base)


@handler
def run_status(args, **kwargs):
    thread_id = (args.get("thread_id") or "").strip()
    if not thread_id:
        return _fail("No thread_id given.")
    thread = client.request("GET", "/threads/{tid}".format(tid=thread_id))
    active = set(client.request("GET", "/threads/active-runs") or [])
    running = thread_id in active
    if not running:
        _watched.pop(thread_id, None)

    rows = client.request("GET", "/threads/{tid}/messages".format(tid=thread_id)) or []
    latest = ""
    for row in reversed(rows):
        if row.get("role") == "assistant" and (row.get("content") or "").strip():
            latest = row["content"]
            break
    latest, clipped = _clip(latest, _MAX_REPLY_CHARS)

    payload = {
        "thread_id": thread_id,
        "running": running,
        "status": thread.get("status"),
        "title": thread.get("title"),
        "workspace_id": thread.get("workspace_id"),
        "mode": thread.get("mode"),
        "message_count": len(rows),
        "latest_assistant_message": latest,
        "latest_truncated": clipped,
        # Always reported: a `/goal` turn leaves the thread's mode as "chat", so
        # there is no reliable flag to gate these on, and an autonomous run that
        # is still on its first turn is exactly when the count matters.
        "iteration": thread.get("iteration"),
        "max_iterations": thread.get("max_iterations"),
    }
    if thread.get("last_reason"):
        payload["last_reason"] = thread["last_reason"]
    if thread.get("plan_path"):
        payload["plan_path"] = thread["plan_path"]

    status = thread.get("status")
    if status == "awaiting_approval":
        payload["next"] = (
            "A plan is parked for review. Read it with lursor_read_file on "
            "plan_path, then send turn='execute_plan' to carry it out."
        )
    elif status == "blocked":
        payload["next"] = (
            "The run stopped without reaching its goal — see last_reason. Check "
            "lursor_diff for what it managed to change before deciding whether to "
            "resume with another turn."
        )
    elif running:
        payload["next"] = "Still working — poll again in a little while."
    return _ok(payload)


@handler
def stop_run(args, **kwargs):
    thread_id = (args.get("thread_id") or "").strip()
    if not thread_id:
        return _fail("No thread_id given.")
    try:
        client.request("POST", "/threads/{tid}/stop".format(tid=thread_id))
    except LursorError as exc:
        if exc.status == 404:
            return _ok(
                {
                    "thread_id": thread_id,
                    "stopped": False,
                    "detail": "No run was active on this conversation.",
                }
            )
        raise
    _watched.pop(thread_id, None)
    return _ok(
        {
            "thread_id": thread_id,
            "stopped": True,
            "detail": (
                "Run cancelled. Anything already written to disk is still there — "
                "check lursor_diff."
            ),
        }
    )


# --- inspecting the result -------------------------------------------------------


@handler
def diff(args, **kwargs):
    rows = client.request("GET", "/workspaces") or []
    workspace = client.resolve(rows, args.get("workspace"), "workspace")
    data = client.request(
        "GET", "/workspaces/{wid}/git/diff".format(wid=workspace["id"]), timeout=60.0
    )
    if not data.get("is_repo"):
        return _ok(
            {
                "workspace": workspace.get("name"),
                "is_repo": False,
                "detail": "No git repo under this workspace, so there is no diff to read.",
            }
        )

    only = (args.get("path") or "").strip()
    include_patch = bool(args.get("include_patch"))
    files = data.get("files") or []
    if only:
        files = [f for f in files if f.get("path") == only]

    out = []
    for f in files:
        entry = {
            "path": f.get("path"),
            "repo": f.get("repo") or "",
            "status": f.get("status"),
            "additions": f.get("additions"),
            "deletions": f.get("deletions"),
        }
        if f.get("is_binary"):
            entry["binary"] = True
        if include_patch:
            patch, clipped = _clip(f.get("diff") or "", _MAX_PATCH_CHARS)
            entry["patch"] = patch
            if clipped:
                entry["patch_truncated"] = True
        out.append(entry)

    payload = {
        "workspace": workspace.get("name"),
        "workspace_id": workspace["id"],
        "branch": data.get("branch"),
        "repos": [
            {"path": r.get("path") or "", "branch": r.get("branch")}
            for r in (data.get("repos") or [])
        ],
        "files": out,
        "additions": data.get("additions"),
        "deletions": data.get("deletions"),
    }
    if only and not out:
        payload["detail"] = "{path!r} has no uncommitted changes.".format(path=only)
    if not include_patch and out:
        payload["hint"] = "Set include_patch=true to read the diff text."
    return _ok(payload)


@handler
def list_files(args, **kwargs):
    rows = client.request("GET", "/workspaces") or []
    workspace = client.resolve(rows, args.get("workspace"), "workspace")
    path = (args.get("path") or "").strip()
    entries = (
        client.request(
            "GET",
            "/workspaces/{wid}/files/list".format(wid=workspace["id"]),
            params={"path": path},
        )
        or []
    )
    return _ok(
        {
            "workspace": workspace.get("name"),
            "path": path or ".",
            "entries": [
                {
                    "name": e.get("name"),
                    "path": e.get("path"),
                    "is_dir": bool(e.get("is_dir")),
                    "link_target": e.get("link_target") or "",
                }
                for e in entries
            ],
            "count": len(entries),
        }
    )


@handler
def read_file(args, **kwargs):
    path = (args.get("path") or "").strip()
    if not path:
        return _fail("No path given.")
    rows = client.request("GET", "/workspaces") or []
    workspace = client.resolve(rows, args.get("workspace"), "workspace")
    data = client.request(
        "GET",
        "/workspaces/{wid}/files/read".format(wid=workspace["id"]),
        params={"path": path},
    )
    if data.get("is_binary"):
        return _ok(
            {
                "workspace": workspace.get("name"),
                "path": data.get("path"),
                "is_binary": True,
                "size": data.get("size"),
                "detail": "Binary file — not returned as text.",
            }
        )
    return _ok(
        {
            "workspace": workspace.get("name"),
            "path": data.get("path"),
            "content": data.get("content"),
            "size": data.get("size"),
            # Lursor truncates oversize files server-side; pass its verdict through
            # rather than re-deciding here.
            "truncated": bool(data.get("truncated")),
        }
    )


# --- session surfaces ------------------------------------------------------------


def watched_threads():
    """Thread ids this session delegated to and has not yet seen finish."""
    return dict(_watched)


def forget(thread_id):
    _watched.pop(thread_id, None)


def status_text():
    """Human-readable status line, shared by the /lursor command and the CLI."""
    try:
        workspaces_ = client.request("GET", "/workspaces") or []
        agents_ = client.request("GET", "/agents") or []
        active = client.request("GET", "/threads/active-runs") or []
    except LursorError as exc:
        return exc.message

    lines = [
        "Lursor at {base}: {w} workspace(s), {a} agent(s).".format(
            base=client.api_base(), w=len(workspaces_), a=len(agents_)
        )
    ]
    if active:
        lines.append("Runs in flight: {n}".format(n=len(active)))
        for tid in active[:10]:
            try:
                thread = client.request("GET", "/threads/{tid}".format(tid=tid))
            except LursorError:
                continue
            lines.append(
                "  {title} [{status}] ({tid})".format(
                    title=thread.get("title") or "untitled",
                    status=thread.get("status"),
                    tid=tid,
                )
            )
    else:
        lines.append("No runs in flight.")
    mine = [tid for tid in _watched if tid in active]
    if mine:
        lines.append("Delegated from this session and still running: {n}".format(n=len(mine)))
    return "\n".join(lines)
