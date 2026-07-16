"""Integration smoke for the goal-mode chat driver.

Drives the real ``POST /threads/{id}/chat`` goal path end-to-end — planning
turn, execution loop, evaluator verdict, status persistence — with a
``TestModel`` agent and a fake evaluator so it runs offline (no network, no GPU).
This covers the wiring the pure-loop unit tests can't: the continuation adapter,
``result.all_messages()`` threading, and goal-status persistence on the thread.
"""

from __future__ import annotations

import json
import os
import tempfile

import pytest
from ag_ui.core import RunAgentInput, UserMessage
from httpx import ASGITransport, AsyncClient
from pydantic_ai.models.test import TestModel
from pydantic_ai_backends import LocalBackend
from pydantic_deep import GoalEvaluation, create_deep_agent, create_default_deps

_tmp = tempfile.mkdtemp(prefix="lursor-goal-test-")
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_tmp}/test.db"
os.environ["WORKSPACES_DIR"] = f"{_tmp}/workspaces"
os.environ.setdefault("OPENROUTER_API_KEY", "test-key-not-used")

from app.db.session import init_db  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture
async def client():
    await init_db()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test/api") as c:
        yield c


class _FakeEvaluator:
    """Reports the goal met on the first execution turn."""

    async def evaluate(self, condition: str, messages: list) -> GoalEvaluation:
        return GoalEvaluation(met=True, reason="looks done")


def _fake_deep_agent(row, workspace_path, *args, **kwargs):
    """A minimal deep agent backed by ``TestModel`` (returns text, calls no tools)."""
    backend = LocalBackend(root_dir=str(workspace_path))
    agent = create_deep_agent(
        model=TestModel(call_tools=[]),
        backend=backend,
        include_subagents=False,
        include_plan=False,
    )
    return agent, create_default_deps(backend)


async def _drain_chat(client: AsyncClient, thread_id: str, body: str) -> list[str]:
    """POST a goal turn, read the SSE stream to completion, and return event types.

    Collecting the ordered event `type`s lets tests assert AG-UI lifecycle
    validity (exactly one RUN_STARTED first, one RUN_FINISHED last) — the invariant
    the browser's AG-UI client enforces and rejects the stream over otherwise.
    """
    types: list[str] = []
    async with client.stream(
        "POST",
        f"/threads/{thread_id}/chat",
        content=body,
        headers={"accept": "text/event-stream", "content-type": "application/json"},
    ) as resp:
        assert resp.status_code == 200, await resp.aread()
        async for line in resp.aiter_lines():
            if not line.startswith("data:"):
                continue
            try:
                event = json.loads(line[len("data:") :].strip())
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict) and isinstance(event.get("type"), str):
                types.append(event["type"])
    return types


async def _drain_stream(client: AsyncClient, thread_id: str) -> list[str]:
    """Follow a thread's run via GET /stream to completion; return event types."""
    types: list[str] = []
    async with client.stream("GET", f"/threads/{thread_id}/stream") as resp:
        assert resp.status_code == 200, await resp.aread()
        async for line in resp.aiter_lines():
            if not line.startswith("data:"):
                continue
            try:
                event = json.loads(line[len("data:") :].strip())
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict) and isinstance(event.get("type"), str):
                types.append(event["type"])
    return types


def _assert_valid_lifecycle(types: list[str]) -> None:
    """The stream must be one well-formed AG-UI run."""
    assert types, "stream produced no events"
    assert types[0] == "RUN_STARTED", f"first event was {types[0]!r}, not RUN_STARTED"
    assert types.count("RUN_STARTED") == 1, "expected exactly one RUN_STARTED"
    assert types.count("RUN_FINISHED") == 1, "expected exactly one RUN_FINISHED"
    assert types[-1] == "RUN_FINISHED", f"last event was {types[-1]!r}, not RUN_FINISHED"


async def test_goal_thread_runs_to_completion(client: AsyncClient, monkeypatch):
    # Real model/evaluator would hit the network; swap in offline fakes.
    monkeypatch.setattr("app.api.chat.build_deep_agent", _fake_deep_agent)
    monkeypatch.setattr(
        "app.api.chat.build_goal_evaluator", lambda *a, **k: _FakeEvaluator()
    )

    agent = (await client.post("/agents", json={"name": "Goalie"})).json()
    ws = (await client.post("/workspaces", json={"name": "GoalWS"})).json()
    thread = (
        await client.post(
            "/threads",
            json={
                "workspace_id": ws["id"],
                "agent_id": agent["id"],
                "mode": "goal",
                "goal": "make the tests pass",
                "require_plan_approval": False,
                "max_iterations": 5,
            },
        )
    ).json()
    assert thread["mode"] == "goal"
    assert thread["goal_status"] == "idle"

    run_input = RunAgentInput(
        thread_id=thread["id"],
        run_id="run-1",
        state=None,
        messages=[UserMessage(id="m1", role="user", content="make the tests pass")],
        tools=[],
        context=[],
        forwarded_props=None,
    )
    types = await _drain_chat(
        client, thread["id"], run_input.model_dump_json(by_alias=True)
    )
    # The multi-turn goal run must present as ONE valid AG-UI lifecycle.
    _assert_valid_lifecycle(types)

    refreshed = (await client.get(f"/threads/{thread['id']}")).json()
    assert refreshed["goal_status"] == "completed"
    assert refreshed["iteration"] == 1
    assert refreshed["last_reason"] == "looks done"


async def test_goal_thread_plans_then_executes_on_approval(
    client: AsyncClient, monkeypatch
):
    monkeypatch.setattr("app.api.chat.build_deep_agent", _fake_deep_agent)
    monkeypatch.setattr(
        "app.api.chat.build_goal_evaluator", lambda *a, **k: _FakeEvaluator()
    )

    agent = (await client.post("/agents", json={"name": "Goalie2"})).json()
    ws = (await client.post("/workspaces", json={"name": "GoalWS2"})).json()
    thread = (
        await client.post(
            "/threads",
            json={
                "workspace_id": ws["id"],
                "agent_id": agent["id"],
                "mode": "goal",
                "goal": "refactor the module",
                "require_plan_approval": True,
            },
        )
    ).json()

    run_input = RunAgentInput(
        thread_id=thread["id"],
        run_id="run-1",
        state=None,
        messages=[UserMessage(id="m1", role="user", content="refactor the module")],
        tools=[],
        context=[],
        forwarded_props=None,
    )

    # Phase 1 — planning. The /chat run drafts the plan and ends awaiting approval.
    plan_types = await _drain_chat(
        client, thread["id"], run_input.model_dump_json(by_alias=True)
    )
    _assert_valid_lifecycle(plan_types)
    assert (await client.get(f"/threads/{thread['id']}")).json()[
        "goal_status"
    ] == "awaiting_approval"

    # Phase 2 — approve starts a fresh execution run; follow it via GET /stream.
    approve = await client.post(f"/threads/{thread['id']}/goal/approve")
    assert approve.status_code == 200, approve.text
    exec_types = await _drain_stream(client, thread["id"])
    _assert_valid_lifecycle(exec_types)
    assert (await client.get(f"/threads/{thread['id']}")).json()["goal_status"] == "completed"


async def test_goal_planning_conversation_refines_before_approval(
    client: AsyncClient, monkeypatch
):
    """Messages before approval refine the plan and never execute; only approve does.

    First message → a fresh plan (PLANNING_INSTRUCTION), parked awaiting approval.
    A second message while awaiting approval is a refinement turn (REFINE_INSTRUCTION)
    that stays in awaiting_approval — the autonomous loop must not start. Approval
    is the sole path to execution.
    """
    monkeypatch.setattr("app.api.chat.build_deep_agent", _fake_deep_agent)
    monkeypatch.setattr(
        "app.api.chat.build_goal_evaluator", lambda *a, **k: _FakeEvaluator()
    )

    # Spy on the run-scoped instructions each planning turn uses, delegating to the
    # real streamer so the SSE flow is unchanged.
    from app.api import chat as chat_mod

    real_stream_turn = chat_mod._stream_turn
    captured: list[str] = []

    async def spy_stream_turn(*args, **kwargs):
        captured.append(kwargs.get("instructions", ""))
        return await real_stream_turn(*args, **kwargs)

    monkeypatch.setattr("app.api.chat._stream_turn", spy_stream_turn)

    agent = (await client.post("/agents", json={"name": "Goalie3"})).json()
    ws = (await client.post("/workspaces", json={"name": "GoalWS3"})).json()
    thread = (
        await client.post(
            "/threads",
            json={
                "workspace_id": ws["id"],
                "agent_id": agent["id"],
                "mode": "goal",
                "goal": "refactor the module",
                "require_plan_approval": True,
            },
        )
    ).json()
    tid = thread["id"]

    def _input(mid: str, content: str) -> str:
        return RunAgentInput(
            thread_id=tid,
            run_id=mid,
            state=None,
            messages=[UserMessage(id=mid, role="user", content=content)],
            tools=[],
            context=[],
            forwarded_props=None,
        ).model_dump_json(by_alias=True)

    # First message → fresh plan (PLANNING_INSTRUCTION), awaiting approval.
    _assert_valid_lifecycle(await _drain_chat(client, tid, _input("m1", "refactor it")))
    assert (await client.get(f"/threads/{tid}")).json()["goal_status"] == "awaiting_approval"
    assert "do NOT execute yet" in captured[-1]

    # Second message while awaiting approval → refinement (REFINE_INSTRUCTION),
    # still parked awaiting approval — no execution.
    _assert_valid_lifecycle(await _drain_chat(client, tid, _input("m2", "also add tests")))
    assert (await client.get(f"/threads/{tid}")).json()["goal_status"] == "awaiting_approval"
    assert "refining the plan with the user" in captured[-1]

    # Approve → execution runs to completion.
    approve = await client.post(f"/threads/{tid}/goal/approve")
    assert approve.status_code == 200, approve.text
    _assert_valid_lifecycle(await _drain_stream(client, tid))
    assert (await client.get(f"/threads/{tid}")).json()["goal_status"] == "completed"
