"""Tests for viewing / overriding the pydantic-deep subagent defaults."""

from __future__ import annotations

from httpx import AsyncClient

from app.agents.builder import _subagent_config, build_deep_agent
from app.db.models import Agent, Subagent, ThinkingLevel

# DB / workspace isolation and the ``client`` fixture live in ``conftest.py``.


async def test_defaults_expose_library_builtins(client: AsyncClient):
    r = await client.get("/subagents/defaults")
    assert r.status_code == 200, r.text
    body = r.json()

    names = {b["name"] for b in body["builtins"]}
    assert names == {"general-purpose", "research"}
    assert all(b["enabled"] for b in body["builtins"])
    assert all(b["override"] is None for b in body["builtins"])
    assert all(b["default_instructions"] for b in body["builtins"])

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


async def test_override_builtin_and_hidden_from_roster(client: AsyncClient):
    r = await client.put(
        "/subagents/builtins/general-purpose",
        json={"description": "my gp", "instructions": "do it my way", "model": None},
    )
    assert r.status_code == 200, r.text
    gp = next(b for b in r.json()["builtins"] if b["name"] == "general-purpose")
    assert gp["override"] is not None
    assert gp["override"]["description"] == "my gp"
    assert gp["override"]["builtin_name"] == "general-purpose"

    # The override row must not leak into the normal roster listing.
    roster = (await client.get("/subagents")).json()
    assert all(s.get("builtin_name") is None for s in roster)
    assert "general-purpose" not in {s["name"] for s in roster}

    # Reset reverts to the library default.
    r = await client.delete("/subagents/builtins/general-purpose")
    assert r.status_code == 200, r.text
    gp = next(b for b in r.json()["builtins"] if b["name"] == "general-purpose")
    assert gp["override"] is None

    # Unknown built-in -> 404.
    assert (
        await client.put(
            "/subagents/builtins/nope", json={"description": "x", "instructions": "y"}
        )
    ).status_code == 404


def _agent(**kw) -> Agent:
    return Agent(name="A", include_subagents=True, **kw)


async def test_builder_roster_respects_disable_and_override(tmp_path):
    ws = str(tmp_path)

    # Baseline: both built-ins present, plus a user subagent — builds cleanly.
    user = Subagent(name="writer", description="d", instructions="i")
    agent, _ = build_deep_agent(_agent(), ws, {}, [user], {})
    assert agent is not None

    # Disabled built-in + override should still build without error.
    override = Subagent(
        name="research", builtin_name="research", description="d", instructions="i"
    )
    agent2, _ = build_deep_agent(
        _agent(), ws, {}, [user, override], {"disabled_builtins": ["general-purpose"]}
    )
    assert agent2 is not None


async def test_subagent_full_parity_crud_roundtrips(client: AsyncClient):
    # A skill to attach (subagents can now carry skills, like top-level agents).
    skill = (
        await client.post("/skills", json={"name": "Digest", "content": "# how"})
    ).json()

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
            "skill_ids": [skill["id"]],
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["include_memory"] is True
    assert body["thinking"] == "high"
    assert body["tool_choice"] == "required"
    assert body["extra_config"] == {"foo": "bar"}
    assert body["skill_ids"] == [skill["id"]]
    # Defaults for knobs not sent match the model defaults.
    assert body["include_todo"] is True
    assert body["include_subagents"] is False

    # Patch a subset; unspecified fields are preserved.
    r = await client.patch(
        f"/subagents/{body['id']}", json={"thinking": "off", "skill_ids": []}
    )
    assert r.status_code == 200, r.text
    patched = r.json()
    assert patched["thinking"] == "off"
    assert patched["skill_ids"] == []
    assert patched["include_memory"] is True  # untouched

    # Unknown skill id is rejected.
    assert (
        await client.post(
            "/subagents",
            json={"name": "x", "skill_ids": ["nope"]},
        )
    ).status_code == 400


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
        custom_providers={},
        subagents=[sa],
        deep_defaults={"max_nesting_depth": 1},
        parent_model="openrouter:test/model",
        web_search_provider=None,
        tavily_api_key=None,
        exa_api_key=None,
        child_depth=1,
    )
    assert cfg["name"] == "deep"
    assert callable(cfg["agent_factory"])
    sub_agent = cfg["agent_factory"](cfg)
    assert sub_agent is not None
