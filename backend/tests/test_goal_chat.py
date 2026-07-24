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


def _fake_tool_calling_agent(row, workspace_path, *args, **kwargs):
    """Like ``_fake_deep_agent`` but its model calls tools, so turns take several
    model rounds — the only way to exercise the per-turn round cap."""
    backend = LocalBackend(root_dir=str(workspace_path))
    agent = create_deep_agent(
        model=TestModel(),  # calls every tool it is offered
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


async def test_plan_parks_then_refines_then_execute_plan_runs(
    client: AsyncClient, monkeypatch, tmp_path
):
    """`/plan` is a per-turn intent (no sticky mode): a plan turn drafts a plan doc
    and parks the thread awaiting review. While parked, a plain chat turn *refines*
    the plan (it does NOT execute) and the thread stays parked. An `execute_plan`
    turn then carries the approved plan out as a goal, seeded from the plan doc's
    Success Criteria, and runs to completion."""
    import pathlib

    monkeypatch.setattr("app.api.chat.build_deep_agent", _fake_deep_agent)
    monkeypatch.setattr(
        "app.api.chat.build_goal_evaluator", lambda *a, **k: _FakeEvaluator()
    )

    agent = (await client.post("/agents", json={"name": "Goalie2"})).json()
    ws = (await client.post("/workspaces", json={"name": "GoalWS2"})).json()
    # A plain chat thread — /plan rides on the turn intent, not the thread row.
    thread = (
        await client.post(
            "/threads",
            json={"workspace_id": ws["id"], "agent_id": agent["id"]},
        )
    ).json()
    tid = thread["id"]
    assert thread["mode"] == "chat"

    def _input(mid: str, content: str, turn: str | None = None) -> str:
        return RunAgentInput(
            thread_id=tid,
            run_id=mid,
            state=None,
            messages=[UserMessage(id=mid, role="user", content=content)],
            tools=[],
            context=[],
            forwarded_props={"turn": turn} if turn else None,
        ).model_dump_json(by_alias=True)

    # Phase 1 — a /plan turn drafts the plan and parks awaiting review.
    _assert_valid_lifecycle(
        await _drain_chat(client, tid, _input("m1", "refactor it", "plan"))
    )
    parked = (await client.get(f"/threads/{tid}")).json()
    assert parked["status"] == "awaiting_approval"
    plan_path = parked["plan_path"]
    assert plan_path == ".agents/plan/PLAN-refactor-it.md"

    # Phase 2 — a plain chat turn REFINES the plan; it stays parked (not idle).
    _assert_valid_lifecycle(await _drain_chat(client, tid, _input("m2", "tweak it")))
    refined = (await client.get(f"/threads/{tid}")).json()
    assert refined["status"] == "awaiting_approval"
    assert refined["plan_path"] == plan_path

    # Write a plan doc with a Success Criteria section so execute_plan has something
    # concrete to seed the goal loop with (the offline TestModel writes no file).
    doc = pathlib.Path(ws["path"]) / plan_path
    doc.parent.mkdir(parents=True, exist_ok=True)
    doc.write_text(
        "# Plan\n\n1. Do the thing.\n\n## Success Criteria\n\n- The thing is done.\n",
        encoding="utf-8",
    )

    # Phase 3 — "Execute plan" carries the approved plan out as a goal. The turn's
    # body is ignored; the goal is derived from the plan doc's Success Criteria.
    _assert_valid_lifecycle(
        await _drain_chat(client, tid, _input("m3", "Execute plan", "execute_plan"))
    )
    executed = (await client.get(f"/threads/{tid}")).json()
    assert executed["mode"] == "chat"
    assert executed["status"] == "completed"
    # The objective shown in the goal header is the plan's H1 title, not the path.
    assert executed["goal"] == "Plan"
    assert "The thing is done." in executed["success_criteria"]


async def test_execute_plan_seeds_the_loop_with_a_clean_context(
    client: AsyncClient, monkeypatch, tmp_path
):
    """Executing a plan is a context boundary: the execution loop is seeded with no
    prior history, so the planning back-and-forth never reaches the model — the
    approved plan rides in via the kickoff instead. No transcript surgery: the
    planning conversation stays visible in scrollback. A bare ``/goal`` keeps its
    own transcript as its seed."""
    import pathlib

    monkeypatch.setattr("app.api.chat.build_deep_agent", _fake_deep_agent)
    monkeypatch.setattr(
        "app.api.chat.build_goal_evaluator", lambda *a, **k: _FakeEvaluator()
    )

    # Capture the history the execution loop is seeded with — it must be empty for an
    # execute_plan turn regardless of how much planning preceded it.
    seen: dict = {}
    real_run = __import__("app.api.chat", fromlist=["_run_goal_execution"])._run_goal_execution

    async def spy_run(*args, **kwargs):
        seen["initial_history"] = kwargs.get("initial_history")
        return await real_run(*args, **kwargs)

    monkeypatch.setattr("app.api.chat._run_goal_execution", spy_run)

    agent = (await client.post("/agents", json={"name": "Goalie3"})).json()
    ws = (await client.post("/workspaces", json={"name": "GoalWS3"})).json()
    thread = (
        await client.post(
            "/threads", json={"workspace_id": ws["id"], "agent_id": agent["id"]}
        )
    ).json()
    tid = thread["id"]

    def _input(mid: str, content: str, turn: str | None = None) -> str:
        return RunAgentInput(
            thread_id=tid,
            run_id=mid,
            state=None,
            messages=[UserMessage(id=mid, role="user", content=content)],
            tools=[],
            context=[],
            forwarded_props={"turn": turn} if turn else None,
        ).model_dump_json(by_alias=True)

    # Plan, then refine — building up a planning transcript.
    _assert_valid_lifecycle(
        await _drain_chat(client, tid, _input("m1", "refactor it", "plan"))
    )
    plan_path = (await client.get(f"/threads/{tid}")).json()["plan_path"]
    _assert_valid_lifecycle(await _drain_chat(client, tid, _input("m2", "tweak it")))

    doc = pathlib.Path(ws["path"]) / plan_path
    doc.parent.mkdir(parents=True, exist_ok=True)
    doc.write_text(
        "# Plan\n\n1. Do the thing.\n\n## Success Criteria\n\n- The thing is done.\n",
        encoding="utf-8",
    )

    # Before executing, the planning turns are visible.
    before = (await client.get(f"/threads/{tid}/messages")).json()
    assert any(m["content"] == "refactor it" for m in before)

    _assert_valid_lifecycle(
        await _drain_chat(client, tid, _input("m3", "Execute plan", "execute_plan"))
    )

    # The execution loop was seeded with no prior transcript — the planning
    # back-and-forth never reaches the model.
    assert seen["initial_history"] == []

    # The planning transcript stays visible in scrollback (no compaction, no
    # divider/goal_brief surgery); the goal header reads the plan's H1 title.
    after = (await client.get(f"/threads/{tid}/messages")).json()
    assert any(m["content"] == "refactor it" for m in after)
    assert any(m["content"] == "tweak it" for m in after)
    assert not any(m["kind"] in {"divider", "goal_brief"} for m in after)
    executed = (await client.get(f"/threads/{tid}")).json()
    assert executed["goal"] == "Plan"
    assert "The thing is done." in executed["success_criteria"]


async def test_spent_round_budget_keeps_the_turns_work(
    client: AsyncClient, monkeypatch
):
    """Regression: a goal turn that exhausts its per-turn model-round budget.

    pydantic-ai enforces the cap by raising, and its UI event stream *catches*
    that and re-emits it as RUN_ERROR — which a goal run strips, since one outer
    lifecycle wraps every turn. The turn therefore produced no ``AgentRunResult``,
    and the loop used to fall back to the *pre-turn* history: every turn's work
    was discarded, the agent redid it, hit the cap again, and the run ground to
    the iteration cap having kept nothing.

    Drives the real endpoint with the cap forced low so each turn trips it. The
    history handed to the evaluator must grow turn over turn.
    """
    seen: list[int] = []

    class _RecordingEvaluator:
        async def evaluate(self, condition: str, messages: list) -> GoalEvaluation:
            seen.append(len(messages))
            return GoalEvaluation(met=False, reason="not yet")

    monkeypatch.setattr("app.api.chat.build_deep_agent", _fake_tool_calling_agent)
    monkeypatch.setattr(
        "app.api.chat.build_goal_evaluator", lambda *a, **k: _RecordingEvaluator()
    )
    # One model round per turn, so the second round trips the cap every turn.
    monkeypatch.setattr("app.api.chat._MAX_TURN_REQUESTS", 1)

    agent = (await client.post("/agents", json={"name": "Capped"})).json()
    ws = (await client.post("/workspaces", json={"name": "CappedWS"})).json()
    thread = (
        await client.post(
            "/threads", json={"workspace_id": ws["id"], "agent_id": agent["id"]}
        )
    ).json()
    tid = thread["id"]
    # Keep the run short; the point is what happens between turns.
    await client.patch(f"/threads/{tid}", json={"max_iterations": 3})

    body = RunAgentInput(
        thread_id=tid,
        run_id="capped-1",
        state=None,
        messages=[UserMessage(id="c1", role="user", content="do the long thing")],
        tools=[],
        context=[],
        forwarded_props={"turn": "goal"},
    ).model_dump_json(by_alias=True)
    types = await _drain_chat(client, tid, body)
    _assert_valid_lifecycle(types)

    # Each turn ran and was evaluated — a spent round budget is a turn boundary,
    # not a failure, so it does not trip the turn-error breaker.
    assert len(seen) == 3, f"expected 3 evaluated turns, got {seen}"
    # The heart of it: history grows. Before the fix this was [1, 1, 1] — every
    # turn's work thrown away and the same turn attempted from scratch.
    assert seen == sorted(seen) and seen[-1] > seen[0], (
        f"history did not carry forward across capped turns: {seen}"
    )

    refreshed = (await client.get(f"/threads/{tid}")).json()
    assert refreshed["status"] == "failed"  # genuinely out of iterations
    assert refreshed["iteration"] == 3


async def test_failed_goal_turn_surfaces_instead_of_silently_looping(
    client: AsyncClient, monkeypatch
):
    """A goal turn that dies for a real reason reports it and stops early.

    Distinct from the round-budget case above: there is no work to keep and
    retrying the same broken thing 25 times helps nobody, so the loop trips its
    breaker and the thread ends `blocked` naming the cause — rather than
    `failed` with the evaluator's unrelated "not met" reason.
    """
    monkeypatch.setattr("app.api.chat.build_deep_agent", _fake_deep_agent)
    monkeypatch.setattr(
        "app.api.chat.build_goal_evaluator", lambda *a, **k: _FakeEvaluator()
    )

    from app.agents.goal_loop import TurnResult
    from app.api import chat as chat_mod

    real_stream_turn = chat_mod._stream_turn

    async def broken_stream_turn(*args, **kwargs):
        turn = await real_stream_turn(*args, **kwargs)
        # Same shape `_stream_turn` returns when pydantic-ai's stream reports a
        # failed run: no result, so no work, plus the reason.
        return TurnResult(messages=turn.messages, error="model provider is down")

    monkeypatch.setattr("app.api.chat._stream_turn", broken_stream_turn)

    agent = (await client.post("/agents", json={"name": "Broken"})).json()
    ws = (await client.post("/workspaces", json={"name": "BrokenWS"})).json()
    thread = (
        await client.post(
            "/threads", json={"workspace_id": ws["id"], "agent_id": agent["id"]}
        )
    ).json()
    tid = thread["id"]
    await client.patch(f"/threads/{tid}", json={"max_iterations": 25})

    body = RunAgentInput(
        thread_id=tid,
        run_id="broken-1",
        state=None,
        messages=[UserMessage(id="b1", role="user", content="do the thing")],
        tools=[],
        context=[],
        forwarded_props={"turn": "goal"},
    ).model_dump_json(by_alias=True)
    await _drain_chat(client, tid, body)

    refreshed = (await client.get(f"/threads/{tid}")).json()
    assert refreshed["status"] == "blocked"
    # The real cause reaches the user instead of being swallowed with the
    # per-turn RUN_ERROR events a goal run strips.
    assert "model provider is down" in refreshed["last_reason"]
    # Bailed fast rather than burning all 25 iterations on the same failure.
    assert refreshed["iteration"] == 0


async def test_goal_command_keeps_its_transcript(client: AsyncClient, monkeypatch):
    """Regression: a bare ``/goal`` is NOT a plan handoff, so it must not compact
    the thread — its objective *is* the conversation."""
    monkeypatch.setattr("app.api.chat.build_deep_agent", _fake_deep_agent)
    monkeypatch.setattr(
        "app.api.chat.build_goal_evaluator", lambda *a, **k: _FakeEvaluator()
    )

    agent = (await client.post("/agents", json={"name": "Goalie4"})).json()
    ws = (await client.post("/workspaces", json={"name": "GoalWS4"})).json()
    thread = (
        await client.post(
            "/threads", json={"workspace_id": ws["id"], "agent_id": agent["id"]}
        )
    ).json()
    tid = thread["id"]

    body = RunAgentInput(
        thread_id=tid,
        run_id="g1",
        state=None,
        messages=[UserMessage(id="g1", role="user", content="make it work")],
        tools=[],
        context=[],
        forwarded_props={"turn": "goal"},
    ).model_dump_json(by_alias=True)
    _assert_valid_lifecycle(await _drain_chat(client, tid, body))

    msgs = (await client.get(f"/threads/{tid}/messages")).json()
    # The goal objective turn survives (nothing was compacted) and no divider was added.
    assert any(m["content"] == "make it work" for m in msgs)
    assert not any(m["kind"] == "divider" for m in msgs)


async def test_plain_message_refines_a_parked_plan_and_slash_plan_starts_fresh(
    client: AsyncClient, monkeypatch
):
    """While a plan is parked, a plain chat message refines the existing doc
    (REFINE_INSTRUCTION), never executing; a fresh `/plan` starts a NEW plan
    (PLANNING_INSTRUCTION). Both stay in awaiting_approval.
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
            json={"workspace_id": ws["id"], "agent_id": agent["id"]},
        )
    ).json()
    tid = thread["id"]

    def _input(mid: str, content: str, turn: str | None = None) -> str:
        return RunAgentInput(
            thread_id=tid,
            run_id=mid,
            state=None,
            messages=[UserMessage(id=mid, role="user", content=content)],
            tools=[],
            context=[],
            forwarded_props={"turn": turn} if turn else None,
        ).model_dump_json(by_alias=True)

    # First /plan → fresh plan (PLANNING_INSTRUCTION), awaiting approval. The plan
    # gets its own doc under .agents/plan/; the agent names it, but the offline
    # TestModel writes nothing, so the path falls back to a title-derived slug.
    _assert_valid_lifecycle(
        await _drain_chat(client, tid, _input("m1", "refactor it", "plan"))
    )
    parked = (await client.get(f"/threads/{tid}")).json()
    assert parked["status"] == "awaiting_approval"
    assert parked["plan_path"] == ".agents/plan/PLAN-refactor-it.md"
    assert "do NOT execute yet" in captured[-1]
    # The fresh instruction directs the agent to name its own file under .agents/plan/.
    assert ".agents/plan/" in captured[-1]

    # A plain chat turn while parked → refinement (REFINE_INSTRUCTION), still parked
    # awaiting review — no execution. Same doc is reused.
    _assert_valid_lifecycle(
        await _drain_chat(client, tid, _input("m2", "also add tests"))
    )
    refined = (await client.get(f"/threads/{tid}")).json()
    assert refined["status"] == "awaiting_approval"
    assert refined["plan_path"] == ".agents/plan/PLAN-refactor-it.md"
    assert "refining the plan with the user" in captured[-1]
    assert refined["plan_path"] in captured[-1]

    # A fresh /plan while parked → a NEW plan (PLANNING_INSTRUCTION again), not a
    # refinement. Still parked, nothing executes.
    _assert_valid_lifecycle(
        await _drain_chat(client, tid, _input("m3", "start over", "plan"))
    )
    replanned = (await client.get(f"/threads/{tid}")).json()
    assert replanned["status"] == "awaiting_approval"
    assert "do NOT execute yet" in captured[-1]
    assert "refining the plan with the user" not in captured[-1]


def test_detect_written_plan_picks_the_agent_named_doc(tmp_path):
    """`detect_written_plan` finds the file a planning turn wrote, agent-named."""
    from app.agents.goal_loop import PLAN_DIR, detect_written_plan, scan_plan_dir

    plan_dir = tmp_path / PLAN_DIR
    plan_dir.mkdir(parents=True)

    # Nothing written yet → no plan detected.
    before = scan_plan_dir(tmp_path)
    assert detect_written_plan(tmp_path, before) is None

    # The agent writes a descriptively-named doc → that's the plan.
    (plan_dir / "PLAN-stripe-checkout.md").write_text("# plan", encoding="utf-8")
    assert (
        detect_written_plan(tmp_path, before)
        == f"{PLAN_DIR}/PLAN-stripe-checkout.md"
    )

    # A later refinement snapshot that sees no change → nothing new detected.
    after = scan_plan_dir(tmp_path)
    assert detect_written_plan(tmp_path, after) is None

    # A non-PLAN- markdown also written the same round loses to the PLAN- name.
    (plan_dir / "notes.md").write_text("scratch", encoding="utf-8")
    assert (
        detect_written_plan(tmp_path, before)
        == f"{PLAN_DIR}/PLAN-stripe-checkout.md"
    )


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


def _chat_input(mid: str, content: str) -> str:
    """A plain (turn-less) chat RunAgentInput body, serialized for POST /chat."""
    return RunAgentInput(
        thread_id="ignored",
        run_id=mid,
        state=None,
        messages=[UserMessage(id=mid, role="user", content=content)],
        tools=[],
        context=[],
        forwarded_props=None,
    ).model_dump_json(by_alias=True)


async def test_compact_condenses_history_into_a_summary(
    client: AsyncClient, monkeypatch
):
    """/compact hides prior messages behind a single summary the model then sees."""
    monkeypatch.setattr("app.api.chat.build_deep_agent", _fake_deep_agent)
    # Stub the summarizer so the test stays offline and asserts a known digest.
    seen: dict = {}

    async def _fake_summarize(messages, model_str, custom_providers=None):
        seen["count"] = len(messages)
        return "SUMMARY: condensed transcript"

    monkeypatch.setattr("app.api.chat.summarize_thread", _fake_summarize)

    agent = (await client.post("/agents", json={"name": "Compactor"})).json()
    ws = (await client.post("/workspaces", json={"name": "CompactWS"})).json()
    tid = (
        await client.post(
            "/threads", json={"workspace_id": ws["id"], "agent_id": agent["id"]}
        )
    ).json()["id"]

    # Two plain chat turns → user + assistant messages persisted each turn.
    _assert_valid_lifecycle(await _drain_chat(client, tid, _chat_input("m1", "hello")))
    _assert_valid_lifecycle(await _drain_chat(client, tid, _chat_input("m2", "more")))
    before = (await client.get(f"/threads/{tid}/messages")).json()
    assert len(before) >= 2

    r = await client.post(f"/threads/{tid}/compact")
    assert r.status_code == 200, r.text
    assert r.json()["compacted"] is True
    assert seen["count"] == len(before)  # every visible message was summarized

    # The thread now shows only the summary, marked with its own kind.
    after = (await client.get(f"/threads/{tid}/messages")).json()
    assert len(after) == 1
    assert after[0]["role"] == "assistant"
    assert after[0]["kind"] == "summary"
    assert after[0]["content"] == "SUMMARY: condensed transcript"


async def test_compact_needs_history_and_a_real_thread(
    client: AsyncClient, monkeypatch
):
    """Compact is a no-op on a thread too short to condense, and 404s if missing."""
    async def _fake_summarize(messages, model_str, custom_providers=None):
        raise AssertionError("summarizer must not run without enough history")

    monkeypatch.setattr("app.api.chat.summarize_thread", _fake_summarize)

    agent = (await client.post("/agents", json={"name": "Compactor2"})).json()
    ws = (await client.post("/workspaces", json={"name": "CompactWS2"})).json()
    tid = (
        await client.post(
            "/threads", json={"workspace_id": ws["id"], "agent_id": agent["id"]}
        )
    ).json()["id"]

    # Empty thread → nothing to compact (summarizer never invoked).
    r = await client.post(f"/threads/{tid}/compact")
    assert r.status_code == 200, r.text
    assert r.json()["compacted"] is False

    # Unknown thread → 404.
    r = await client.post("/threads/does-not-exist/compact")
    assert r.status_code == 404, r.text
