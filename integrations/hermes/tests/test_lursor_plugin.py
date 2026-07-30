"""Unit coverage for the Hermes plugin. No backend and no network required.

The things worth pinning down are the ones that would silently produce a
plausible-but-wrong result: the AG-UI body shape, SSE framing, whether history is
actually resent when continuing a conversation, and the promise that a handler
never raises.
"""

import json
import re
import urllib.error
import urllib.request

import pytest
from lursor import client, tools
from lursor.client import LursorError

# --- helpers ---------------------------------------------------------------------


class _FakeStream:
    """Stands in for the HTTPResponse that urlopen hands back for an SSE body."""

    def __init__(self, text):
        self._lines = [(line + "\n").encode() for line in text.split("\n")]
        self.closed = False

    def __iter__(self):
        return iter(self._lines)

    def close(self):
        self.closed = True


def _router(routes):
    """A fake ``client.request`` dispatching on (method, path)."""
    calls = []

    def request(method, path, body=None, params=None, timeout=None):
        calls.append({"method": method, "path": path, "body": body, "params": params})
        if (method, path) not in routes:
            raise AssertionError("unexpected call: {0} {1}".format(method, path))
        return routes[(method, path)]

    return request, calls


def _frames(events):
    return "\n".join("data: {0}\n".format(json.dumps(e)) for e in events)


# --- AG-UI request shape ---------------------------------------------------------


def test_run_input_carries_every_field_ag_ui_requires():
    # ag_ui's RunAgentInput makes all of these mandatory, camelCased, even empty.
    body = client.build_run_input(
        "t1", [{"id": "m", "role": "user", "content": "hi"}], {"turn": "chat"}
    )
    assert set(body) == {
        "threadId",
        "runId",
        "state",
        "messages",
        "tools",
        "context",
        "forwardedProps",
    }
    assert body["threadId"] == "t1"
    assert body["runId"]
    assert body["forwardedProps"] == {"turn": "chat"}


# --- SSE parsing -----------------------------------------------------------------


def test_stream_skips_keepalives_and_yields_events(monkeypatch):
    text = (
        "data: {\"type\": \"RUN_STARTED\"}\n"
        "\n"
        ": keepalive\n"
        "\n"
        "data: {\"type\": \"RUN_FINISHED\"}\n"
        "\n"
    )
    stream = _FakeStream(text)
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=None: stream)

    events = list(client.stream_chat("t1", {}, deadline=None))

    assert [e["type"] for e in events] == ["RUN_STARTED", "RUN_FINISHED"]
    assert stream.closed  # the response is released even on a clean finish


def test_stream_yields_a_final_frame_with_no_trailing_blank_line(monkeypatch):
    stream = _FakeStream("data: {\"type\": \"RUN_FINISHED\"}")
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=None: stream)
    assert [e["type"] for e in client.stream_chat("t1", {}, deadline=None)] == [
        "RUN_FINISHED"
    ]


def test_unreachable_backend_says_how_to_fix_it(monkeypatch):
    def boom(req, timeout=None):
        raise urllib.error.URLError("Connection refused")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    with pytest.raises(LursorError) as excinfo:
        client.request("GET", "/workspaces")
    message = excinfo.value.message
    assert "not reachable" in message
    assert "LURSOR_API_BASE" in message


def test_http_error_surfaces_fastapi_detail(monkeypatch):
    class _Err(urllib.error.HTTPError):
        def __init__(self):
            urllib.error.HTTPError.__init__(self, "u", 409, "Conflict", {}, None)

        def read(self):
            return json.dumps({"detail": "A chat run is already active"}).encode()

    def raise_err(req, timeout=None):
        raise _Err()

    monkeypatch.setattr(urllib.request, "urlopen", raise_err)
    with pytest.raises(LursorError) as excinfo:
        client.request("GET", "/threads/t1")
    assert excinfo.value.status == 409
    assert "already active" in excinfo.value.message


def test_validation_errors_name_the_field_that_was_wrong(monkeypatch):
    # A 422 puts a LIST of {loc, msg} in `detail`, not a string. Treating it as a
    # string turned "your cron is invalid" into an AttributeError.
    class _Err(urllib.error.HTTPError):
        def __init__(self):
            urllib.error.HTTPError.__init__(self, "u", 422, "Unprocessable", {}, None)

        def read(self):
            return json.dumps(
                {
                    "detail": [
                        {
                            "loc": ["body", "cron"],
                            "msg": "Value error, cron needs 5 fields",
                            "type": "value_error",
                        }
                    ]
                }
            ).encode()

    def raise_err(req, timeout=None):
        raise _Err()

    monkeypatch.setattr(urllib.request, "urlopen", raise_err)
    with pytest.raises(LursorError) as excinfo:
        client.request("POST", "/schedules/preview", body={})
    message = excinfo.value.message
    assert excinfo.value.status == 422
    assert "cron: Value error, cron needs 5 fields" in message


def test_detail_formatting_handles_every_shape():
    assert client._format_detail("plain") == "plain"
    assert client._format_detail([{"msg": "bad", "loc": ["body", "tz"]}]) == "tz: bad"
    # A message with no usable loc still reads as the message alone.
    assert client._format_detail([{"msg": "bad", "loc": ["body"]}]) == "bad"
    assert client._format_detail([]) == ""
    assert client._format_detail({"nested": 1}) == '{"nested": 1}'


# --- name resolution -------------------------------------------------------------


ROWS = [
    {"id": "w1", "name": "Lursor"},
    {"id": "w2", "name": "lastway"},
    {"id": "w3", "name": "laios"},
]


def test_resolve_prefers_id_then_exact_name_then_unique_partial():
    assert client.resolve(ROWS, "w2", "workspace")["id"] == "w2"
    assert client.resolve(ROWS, "lursor", "workspace")["id"] == "w1"  # case-insensitive
    assert client.resolve(ROWS, "lastw", "workspace")["id"] == "w2"


def test_resolve_refuses_an_ambiguous_partial_instead_of_guessing():
    with pytest.raises(LursorError) as excinfo:
        client.resolve(ROWS, "la", "workspace")  # lastway and laios both match
    assert "several" in excinfo.value.message


def test_resolve_lists_what_exists_when_nothing_matches():
    with pytest.raises(LursorError) as excinfo:
        client.resolve(ROWS, "nope", "workspace")
    assert "laios" in excinfo.value.message


# --- delegate --------------------------------------------------------------------


FINISHED_RUN = [
    {"type": "RUN_STARTED"},
    {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "Renamed "},
    {"type": "TOOL_CALL_START", "toolCallId": "c1", "toolCallName": "write_file"},
    {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "the helper."},
    {"type": "TOOL_CALL_START", "toolCallId": "c2", "toolCallName": "write_file"},
    {"type": "RUN_FINISHED"},
]

NEW_THREAD_ROUTES = {
    ("GET", "/workspaces"): [{"id": "w1", "name": "demo", "is_system": False}],
    ("GET", "/agents"): [{"id": "a1", "name": "builder"}],
    ("POST", "/threads"): {"id": "t1"},
}


def test_delegate_needs_a_message():
    assert "error" in json.loads(tools.delegate({}))


def test_delegate_rejects_an_unknown_turn():
    result = json.loads(tools.delegate({"message": "go", "turn": "yolo"}))
    assert "yolo" in result["error"]


def test_delegate_opens_a_conversation_and_summarises_the_run(monkeypatch):
    request, calls = _router(NEW_THREAD_ROUTES)
    monkeypatch.setattr(tools.client, "request", request)
    monkeypatch.setattr(
        tools.client, "stream_chat", lambda tid, body, deadline=None: iter(FINISHED_RUN)
    )

    result = json.loads(tools.delegate({"message": "rename the helper", "workspace": "demo"}))

    assert result["status"] == "finished"
    assert result["thread_id"] == "t1"
    assert result["conversation_opened"] is True
    assert result["reply"] == "Renamed the helper."
    # Repeated tool calls collapse to a count rather than a long list.
    assert result["tool_calls"] == [{"name": "write_file", "count": 2}]
    # The agent's own account isn't evidence; point at the diff.
    assert "lursor_diff" in result["next"]
    assert {"method": "POST", "path": "/threads"} == {
        k: calls[-1][k] for k in ("method", "path")
    }


def test_delegate_resends_history_when_continuing(monkeypatch):
    sent = {}

    def stream(tid, body, deadline=None):
        sent["body"] = body
        return iter([{"type": "RUN_FINISHED"}])

    request, _ = _router(
        {
            ("GET", "/threads/t1"): {"workspace_id": "w1", "agent_id": "a1"},
            ("GET", "/threads/t1/messages"): [
                {"id": "1", "role": "user", "content": "first ask"},
                {"id": "2", "role": "assistant", "content": "did it"},
                {"id": "3", "role": "tool", "content": "tool noise"},
                {"id": "4", "role": "assistant", "content": "   "},
            ],
        }
    )
    monkeypatch.setattr(tools.client, "request", request)
    monkeypatch.setattr(tools.client, "stream_chat", stream)

    result = json.loads(tools.delegate({"message": "now the tests", "thread_id": "t1"}))

    # Lursor rebuilds history purely from the request body, so the transcript has
    # to ride along or the agent starts amnesiac.
    roles = [m["role"] for m in sent["body"]["messages"]]
    assert roles == ["user", "assistant", "user"]
    assert sent["body"]["messages"][-1]["content"] == "now the tests"
    # Tool rows and blank assistant turns are dropped, not resent.
    assert result["history_resent"] == 2
    assert result["conversation_opened"] is False


def test_goal_turn_does_not_block_by_default(monkeypatch):
    started = {}
    request, _ = _router(NEW_THREAD_ROUTES)
    monkeypatch.setattr(tools.client, "request", request)
    monkeypatch.setattr(
        tools.client, "start_chat", lambda tid, body: started.update(tid=tid, body=body)
    )

    def forbidden(*a, **k):
        raise AssertionError("a goal run must not be waited on by default")

    monkeypatch.setattr(tools.client, "stream_chat", forbidden)

    result = json.loads(
        tools.delegate({"message": "the suite passes", "workspace": "demo", "turn": "goal"})
    )

    assert result["status"] == "started"
    assert started["body"]["forwardedProps"]["turn"] == "goal"
    assert "lursor_run_status" in result["next"]
    assert "t1" in tools.watched_threads()
    tools.forget("t1")


def test_goal_turn_can_be_waited_on_explicitly(monkeypatch):
    request, _ = _router(NEW_THREAD_ROUTES)
    monkeypatch.setattr(tools.client, "request", request)
    monkeypatch.setattr(
        tools.client,
        "stream_chat",
        lambda tid, body, deadline=None: iter(
            [
                {
                    "type": "CUSTOM",
                    "name": "goal_status",
                    "value": {"status": "running", "iteration": 2, "maxIterations": 25},
                },
                {"type": "RUN_FINISHED"},
            ]
        ),
    )
    result = json.loads(
        tools.delegate(
            {"message": "the suite passes", "workspace": "demo", "turn": "goal", "wait": True}
        )
    )
    assert result["status"] == "finished"
    assert result["goal"]["iteration"] == 2


def test_execute_plan_without_a_thread_is_refused():
    result = json.loads(tools.delegate({"message": "go", "turn": "execute_plan"}))
    assert "thread_id" in result["error"]


def test_a_run_error_is_reported_not_raised(monkeypatch):
    request, _ = _router(NEW_THREAD_ROUTES)
    monkeypatch.setattr(tools.client, "request", request)
    monkeypatch.setattr(
        tools.client,
        "stream_chat",
        lambda tid, body, deadline=None: iter(
            [{"type": "RUN_ERROR", "message": "model refused"}]
        ),
    )
    result = json.loads(tools.delegate({"message": "go", "workspace": "demo"}))
    assert result["status"] == "error"
    assert result["error"] == "model refused"


def test_giving_up_on_a_slow_run_reports_it_as_still_running(monkeypatch):
    routes = dict(NEW_THREAD_ROUTES)
    routes[("GET", "/threads/active-runs")] = ["t1"]
    request, _ = _router(routes)
    monkeypatch.setattr(tools.client, "request", request)
    # A stream that ends with no terminal event is what a timeout looks like.
    monkeypatch.setattr(
        tools.client,
        "stream_chat",
        lambda tid, body, deadline=None: iter(
            [{"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": "working"}]
        ),
    )

    result = json.loads(
        tools.delegate({"message": "go", "workspace": "demo", "timeout_seconds": 5})
    )

    # Hanging up only unsubscribes — the run is still Lursor's, so say so and keep
    # the partial reply.
    assert result["status"] == "running"
    assert result["reply"] == "working"
    assert "lursor_run_status" in result["next"]
    tools.forget("t1")


def test_ambiguous_workspace_is_an_error_not_a_guess(monkeypatch):
    request, _ = _router(
        {
            ("GET", "/workspaces"): [
                {"id": "w1", "name": "one", "is_system": False},
                {"id": "w2", "name": "two", "is_system": False},
            ]
        }
    )
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(tools.delegate({"message": "go"}))
    assert "Which workspace" in result["error"]


def test_sole_workspace_and_agent_need_no_naming(monkeypatch):
    request, _ = _router(NEW_THREAD_ROUTES)
    monkeypatch.setattr(tools.client, "request", request)
    monkeypatch.setattr(
        tools.client,
        "stream_chat",
        lambda tid, body, deadline=None: iter([{"type": "RUN_FINISHED"}]),
    )
    result = json.loads(tools.delegate({"message": "go"}))
    assert result["status"] == "finished"


# --- inspection ------------------------------------------------------------------


def test_diff_summarises_and_withholds_patch_text_by_default(monkeypatch):
    request, _ = _router(
        {
            ("GET", "/workspaces"): [{"id": "w1", "name": "demo"}],
            ("GET", "/workspaces/w1/git/diff"): {
                "is_repo": True,
                "branch": "main",
                "repos": [{"path": "", "branch": "main"}],
                "files": [
                    {
                        "path": "a.py",
                        "repo": "",
                        "status": "modified",
                        "additions": 3,
                        "deletions": 1,
                        "is_binary": False,
                        "truncated": False,
                        "diff": "@@ -1 +1 @@\n-old\n+new",
                    }
                ],
                "additions": 3,
                "deletions": 1,
            },
        }
    )
    monkeypatch.setattr(tools.client, "request", request)

    summary = json.loads(tools.diff({"workspace": "demo"}))
    assert summary["files"][0]["path"] == "a.py"
    assert "patch" not in summary["files"][0]  # patches are large; opt in
    assert "include_patch" in summary["hint"]

    full = json.loads(tools.diff({"workspace": "demo", "include_patch": True}))
    assert "+new" in full["files"][0]["patch"]


def test_diff_on_a_non_repo_says_so_rather_than_erroring(monkeypatch):
    request, _ = _router(
        {
            ("GET", "/workspaces"): [{"id": "w1", "name": "demo"}],
            ("GET", "/workspaces/w1/git/diff"): {"is_repo": False},
        }
    )
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(tools.diff({"workspace": "demo"}))
    assert result["is_repo"] is False
    assert "error" not in result


# --- usage -----------------------------------------------------------------------


def test_usage_maps_each_grouping_to_its_endpoint(monkeypatch):
    for group, path in [
        ("total", "/analytics/summary"),
        ("model", "/analytics/by-model"),
        ("workspace", "/analytics/by-workspace"),
        ("day", "/analytics/timeseries"),
    ]:
        payload = {"cost_usd": 1.5} if group == "total" else [{"cost_usd": 1.5}]
        request, calls = _router({("GET", path): payload})
        monkeypatch.setattr(tools.client, "request", request)
        result = json.loads(tools.usage({"group_by": group}))
        assert result["group_by"] == group
        assert calls[0]["path"] == path


def test_usage_rejects_an_unknown_grouping():
    assert "error" in json.loads(tools.usage({"group_by": "sideways"}))


def test_usage_days_becomes_a_start_date(monkeypatch):
    request, calls = _router({("GET", "/analytics/by-model"): []})
    monkeypatch.setattr(tools.client, "request", request)
    json.loads(tools.usage({"group_by": "model", "days": 7}))
    start = calls[0]["params"]["start"]
    assert re.match(r"^\d{4}-\d{2}-\d{2}$", start)


def test_usage_flags_an_unscoped_all_time_query(monkeypatch):
    request, _ = _router({("GET", "/analytics/summary"): {"cost_usd": 0}})
    monkeypatch.setattr(tools.client, "request", request)
    assert "All time" in json.loads(tools.usage({}))["note"]


def test_usage_totals_the_cost_column_for_grouped_rows(monkeypatch):
    request, _ = _router(
        {("GET", "/analytics/by-model"): [{"cost_usd": 1.25}, {"cost_usd": 0.75}]}
    )
    monkeypatch.setattr(tools.client, "request", request)
    assert json.loads(tools.usage({"group_by": "model"}))["cost_usd"] == 2.0


# --- schedules -------------------------------------------------------------------


SCHEDULE_ROW = {
    "id": "s1",
    "name": "Nightly tests",
    "enabled": True,
    "cron": "0 2 * * *",
    "timezone": "America/New_York",
    "run_type": "goal",
    "workspace_id": "w1",
    "agent_id": "a1",
    "prompt": "the suite passes",
    "next_fire_at": "2026-07-31T06:00:00Z",
    "last_fired_at": None,
    "last_run": {"status": "ok", "thread_id": "t9", "fired_at": "x", "detail": ""},
}


def test_schedules_lists_with_last_outcome(monkeypatch):
    request, _ = _router({("GET", "/schedules"): [SCHEDULE_ROW]})
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(tools.schedules({}))
    row = result["schedules"][0]
    assert row["schedule_id"] == "s1"
    assert row["last_run"]["thread_id"] == "t9"


def test_schedules_one_id_brings_run_history(monkeypatch):
    request, _ = _router(
        {
            ("GET", "/schedules/s1"): SCHEDULE_ROW,
            ("GET", "/schedules/s1/runs"): [
                {"status": "ok", "fired_at": "x", "thread_id": "t9", "missed_count": 0}
            ],
        }
    )
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(tools.schedules({"schedule_id": "s1"}))
    assert result["runs"][0]["thread_id"] == "t9"
    assert "lursor_messages" in result["hint"]


def test_create_schedule_validates_cron_before_creating_anything(monkeypatch):
    def request(method, path, body=None, params=None, timeout=None):
        if (method, path) == ("POST", "/schedules/preview"):
            raise LursorError("Lursor returned HTTP 422: bad cron", status=422)
        if (method, path) == ("POST", "/schedules"):
            raise AssertionError("must not create a schedule with an invalid cron")
        return {"id": "w1", "name": "demo"}

    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(
        tools.create_schedule(
            {"cron": "not a cron", "prompt": "go", "workspace": "demo", "agent": "builder"}
        )
    )
    assert "bad cron" in result["error"]


def test_create_schedule_returns_the_next_fire_times(monkeypatch):
    request, _ = _router(
        {
            ("POST", "/schedules/preview"): {"occurrences": ["2026-07-31T06:00:00Z"]},
            ("GET", "/workspaces"): [{"id": "w1", "name": "demo", "is_system": False}],
            ("GET", "/agents"): [{"id": "a1", "name": "builder"}],
            ("POST", "/schedules"): SCHEDULE_ROW,
        }
    )
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(
        tools.create_schedule(
            {"cron": "0 2 * * *", "prompt": "the suite passes", "run_type": "goal"}
        )
    )
    assert result["next_occurrences"] == ["2026-07-31T06:00:00Z"]
    assert "run_now" in result["next"]


def test_create_schedule_defaults_the_timezone_to_this_machine(monkeypatch):
    request, calls = _router(
        {
            ("POST", "/schedules/preview"): {"occurrences": []},
            ("GET", "/workspaces"): [{"id": "w1", "name": "demo", "is_system": False}],
            ("GET", "/agents"): [{"id": "a1", "name": "builder"}],
            ("POST", "/schedules"): SCHEDULE_ROW,
        }
    )
    monkeypatch.setattr(tools.client, "request", request)
    monkeypatch.setattr(tools.client, "local_timezone", lambda: "Europe/Berlin")
    json.loads(tools.create_schedule({"cron": "0 9 * * *", "prompt": "go"}))
    # The zone must reach both the validation call and the created row.
    assert calls[0]["body"]["timezone"] == "Europe/Berlin"
    assert calls[-1]["body"]["timezone"] == "Europe/Berlin"


def test_create_schedule_rejects_a_bad_run_type():
    result = json.loads(
        tools.create_schedule({"cron": "0 9 * * *", "prompt": "go", "run_type": "wat"})
    )
    assert "run_type" in result["error"]


def test_run_now_does_not_consume_the_slot(monkeypatch):
    request, _ = _router(
        {("POST", "/schedules/s1/run-now"): {"status": "ok", "thread_id": "t9"}}
    )
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(
        tools.schedule_control({"schedule_id": "s1", "action": "run_now"})
    )
    assert result["fired"] is True
    assert result["thread_id"] == "t9"
    assert "clock was not moved" in result["next"]


def test_run_now_on_a_busy_schedule_is_reported_not_raised(monkeypatch):
    def request(method, path, body=None, params=None, timeout=None):
        raise LursorError("Lursor returned HTTP 409: in flight", status=409)

    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(
        tools.schedule_control({"schedule_id": "s1", "action": "run_now"})
    )
    assert result["fired"] is False
    assert "error" not in result


def test_disable_flips_enabled_without_deleting(monkeypatch):
    request, calls = _router(
        {("PATCH", "/schedules/s1"): dict(SCHEDULE_ROW, enabled=False)}
    )
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(
        tools.schedule_control({"schedule_id": "s1", "action": "disable"})
    )
    assert result["enabled"] is False
    assert calls[0]["body"] == {"enabled": False}


def test_delete_names_what_it_destroyed(monkeypatch):
    request, calls = _router(
        {("GET", "/schedules/s1"): SCHEDULE_ROW, ("DELETE", "/schedules/s1"): None}
    )
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(tools.schedule_control({"schedule_id": "s1", "action": "delete"}))
    # Reads the row first so the irreversible result can say what went.
    assert result["name"] == "Nightly tests"
    assert [c["method"] for c in calls] == ["GET", "DELETE"]


def test_schedule_control_rejects_an_unknown_action():
    assert "error" in json.loads(
        tools.schedule_control({"schedule_id": "s1", "action": "obliterate"})
    )


# --- local models ----------------------------------------------------------------


CONNS = [{"id": "c1", "name": "local-mac"}, {"id": "c2", "name": "head-node"}]


def test_connections_view_probes_each_daemon(monkeypatch):
    request, _ = _router(
        {
            ("GET", "/laios/connections"): CONNS,
            ("GET", "/laios/connections/c1/status"): {
                "reachable": True,
                "role": "head",
                "version": "0.1.1",
            },
            ("GET", "/laios/connections/c2/status"): {
                "reachable": False,
                "error": "timed out",
            },
        }
    )
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(tools.local_models({"view": "connections"}))
    by_name = {c["name"]: c for c in result["connections"]}
    assert by_name["local-mac"]["reachable"] is True
    # One dead daemon must not fail the whole listing.
    assert by_name["head-node"]["reachable"] is False
    assert by_name["head-node"]["error"] == "timed out"


def test_ambiguous_connection_is_refused(monkeypatch):
    request, _ = _router({("GET", "/laios/connections"): CONNS})
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(tools.local_models({"view": "instances"}))
    assert "Which laios connection" in result["error"]


def test_no_connections_says_so_plainly(monkeypatch):
    request, _ = _router({("GET", "/laios/connections"): []})
    monkeypatch.setattr(tools.client, "request", request)
    assert "No laios connections" in json.loads(tools.local_models({}))["error"]


def test_catalog_search_narrows_and_reports_the_total(monkeypatch):
    request, _ = _router(
        {
            ("GET", "/laios/connections"): [CONNS[0]],
            ("GET", "/laios/connections/c1/catalog"): [
                {"id": "qwen-vllm", "name": "Qwen", "vram_estimate_mb": 24000},
                {"id": "llama3.2-ollama", "name": "Llama", "vram_estimate_mb": 3000},
            ],
        }
    )
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(tools.local_models({"view": "catalog", "search": "llama"}))
    assert result["returned"] == 1
    assert result["total"] == 2
    assert result["recipes"][0]["recipe_id"] == "llama3.2-ollama"


def test_instances_view_counts_what_is_actually_running(monkeypatch):
    request, _ = _router(
        {
            ("GET", "/laios/connections"): [CONNS[0]],
            ("GET", "/laios/connections/c1/instances"): [
                {"id": "i1", "status": "running", "endpoint": "http://x"},
                {"id": "i2", "status": "stopped"},
            ],
        }
    )
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(tools.local_models({"view": "instances"}))
    assert result["count"] == 2
    assert result["running"] == 1


def test_serve_requires_a_recipe(monkeypatch):
    request, _ = _router({("GET", "/laios/connections"): [CONNS[0]]})
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(tools.serve_model({"action": "serve"}))
    assert "catalog" in result["error"]


def test_serve_passes_options_through_and_warns_it_is_not_ready(monkeypatch):
    request, calls = _router(
        {
            ("GET", "/laios/connections"): [CONNS[0]],
            ("POST", "/laios/connections/c1/serve"): {
                "id": "i1",
                "status": "pulling",
                "recipe_id": "qwen-vllm",
            },
        }
    )
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(
        tools.serve_model(
            {"action": "serve", "recipe": "qwen-vllm", "max_model_len": 8192, "solo": True}
        )
    )
    assert calls[-1]["body"] == {
        "recipe": "qwen-vllm",
        "max_model_len": 8192,
        "solo": True,
    }
    assert result["status"] == "pulling"
    # A transitional instance is not usable yet; the result must say so.
    assert "until status is" in result["next"]


def test_stop_requires_an_instance(monkeypatch):
    request, _ = _router({("GET", "/laios/connections"): [CONNS[0]]})
    monkeypatch.setattr(tools.client, "request", request)
    assert "instance_id" in json.loads(tools.serve_model({"action": "stop"}))["error"]


def test_serve_model_rejects_an_unknown_action():
    assert "error" in json.loads(tools.serve_model({"action": "melt"}))


# --- github ----------------------------------------------------------------------


def test_repos_listing_filters_by_search(monkeypatch):
    request, _ = _router(
        {
            ("GET", "/github/repos"): [
                {"full_name": "jon/lursor", "private": True},
                {"full_name": "jon/other", "private": False},
            ]
        }
    )
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(tools.github({"action": "repos", "search": "lursor"}))
    assert result["returned"] == 1
    assert result["repos"][0]["full_name"] == "jon/lursor"


def test_repos_without_a_connected_account_explains_itself(monkeypatch):
    def request(method, path, body=None, params=None, timeout=None):
        raise LursorError("Lursor returned HTTP 400: GitHub not configured", status=400)

    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(tools.github({"action": "repos"}))
    assert "No GitHub account is connected" in result["error"]


def test_clone_sends_full_name_or_url_appropriately(monkeypatch):
    request, calls = _router(
        {("POST", "/github/clone"): {"id": "w9", "name": "lursor", "path": "/tmp/x"}}
    )
    monkeypatch.setattr(tools.client, "request", request)

    json.loads(tools.github({"action": "clone", "repo": "jon/lursor"}))
    assert calls[-1]["body"] == {"repo_full_name": "jon/lursor"}

    json.loads(tools.github({"action": "clone", "repo": "https://github.com/j/x.git"}))
    assert calls[-1]["body"] == {"clone_url": "https://github.com/j/x.git"}


def test_clone_points_at_the_new_workspace(monkeypatch):
    request, _ = _router(
        {("POST", "/github/clone"): {"id": "w9", "name": "lursor", "path": "/tmp/x"}}
    )
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(tools.github({"action": "clone", "repo": "jon/lursor"}))
    assert result["workspace_id"] == "w9"
    assert "lursor_delegate" in result["next"]


def test_clone_needs_a_repo():
    assert "error" in json.loads(tools.github({"action": "clone"}))


def test_github_rejects_an_unknown_action():
    assert "error" in json.loads(tools.github({"action": "fork_everything"}))


def test_local_timezone_reads_the_zoneinfo_symlink(monkeypatch):
    monkeypatch.setattr(
        client.os, "readlink", lambda p: "/var/db/timezone/zoneinfo/America/New_York"
    )
    assert client.local_timezone() == "America/New_York"

    def no_link(p):
        raise OSError("nope")

    monkeypatch.setattr(client.os, "readlink", no_link)
    assert client.local_timezone() == "UTC"


def test_run_status_reports_a_parked_plan(monkeypatch):
    request, _ = _router(
        {
            ("GET", "/threads/t1"): {
                "status": "awaiting_approval",
                "title": "Plan it",
                "workspace_id": "w1",
                "mode": "chat",
                "plan_path": ".agents/plan/thing.md",
                "iteration": 0,
                "max_iterations": 25,
                "last_reason": "",
            },
            ("GET", "/threads/active-runs"): [],
            ("GET", "/threads/t1/messages"): [
                {"role": "assistant", "content": "Wrote the plan."}
            ],
        }
    )
    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(tools.run_status({"thread_id": "t1"}))
    assert result["running"] is False
    assert result["plan_path"] == ".agents/plan/thing.md"
    assert "execute_plan" in result["next"]


def test_stop_run_on_an_idle_conversation_is_not_an_error(monkeypatch):
    def request(method, path, body=None, params=None, timeout=None):
        raise LursorError("Lursor returned HTTP 404: No active run", status=404)

    monkeypatch.setattr(tools.client, "request", request)
    result = json.loads(tools.stop_run({"thread_id": "t1"}))
    assert result["stopped"] is False
    assert "error" not in result


# --- the never-raise contract ----------------------------------------------------


def test_every_handler_returns_json_error_when_lursor_is_down(monkeypatch):
    def down(*args, **kwargs):
        raise LursorError("Lursor is not reachable")

    monkeypatch.setattr(tools.client, "request", down)
    handlers = [
        (tools.workspaces, {}),
        (tools.agents, {}),
        (tools.threads, {}),
        (tools.messages, {"thread_id": "t1"}),
        (tools.delegate, {"message": "go"}),
        (tools.run_status, {"thread_id": "t1"}),
        (tools.stop_run, {"thread_id": "t1"}),
        (tools.diff, {"workspace": "demo"}),
        (tools.list_files, {"workspace": "demo"}),
        (tools.read_file, {"workspace": "demo", "path": "a.py"}),
        (tools.usage, {}),
        (tools.schedules, {}),
        (tools.create_schedule, {"cron": "0 9 * * *", "prompt": "go"}),
        (tools.schedule_control, {"schedule_id": "s1", "action": "run_now"}),
        (tools.local_models, {"view": "connections"}),
        (tools.serve_model, {"action": "serve", "recipe": "r"}),
        (tools.github, {"action": "repos"}),
    ]
    for fn, args in handlers:
        payload = json.loads(fn(args))
        assert payload["error"], fn


def test_an_unexpected_exception_still_comes_back_as_json(monkeypatch):
    def kaboom(*args, **kwargs):
        raise RuntimeError("something odd")

    monkeypatch.setattr(tools.client, "request", kaboom)
    payload = json.loads(tools.workspaces({}))
    assert "RuntimeError" in payload["error"]


def test_handlers_tolerate_a_non_dict_args_payload():
    assert "error" in json.loads(tools.delegate(None))


# --- registration ----------------------------------------------------------------


class _Ctx:
    def __init__(self):
        self.tools = {}
        self.hooks = []
        self.commands = []
        self.cli = []
        self.skills = []

    def register_tool(self, name, toolset, schema, handler, **kwargs):
        self.tools[name] = (toolset, schema, handler)

    def register_hook(self, name, fn):
        self.hooks.append(name)

    def register_command(self, name, handler, description=""):
        self.commands.append(name)

    def register_cli_command(self, name, help, setup_fn, handler_fn):
        self.cli.append(name)

    def register_skill(self, name, path):
        self.skills.append((name, path))


def test_register_wires_every_declared_tool_and_surface():
    import lursor

    ctx = _Ctx()
    lursor.register(ctx)

    declared = {schema["name"] for schema, _ in lursor._TOOLS}
    assert set(ctx.tools) == declared
    assert all(toolset == "lursor" for toolset, _, _ in ctx.tools.values())
    assert ctx.hooks == ["pre_llm_call"]
    assert ctx.commands == ["lursor"]
    assert ctx.cli == ["lursor"]
    # The bundled skill ships with the plugin, so it must actually be found.
    assert [name for name, _ in ctx.skills] == ["delegating-to-lursor"]


def test_manifest_matches_what_register_actually_registers():
    import re
    from pathlib import Path

    import lursor

    manifest = (Path(lursor.__file__).parent / "plugin.yaml").read_text()
    listed = set(re.findall(r"^\s+- (lursor_\w+)$", manifest, re.M))
    assert listed == {schema["name"] for schema, _ in lursor._TOOLS}


def test_schemas_are_well_formed():
    import lursor

    for schema, _ in lursor._TOOLS:
        assert schema["name"].startswith("lursor_")
        assert len(schema["description"]) > 80, schema["name"]
        params = schema["parameters"]
        assert params["type"] == "object"
        for prop in params.get("properties", {}).values():
            assert prop.get("description"), schema["name"]
        for required in params.get("required", []):
            assert required in params["properties"], schema["name"]


def test_hook_is_quiet_until_a_delegation_lands(monkeypatch):
    import lursor

    tools._watched.clear()
    assert lursor._on_pre_llm_call() is None  # nothing delegated → no HTTP, no context

    tools._watched["t1"] = {"turn": "goal"}
    monkeypatch.setattr(client, "request", lambda *a, **k: ["t1"])
    assert lursor._on_pre_llm_call() is None  # still running → nothing to say

    monkeypatch.setattr(client, "request", lambda *a, **k: [])
    injected = lursor._on_pre_llm_call()
    assert "t1" in injected["context"]
    assert lursor._on_pre_llm_call() is None  # announced once, then forgotten
