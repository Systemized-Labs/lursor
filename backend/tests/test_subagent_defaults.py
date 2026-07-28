"""Tests for viewing / toggling the pydantic-deep subagent defaults."""

from __future__ import annotations

from httpx import AsyncClient
from pydantic_ai.capabilities import PrepareTools
from pydantic_ai.tools import ToolDefinition
from pydantic_ai.usage import UsageLimits
from subagents_pydantic_ai.prompts import TASK_TOOL_DESCRIPTION

from app.agents import builder
from app.agents.builder import (
    TURN_REQUEST_LIMIT,
    _subagent_config,
    _task_tool_roster_filter,
    build_deep_agent,
)
from app.db.models import Agent, Subagent, ThinkingLevel

# DB / workspace isolation and the ``client`` fixture live in ``conftest.py``.


async def test_defaults_expose_library_builtins(client: AsyncClient):
    r = await client.get("/subagents/defaults")
    assert r.status_code == 200, r.text
    body = r.json()

    names = {b["name"] for b in body["builtins"]}
    assert names == {"general-purpose", "research"}
    assert all(b["enabled"] for b in body["builtins"])
    assert all(b["default_instructions"] for b in body["builtins"])
    # Built-ins carry no editable copy — the concept is gone.
    assert all("override" not in b for b in body["builtins"])

    assert body["max_nesting_depth"] == {
        "library_default": 1,
        "override": None,
        "effective": 1,
    }


async def test_max_nesting_depth_override_and_clear(client: AsyncClient):
    r = await client.put("/subagents/defaults", json={"max_nesting_depth": 3})
    assert r.status_code == 200, r.text
    assert r.json()["max_nesting_depth"] == {
        "library_default": 1,
        "override": 3,
        "effective": 3,
    }

    r = await client.put("/subagents/defaults", json={"clear_max_nesting_depth": True})
    assert r.json()["max_nesting_depth"]["override"] is None
    assert r.json()["max_nesting_depth"]["effective"] == 1

    r = await client.put("/subagents/defaults", json={"max_nesting_depth": -1})
    assert r.status_code == 422


async def test_disable_builtin(client: AsyncClient):
    r = await client.put("/subagents/defaults", json={"disabled_builtins": ["research"]})
    assert r.status_code == 200, r.text
    by_name = {b["name"]: b for b in r.json()["builtins"]}
    assert by_name["research"]["enabled"] is False
    assert by_name["general-purpose"]["enabled"] is True

    # Unknown built-in is rejected.
    r = await client.put("/subagents/defaults", json={"disabled_builtins": ["bogus"]})
    assert r.status_code == 422

    # Re-enable.
    r = await client.put("/subagents/defaults", json={"disabled_builtins": []})
    assert all(b["enabled"] for b in r.json()["builtins"])


async def test_builtin_override_routes_are_gone(client: AsyncClient):
    """Editing a built-in is no longer a concept: disable it and author your own."""
    for method in ("put", "delete"):
        r = await getattr(client, method)(
            "/subagents/builtins/general-purpose",
            **({"json": {"description": "x", "instructions": "y"}} if method == "put" else {}),
        )
        assert r.status_code in (404, 405), f"{method}: {r.status_code}"


def _agent(**kw) -> Agent:
    return Agent(name="A", include_subagents=True, **kw)


def _prepared_task_tool_for(
    monkeypatch, row: Agent, workspace, subagents: list[Subagent], defaults
) -> ToolDefinition:
    """Build an agent, then run its task-roster rewrite over a real ``task`` def."""
    seen: dict = {}

    def fake_create_deep_agent(**kwargs):
        seen.update(kwargs)
        return object()

    monkeypatch.setattr(builder, "create_deep_agent", fake_create_deep_agent)
    build_deep_agent(row, str(workspace), {}, subagents, defaults)

    prepares = [
        c.prepare_func
        for c in seen["capabilities"]
        if isinstance(c, PrepareTools) and c.prepare_func is not builder._readonly_tool_filter
    ]
    assert len(prepares) == 1, "expected exactly one task-roster PrepareTools"
    return _prepare_task_tool(prepares[0])


def _prepare_task_tool(prepare) -> ToolDefinition:
    """Run ``prepare`` over the library's real ``task`` definition."""
    td = ToolDefinition(
        name="task",
        # What ``create_subagent_toolset`` actually registers (toolset.py:331-334).
        description=TASK_TOOL_DESCRIPTION.rstrip() + "\n\nAvailable subagent types:\n- x: y",
        parameters_json_schema={
            "type": "object",
            "properties": {
                "description": {"type": "string"},
                "subagent_type": {"type": "string"},
            },
        },
    )
    out = prepare(None, [td])
    assert len(out) == 1
    # The toolset's own schema is shared across runs and must never be mutated.
    assert "enum" not in td.parameters_json_schema["properties"]["subagent_type"]
    return out[0]


def test_task_tool_never_advertises_a_disabled_builtin(monkeypatch, tmp_path):
    """The reported bug: with ``general-purpose`` off, the model was still told to
    use it — and nothing at the schema layer could reject the call."""
    user = Subagent(name="writer", description="d", instructions="i")
    task_tool = _prepared_task_tool_for(
        monkeypatch, _agent(), tmp_path, [user], {"disabled_builtins": ["general-purpose"]}
    )

    assert "general-purpose" not in (task_tool.description or "")
    assert task_tool.parameters_json_schema["properties"]["subagent_type"]["enum"] == [
        "writer",
        "research",
    ]


def test_task_tool_roster_includes_the_planner_builtin(monkeypatch, tmp_path):
    """pydantic-deep appends ``planner`` itself when plan mode is on; mirror it or
    the enum would reject a subagent the library really does compile."""
    task_tool = _prepared_task_tool_for(monkeypatch, _agent(include_plan=True), tmp_path, [], {})

    assert task_tool.parameters_json_schema["properties"]["subagent_type"]["enum"] == [
        "general-purpose",
        "research",
        "planner",
    ]


def test_disabled_user_subagent_is_excluded_from_the_roster(monkeypatch, tmp_path):
    """Override rows used to bypass this check (they were never filtered on
    ``enabled``); with overrides gone there is one loop and one rule."""
    rows = [
        Subagent(name="on", description="d", instructions="i"),
        Subagent(name="parked", description="d", instructions="i", enabled=False),
    ]
    task_tool = _prepared_task_tool_for(monkeypatch, _agent(), tmp_path, rows, {})

    enum = task_tool.parameters_json_schema["properties"]["subagent_type"]["enum"]
    assert "on" in enum
    assert "parked" not in enum


def test_user_subagent_shadows_a_builtin_of_the_same_name(monkeypatch, tmp_path):
    """The library keys its compiled roster by name, so a duplicate would silently
    let the built-in win over the row the user authored."""
    rows = [Subagent(name="research", description="mine", instructions="i")]
    task_tool = _prepared_task_tool_for(monkeypatch, _agent(), tmp_path, rows, {})

    assert task_tool.parameters_json_schema["properties"]["subagent_type"]["enum"] == [
        "research",
        "general-purpose",
    ]


def test_task_tool_rewrite_survives_an_upstream_reword():
    """If the pinned SHA moves and the bullet changes, still say what is real."""
    td = ToolDefinition(
        name="task",
        description="Delegate a task.\n- Use whatever subagent you like.",
        parameters_json_schema={"type": "object", "properties": {}},
    )
    (out,) = _task_tool_roster_filter(["writer"])(None, [td])

    assert "Use one of: writer" in (out.description or "")


def test_task_tool_with_an_empty_roster_says_so():
    td = ToolDefinition(name="task", description=TASK_TOOL_DESCRIPTION)
    (out,) = _task_tool_roster_filter([])(None, [td])

    assert "general-purpose" not in (out.description or "")
    assert "no subagents are configured" in (out.description or "")


async def test_model_sees_only_the_real_roster_end_to_end(client: AsyncClient, tmp_path):
    """The report, reproduced against a real run: with ``general-purpose`` disabled,
    the ``task`` definition the *model* receives must neither name it nor accept it.

    The unit tests above drive the prepare hook directly; this one drives a full
    agent through a ``FunctionModel`` so a break anywhere between capability
    assembly and the wire is caught.
    """
    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.models.function import AgentInfo, FunctionModel

    row = Agent(
        name="local",
        instructions="hi",
        model="openrouter:qwen/qwen3.7-max",
        include_subagents=True,
    )
    user = Subagent(name="writer", description="d", instructions="i")

    seen: dict = {}

    def _capture(_messages, info: AgentInfo):
        seen["task"] = next(t for t in info.function_tools if t.name == "task")
        return ModelResponse(parts=[TextPart("ok")])

    agent, deps = build_deep_agent(
        row,
        str(tmp_path),
        {},
        [user],
        {"disabled_builtins": ["general-purpose"]},
    )
    with agent.override(model=FunctionModel(_capture)):
        await agent.run("hi", deps=deps)

    task_tool = seen["task"]
    assert "general-purpose" not in (task_tool.description or "")
    assert task_tool.parameters_json_schema["properties"]["subagent_type"]["enum"] == [
        "writer",
        "research",
    ]


async def test_builder_roster_respects_disable(tmp_path):
    ws = str(tmp_path)

    # Baseline: both built-ins present, plus a user subagent — builds cleanly.
    user = Subagent(name="writer", description="d", instructions="i")
    agent, _ = build_deep_agent(_agent(), ws, {}, [user], {})
    assert agent is not None

    # A disabled built-in should still build without error.
    agent2, _ = build_deep_agent(
        _agent(), ws, {}, [user], {"disabled_builtins": ["general-purpose"]}
    )
    assert agent2 is not None


async def test_subagent_full_parity_crud_roundtrips(client: AsyncClient):
    # A skill to attach (subagents can now carry skills, like top-level agents).
    r = await client.post(
        "/subagents",
        json={
            "name": "specialist",
            "description": "d",
            "instructions": "i",
            "include_memory": True,
            "include_skills": True,
            "thinking": "high",
            "tool_choice": "required",
            "extra_config": {"foo": "bar"},
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["include_memory"] is True
    assert body["thinking"] == "high"
    assert body["tool_choice"] == "required"
    assert body["extra_config"] == {"foo": "bar"}
    # Skills are scope-discovered now, not linked per-subagent.
    assert "skill_ids" not in body
    assert body["include_skills"] is True
    # Defaults for knobs not sent match the model defaults.
    assert body["include_todo"] is True
    assert body["include_subagents"] is False

    # Patch a subset; unspecified fields are preserved.
    r = await client.patch(
        f"/subagents/{body['id']}", json={"thinking": "off"}
    )
    assert r.status_code == 200, r.text
    patched = r.json()
    assert patched["thinking"] == "off"
    assert patched["include_memory"] is True  # untouched


async def test_subagent_factory_builds_full_agent_and_bounds_nesting(tmp_path):
    ws = str(tmp_path)
    sa = Subagent(
        name="deep",
        description="d",
        instructions="i",
        include_subagents=True,
        thinking=ThinkingLevel.low,
    )
    # child_depth == max_nesting_depth means this subagent sits at the floor of
    # the nesting budget: it must build as a full deep agent but NOT itself gain a
    # subagent toolset, so invoking the factory terminates instead of recursing.
    cfg = _subagent_config(
        sa,
        workspace_path=ws,
        workspace_name="deep-ws",
        workspace_description=None,
        custom_providers={},
        subagents=[sa],
        deep_defaults={"max_nesting_depth": 1},
        parent_model="openrouter:test/model",
        web_search_provider=None,
        tavily_api_key=None,
        exa_api_key=None,
        child_depth=1,
        # No skills/env resolved for this build (the parent would normally pass its
        # own runtime down).
        skill_runtime=None,
    )
    assert cfg["name"] == "deep"
    assert callable(cfg["agent_factory"])
    sub_agent = cfg["agent_factory"](cfg)
    assert sub_agent is not None


def _captured_kwargs(monkeypatch, row: Agent, workspace) -> dict:
    """Build an agent with ``create_deep_agent`` stubbed, returning its kwargs."""
    seen: dict = {}

    def fake_create_deep_agent(**kwargs):
        seen.update(kwargs)
        return object()

    monkeypatch.setattr(builder, "create_deep_agent", fake_create_deep_agent)
    build_deep_agent(row, str(workspace), {}, [], {})
    return seen


def test_subagents_get_the_same_request_budget_as_their_caller(monkeypatch, tmp_path):
    """Left unset, a delegated run is capped far below the turn that spawned it.

    pydantic-deep passes ``subagent_usage_limits`` through untouched, so ``None``
    means each ``task`` run gets pydantic-ai's bare default and a deep, tool-heavy
    delegation dies with "the next request would exceed the request_limit of 50"
    while the parent turn still had budget to spare.
    """
    kwargs = _captured_kwargs(monkeypatch, _agent(), tmp_path)

    assert kwargs["subagent_usage_limits"].request_limit == TURN_REQUEST_LIMIT
    assert UsageLimits().request_limit < TURN_REQUEST_LIMIT, (
        "upstream default no longer undercuts the turn budget — override may be moot"
    )


def test_subagent_usage_limits_stay_overridable(monkeypatch, tmp_path):
    """The ``extra_config`` escape hatch wins, and the keyword is never passed twice
    (which would be a ``TypeError`` at build time)."""
    row = _agent(extra_config={"subagent_usage_limits": None})
    kwargs = _captured_kwargs(monkeypatch, row, tmp_path)

    assert kwargs["subagent_usage_limits"] is None
