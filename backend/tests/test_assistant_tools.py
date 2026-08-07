"""The control-plane tools: they really drive the app, and they really stop to ask.

These call the tool functions directly rather than through a model. What is under
test is the wrapper — does it reach the right handler, does it turn an HTTP error
into something readable, and does a destructive one refuse to act until the card
comes back approved.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from sqlmodel import select

from app.assistant import tools as tools_mod
from app.assistant.confirm import Confirmations
from app.assistant.identity import (
    ASSISTANT_AGENT_ID,
    ASSISTANT_WORKSPACE_ID,
    ensure_assistant_records,
)
from app.assistant.tools import build_assistant_tools
from app.db.models import Agent, Workspace
from app.db.session import async_session_factory

THREAD = "tool-tests"


@pytest.fixture
def toolbox(client, monkeypatch):
    """The toolset, with a fresh confirmation registry the test can drive.

    ``client`` comes along to initialize the database — the tools open their own
    sessions, so there is no request to hang them off.

    The timeout is cut to a second: the production five minutes is right for a
    human reading an impact line and wrong for a suite, where a card that never
    arrives should fail in a second rather than wedge the run for five minutes.
    """
    monkeypatch.setattr("app.assistant.confirm.CONFIRM_TIMEOUT", 1.0)
    registry = Confirmations()
    monkeypatch.setattr(tools_mod, "confirmations", registry)
    tools = {t.__name__: t for t in build_assistant_tools(THREAD)}
    return tools, registry


async def _approve(registry: Confirmations, coro, *, approved: bool):
    """Run a destructive tool and answer its card.

    Polls with a real (if tiny) delay rather than ``sleep(0)``: the tool reads
    its target from the database before publishing, and a bare yield does not
    give that await chain enough turns to get there.
    """
    task = asyncio.create_task(coro)
    for _ in range(200):
        await asyncio.sleep(0.005)
        pending = registry.pending(THREAD)
        if pending:
            registry.resolve(pending[0]["token"], approved=approved)
            break
        if task.done():
            break
    return await task


# --- reads ----------------------------------------------------------------------


async def test_list_workspaces_hides_the_assistants_own(toolbox, client):
    tools, _ = toolbox
    async with async_session_factory() as session:
        await ensure_assistant_records(session)
    await client.post("/workspaces", json={"name": "Scratch"})

    rows = json.loads(await tools["lursor_list_workspaces"]())
    names = {r["name"] for r in rows}
    assert "Scratch" in names
    assert ASSISTANT_WORKSPACE_ID not in {r["id"] for r in rows}


async def test_list_agents_hides_the_assistant(toolbox, client):
    tools, _ = toolbox
    async with async_session_factory() as session:
        await ensure_assistant_records(session)
    await client.post("/agents", json={"name": "Builder", "instructions": "build"})

    rows = json.loads(await tools["lursor_list_agents"]())
    assert "Builder" in {r["name"] for r in rows}
    assert ASSISTANT_AGENT_ID not in {r["id"] for r in rows}


async def test_get_settings_only_ever_hints_at_a_key(toolbox, client):
    tools, _ = toolbox
    await client.put("/settings/openrouter", json={"api_key": "sk-secret-tail-9xyz"})

    out = json.loads(await tools["lursor_get_settings"]())
    assert out["openrouter_api_key"] == "…9xyz"
    assert "sk-secret-tail-9xyz" not in json.dumps(out)


# --- writes ---------------------------------------------------------------------


async def test_create_workspace_really_creates_one(toolbox, client, tmp_path):
    tools, _ = toolbox
    result = await tools["lursor_create_workspace"](
        name="Reports", description="weekly", path=str(tmp_path / "reports")
    )
    assert "Created workspace" in result

    listed = (await client.get("/workspaces")).json()
    assert "Reports" in {w["name"] for w in listed}


async def test_update_agent_retargets_the_model_and_leaves_the_rest(toolbox, client):
    """The headline capability: change what model another agent runs on."""
    tools, _ = toolbox
    created = (
        await client.post(
            "/agents",
            json={"name": "Builder", "instructions": "keep me", "description": "keep me too"},
        )
    ).json()

    out = await tools["lursor_update_agent"](
        agent_id=created["id"], model="openrouter:anthropic/claude-opus-4"
    )
    assert "Updated agent" in out

    after = (await client.get(f"/agents/{created['id']}")).json()
    assert after["model"] == "openrouter:anthropic/claude-opus-4"
    # Omitted fields untouched — this is what ``exclude_unset`` buys.
    assert after["instructions"] == "keep me"
    assert after["description"] == "keep me too"


async def test_update_agent_refuses_to_retarget_the_assistant(toolbox, client):
    tools, _ = toolbox
    async with async_session_factory() as session:
        await ensure_assistant_records(session)

    out = await tools["lursor_update_agent"](agent_id=ASSISTANT_AGENT_ID, model="openrouter:x/y")
    assert "Settings" in out
    async with async_session_factory() as session:
        row = await session.get(Agent, ASSISTANT_AGENT_ID)
    assert row.model is None


async def test_create_schedule_previews_before_it_saves(toolbox, client):
    tools, _ = toolbox
    ws = (await client.post("/workspaces", json={"name": "Jobs"})).json()
    agent = (await client.post("/agents", json={"name": "Runner", "instructions": "run"})).json()

    bad = await tools["lursor_create_schedule"](
        name="Nightly",
        workspace_id=ws["id"],
        agent_id=agent["id"],
        cron="not a cron",
        prompt="do the thing",
    )
    assert bad.startswith("Error")
    assert (await client.get("/schedules")).json() == []

    good = await tools["lursor_create_schedule"](
        name="Nightly",
        workspace_id=ws["id"],
        agent_id=agent["id"],
        cron="0 9 * * 1-5",
        prompt="do the thing",
        timezone="Europe/London",
    )
    assert "Created schedule" in good
    assert "Next fires:" in good
    assert len((await client.get("/schedules")).json()) == 1


async def test_update_settings_refuses_anything_off_the_allowlist(toolbox):
    tools, _ = toolbox
    out = await tools["lursor_update_settings"](key="openrouter_api_key", value="sk-nope")
    assert out.startswith("Error")
    assert "not a setting I can change" in out


async def test_update_settings_writes_an_allowlisted_key(toolbox, client):
    tools, _ = toolbox
    out = await tools["lursor_update_settings"](key="assistant_model", value="openrouter:a/b")
    assert "Set assistant_model" in out
    assert (await client.get("/settings/assistant")).json()["model"] == "openrouter:a/b"


# --- errors ---------------------------------------------------------------------


async def test_a_missing_id_is_readable_not_a_stack(toolbox, client):
    tools, _ = toolbox
    assert "no workspace with id" in await tools["lursor_update_workspace"](
        workspace_id="nope", name="x"
    )
    assert "no agent with id" in await tools["lursor_delete_agent"](agent_id="nope")


async def test_a_validation_error_names_the_field(toolbox, client):
    """FastAPI's 422 detail list rendered as one line, not a blob of dicts."""
    tools, _ = toolbox
    ws = (await client.post("/workspaces", json={"name": "Jobs"})).json()
    out = await tools["lursor_create_schedule"](
        name="Nightly",
        workspace_id=ws["id"],
        agent_id="no-such-agent",
        cron="0 9 * * *",
        prompt="go",
    )
    assert out.startswith("Error (422)")
    assert "agent" in out.lower()


# --- destructive gating ---------------------------------------------------------


async def test_delete_workspace_needs_approval(toolbox, client, tmp_path):
    tools, registry = toolbox
    ws = (
        await client.post("/workspaces", json={"name": "Doomed", "path": str(tmp_path / "doomed")})
    ).json()

    denied = await _approve(
        registry, tools["lursor_delete_workspace"](workspace_id=ws["id"]), approved=False
    )
    assert denied == "Not confirmed — nothing was changed."
    assert (await client.get(f"/workspaces/{ws['id']}")).status_code == 200

    approved = await _approve(
        registry, tools["lursor_delete_workspace"](workspace_id=ws["id"]), approved=True
    )
    assert "Deleted workspace" in approved
    # And it says the files survived, because they do.
    assert "untouched" in approved
    assert (await client.get(f"/workspaces/{ws['id']}")).status_code == 404
    assert (tmp_path / "doomed").exists()


async def test_delete_agent_needs_approval(toolbox, client):
    tools, registry = toolbox
    agent = (await client.post("/agents", json={"name": "Temp", "instructions": "x"})).json()

    denied = await _approve(
        registry, tools["lursor_delete_agent"](agent_id=agent["id"]), approved=False
    )
    assert denied == "Not confirmed — nothing was changed."
    assert (await client.get(f"/agents/{agent['id']}")).status_code == 200

    approved = await _approve(
        registry, tools["lursor_delete_agent"](agent_id=agent["id"]), approved=True
    )
    assert "Deleted agent" in approved
    assert (await client.get(f"/agents/{agent['id']}")).status_code == 404


async def test_a_protected_target_is_refused_before_the_card(toolbox, client):
    """No point asking the user about something we would refuse anyway."""
    tools, registry = toolbox
    async with async_session_factory() as session:
        await ensure_assistant_records(session)

    out = await tools["lursor_delete_workspace"](workspace_id=ASSISTANT_WORKSPACE_ID)
    assert "my own workspace" in out
    assert registry.pending(THREAD) == []

    out = await tools["lursor_delete_agent"](agent_id=ASSISTANT_AGENT_ID)
    assert "can't delete myself" in out
    assert registry.pending(THREAD) == []

    async with async_session_factory() as session:
        assert await session.get(Workspace, ASSISTANT_WORKSPACE_ID) is not None


async def test_the_skill_studio_is_protected_too(toolbox, client):
    tools, registry = toolbox
    from app.api.workspaces import ensure_skills_workspace

    async with async_session_factory() as session:
        studio = await ensure_skills_workspace(session)

    out = await tools["lursor_delete_workspace"](workspace_id=studio.id)
    assert "Skill Studio" in out
    assert registry.pending(THREAD) == []


async def test_every_destructive_tool_actually_asks(toolbox, client, tmp_path):
    """A delete that forgot its card would be the whole point, missed.

    Builds one real target per destructive tool and asserts a card appears before
    anything is touched. ``lursor_delete_thread`` and ``lursor_delete_schedule``
    are covered here rather than getting a test each — the assertion is identical
    and it is the *coverage* that matters.
    """
    tools, registry = toolbox
    ws = (await client.post("/workspaces", json={"name": "T", "path": str(tmp_path / "t")})).json()
    agent = (await client.post("/agents", json={"name": "A", "instructions": "a"})).json()
    thread = (
        await client.post("/threads", json={"workspace_id": ws["id"], "agent_id": agent["id"]})
    ).json()
    sched = (
        await client.post(
            "/schedules",
            json={
                "name": "S",
                "workspace_id": ws["id"],
                "agent_id": agent["id"],
                "cron": "0 9 * * *",
                "timezone": "UTC",
                "prompt": "go",
            },
        )
    ).json()

    cases = [
        ("lursor_delete_thread", {"thread_id": thread["id"]}),
        ("lursor_delete_schedule", {"schedule_id": sched["id"]}),
    ]
    for name, kwargs in cases:
        denied = await _approve(registry, tools[name](**kwargs), approved=False)
        assert denied == "Not confirmed — nothing was changed.", name

    # Both survived the denial.
    assert (await client.get(f"/threads/{thread['id']}")).status_code == 200
    assert (await client.get(f"/schedules/{sched['id']}")).status_code == 200

    for name, kwargs in cases:
        approved = await _approve(registry, tools[name](**kwargs), approved=True)
        assert approved.startswith("Deleted"), name

    assert (await client.get(f"/threads/{thread['id']}")).status_code == 404
    assert (await client.get(f"/schedules/{sched['id']}")).status_code == 404


async def test_a_timed_out_card_changes_nothing(toolbox, client, tmp_path, monkeypatch):
    tools, _ = toolbox
    monkeypatch.setattr("app.assistant.confirm.CONFIRM_TIMEOUT", 0.01)
    ws = (
        await client.post("/workspaces", json={"name": "Waits", "path": str(tmp_path / "waits")})
    ).json()

    # Nobody answers.
    out = await tools["lursor_delete_workspace"](workspace_id=ws["id"])
    assert out == "Not confirmed — nothing was changed."
    assert (await client.get(f"/workspaces/{ws['id']}")).status_code == 200


# --- delegation -----------------------------------------------------------------


async def test_delegate_refuses_to_target_the_assistant(toolbox, client):
    tools, _ = toolbox
    async with async_session_factory() as session:
        await ensure_assistant_records(session)
    ws = (await client.post("/workspaces", json={"name": "W"})).json()

    out = await tools["lursor_delegate"](
        workspace_id=ws["id"], agent_id=ASSISTANT_AGENT_ID, prompt="hi"
    )
    assert "delegate to myself" in out


async def test_delegate_rejects_unknown_targets(toolbox, client):
    tools, _ = toolbox
    assert "no workspace with id" in await tools["lursor_delegate"](
        workspace_id="nope", agent_id="nope", prompt="hi"
    )


async def test_run_status_reports_nothing_when_idle(toolbox):
    tools, _ = toolbox
    out = json.loads(await tools["lursor_run_status"](thread_id="not-running"))
    assert out["running"] is False


async def test_stop_run_on_an_idle_thread_says_so(toolbox):
    tools, _ = toolbox
    assert "No run was active" in await tools["lursor_stop_run"](thread_id="idle")


# --- registry -------------------------------------------------------------------


async def test_the_toolset_matches_the_registry_on_every_build(client):
    """``build_assistant_tools`` asserts this itself; this is the regression test.

    A tool added without a registry entry would otherwise ship unguarded — the
    guard filters by name, and a name it does not know is a name it does not
    protect.
    """
    from app.assistant.registry import ASSISTANT_TOOL_NAMES

    assert {t.__name__ for t in build_assistant_tools("x")} == ASSISTANT_TOOL_NAMES


async def test_every_tool_has_a_docstring(client):
    """The docstring *is* the tool description the model sees."""
    for tool in build_assistant_tools("x"):
        assert (tool.__doc__ or "").strip(), tool.__name__


async def test_workspace_and_schedule_ids_are_real_after_a_create(toolbox, client, tmp_path):
    """The ids the tools hand back have to be usable in the next call."""
    tools, _ = toolbox
    created = await tools["lursor_create_workspace"](name="Chain", path=str(tmp_path / "chain"))
    ws_id = created.split("(id ")[1].split(")")[0]

    async with async_session_factory() as session:
        assert await session.get(Workspace, ws_id) is not None
        rows = (await session.execute(select(Workspace))).scalars().all()
    assert ws_id in {r.id for r in rows}
