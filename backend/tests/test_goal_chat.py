"""Integration smoke for the goal-mode chat driver.

Drives the real ``POST /threads/{id}/chat`` goal path end-to-end — planning
turn, execution loop, evaluator verdict, status persistence — with a
``TestModel`` agent and a fake evaluator so it runs offline (no network, no GPU).
This covers the wiring the pure-loop unit tests can't: the continuation adapter,
``result.all_messages()`` threading, and goal-status persistence on the thread.
"""

from __future__ import annotations

import json

from ag_ui.core import RunAgentInput, UserMessage
from httpx import AsyncClient
from pydantic_ai.models.test import TestModel
from pydantic_ai_backends import LocalBackend
from pydantic_deep import GoalEvaluation, create_deep_agent, create_default_deps

# DB / workspace isolation and the ``client`` fixture live in ``conftest.py``.


class _FakeEvaluator:
    """Reports the goal met on the first execution turn."""

    async def evaluate(self, condition: str, messages: list) -> GoalEvaluation:
        return GoalEvaluation(met=True, reason="looks done")


def _fake_deep_agent(row, workspace_path, *args, **kwargs):
    """A minimal deep agent backed by ``TestModel`` (returns text, calls no tools).

    Native/builtin tools (web search/fetch, tool-search) are disabled because
    ``TestModel`` rejects them ("does not support built-in tools"); the plan
    execution turn streams a natural AG-UI lifecycle, so such an error would
    surface as RUN_ERROR rather than being masked.
    """
    backend = LocalBackend(root_dir=str(workspace_path))
    agent = create_deep_agent(
        model=TestModel(call_tools=[]),
        backend=backend,
        include_subagents=False,
        include_plan=False,
        web_search=False,
        web_fetch=False,
        tool_search=False,
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
            json={"workspace_id": ws["id"], "agent_id": agent["id"]},
        )
    ).json()
    assert thread["mode"] == "chat"
    assert thread["status"] == "idle"

    # /goal is a one-off run carried on the turn intent, not a sticky mode: the
    # objective is the message, and the thread stays a plain chat thread.
    run_input = RunAgentInput(
        thread_id=thread["id"],
        run_id="run-1",
        state=None,
        messages=[UserMessage(id="m1", role="user", content="make the tests pass")],
        tools=[],
        context=[],
        forwarded_props={"turn": "goal"},
    )
    types = await _drain_chat(
        client, thread["id"], run_input.model_dump_json(by_alias=True)
    )
    # The multi-turn goal run must present as ONE valid AG-UI lifecycle.
    _assert_valid_lifecycle(types)

    refreshed = (await client.get(f"/threads/{thread['id']}")).json()
    assert refreshed["status"] == "completed"
    assert refreshed["iteration"] == 1
    assert refreshed["last_reason"] == "looks done"
    # One-off: the thread is not left in a goal mode.
    assert refreshed["mode"] == "chat"

    # The assistant transcript must survive reload. The bug this guards against
    # was a completed goal thread reopening with only the user's turn because the
    # streamed narration lived solely in the in-memory run buffer, never the DB.
    msgs = (await client.get(f"/threads/{thread['id']}/messages")).json()
    roles = [m["role"] for m in msgs]
    assert "user" in roles
    assert any(
        m["role"] == "assistant" and m["content"] for m in msgs
    ), f"no assistant turn persisted for a completed goal run: {roles}"


async def test_interjection_is_consumed_during_execution(
    client: AsyncClient, monkeypatch
):
    """A buffered interjection is drained by the steer capability while the run
    executes — proving the ``before_model_request`` hook fires and consumes it,
    rather than the message sitting untouched until the loop ends."""
    from app.agents.goal_loop import drain_interjections, queue_interjection

    monkeypatch.setattr("app.api.chat.build_deep_agent", _fake_deep_agent)
    monkeypatch.setattr(
        "app.api.chat.build_goal_evaluator", lambda *a, **k: _FakeEvaluator()
    )

    agent = (await client.post("/agents", json={"name": "Steerer"})).json()
    ws = (await client.post("/workspaces", json={"name": "SteerWS"})).json()
    thread = (
        await client.post(
            "/threads",
            json={"workspace_id": ws["id"], "agent_id": agent["id"]},
        )
    ).json()
    tid = thread["id"]

    # Buffer a steer message before the run; the capability should drain it as the
    # agent makes its first (and only) model request.
    queue_interjection(tid, "also update the changelog")

    run_input = RunAgentInput(
        thread_id=tid,
        run_id="run-1",
        state=None,
        messages=[UserMessage(id="m1", role="user", content="make the tests pass")],
        tools=[],
        context=[],
        forwarded_props={"turn": "goal"},
    )
    _assert_valid_lifecycle(
        await _drain_chat(client, tid, run_input.model_dump_json(by_alias=True))
    )

    assert (await client.get(f"/threads/{tid}")).json()["status"] == "completed"
    # The buffer was consumed during the run (hook fired), not left dangling.
    assert drain_interjections(tid) == []


async def test_plan_thread_plans_then_executes_via_chat(
    client: AsyncClient, monkeypatch
):
    """Plan mode drafts a plan (no approval flow); leaving plan mode and chatting
    normally executes it as an ordinary full-tool turn."""
    monkeypatch.setattr("app.api.chat.build_deep_agent", _fake_deep_agent)

    agent = (await client.post("/agents", json={"name": "Goalie2"})).json()
    ws = (await client.post("/workspaces", json={"name": "GoalWS2"})).json()
    thread = (
        await client.post(
            "/threads",
            json={
                "workspace_id": ws["id"],
                "agent_id": agent["id"],
                "mode": "plan",
                "goal": "refactor the module",
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

    # Phase 1 — planning. The /chat run drafts the plan and parks awaiting review.
    _assert_valid_lifecycle(await _drain_chat(client, tid, _input("m1", "refactor it")))
    assert (await client.get(f"/threads/{tid}")).json()["status"] == "awaiting_approval"

    # Phase 2 — leave plan mode (mode→chat), then a normal chat turn executes.
    r = await client.patch(f"/threads/{tid}", json={"mode": "chat"})
    assert r.status_code == 200, r.text
    _assert_valid_lifecycle(await _drain_chat(client, tid, _input("m2", "go ahead")))
    assert (await client.get(f"/threads/{tid}")).json()["mode"] == "chat"


async def test_plan_conversation_refines_then_executes_on_exit(
    client: AsyncClient, monkeypatch
):
    """Messages in plan mode refine the plan and never execute; leaving plan mode
    is what enables execution.

    First message → a fresh plan (PLANNING_INSTRUCTION), parked awaiting review.
    A second message while still in plan mode is a refinement turn
    (REFINE_INSTRUCTION) that stays in awaiting_approval — nothing executes. Only
    after leaving plan mode does a chat turn run normally.
    """
    monkeypatch.setattr("app.api.chat.build_deep_agent", _fake_deep_agent)

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
                "mode": "plan",
                "goal": "refactor the module",
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

    # First message → fresh plan (PLANNING_INSTRUCTION), awaiting approval. The plan
    # gets its own doc under .agents/plan/, named from the plan idea (thread title),
    # persisted on the thread and referenced in the instruction.
    _assert_valid_lifecycle(await _drain_chat(client, tid, _input("m1", "refactor it")))
    parked = (await client.get(f"/threads/{tid}")).json()
    assert parked["status"] == "awaiting_approval"
    assert parked["plan_path"] == ".agents/plan/PLAN-refactor-it.md"
    assert "do NOT execute yet" in captured[-1]
    assert parked["plan_path"] in captured[-1]

    # Second message while still in plan mode → refinement (REFINE_INSTRUCTION),
    # still parked awaiting review — no execution. Same doc is reused.
    _assert_valid_lifecycle(await _drain_chat(client, tid, _input("m2", "also add tests")))
    refined = (await client.get(f"/threads/{tid}")).json()
    assert refined["status"] == "awaiting_approval"
    assert refined["plan_path"] == ".agents/plan/PLAN-refactor-it.md"
    assert "refining the plan with the user" in captured[-1]
    assert refined["plan_path"] in captured[-1]

    # Leave plan mode → a normal chat turn executes (no planning instruction).
    r = await client.patch(f"/threads/{tid}", json={"mode": "chat"})
    assert r.status_code == 200, r.text
    _assert_valid_lifecycle(await _drain_chat(client, tid, _input("m3", "go ahead")))
    assert (await client.get(f"/threads/{tid}")).json()["mode"] == "chat"
    assert captured[-1] is None or "plan" not in (captured[-1] or "").lower()


async def test_interject_requires_an_active_run(client: AsyncClient):
    """The interject endpoint only accepts steering when a run is in flight."""
    agent = (await client.post("/agents", json={"name": "Goalie4"})).json()
    ws = (await client.post("/workspaces", json={"name": "GoalWS4"})).json()

    # A thread with no run in flight → 409 (nothing to steer).
    thread = (
        await client.post(
            "/threads", json={"workspace_id": ws["id"], "agent_id": agent["id"]}
        )
    ).json()
    r = await client.post(
        f"/threads/{thread['id']}/goal/interject", json={"content": "hi"}
    )
    assert r.status_code == 409, r.text

    # Unknown thread → 404.
    r = await client.post("/threads/does-not-exist/goal/interject", json={"content": "hi"})
    assert r.status_code == 404, r.text
