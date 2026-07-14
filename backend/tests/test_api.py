"""End-to-end CRUD tests exercising the ASGI app against a temp SQLite DB."""

from __future__ import annotations

import os
import tempfile

import pytest
from httpx import ASGITransport, AsyncClient

# Point the app at throwaway DB + workspace dirs before importing it.
_tmp = tempfile.mkdtemp(prefix="lursor-test-")
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_tmp}/test.db"
os.environ["WORKSPACES_DIR"] = f"{_tmp}/workspaces"
# Dummy key so provider construction succeeds offline (no network call is made).
os.environ.setdefault("OPENROUTER_API_KEY", "test-key-not-used")

from app.db.session import init_db  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture
async def client():
    await init_db()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test/api") as c:
        yield c


async def test_health(client: AsyncClient):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


async def test_skill_and_tool_crud(client: AsyncClient):
    r = await client.post("/skills", json={"name": "Summarize", "content": "# how to"})
    assert r.status_code == 201
    skill = r.json()

    r = await client.post("/tools", json={"name": "search", "kind": "http"})
    assert r.status_code == 201
    tool = r.json()

    assert (await client.get("/skills")).json()[0]["id"] == skill["id"]
    assert (await client.get("/tools")).json()[0]["kind"] == "http"
    return skill, tool


async def test_agent_with_links_and_workspace_thread(client: AsyncClient):
    skill = (await client.post("/skills", json={"name": "S1"})).json()
    tool = (await client.post("/tools", json={"name": "T1"})).json()

    r = await client.post(
        "/agents",
        json={
            "name": "Builder",
            "instructions": "Be helpful",
            "thinking": "medium",
            "skill_ids": [skill["id"]],
            "tool_ids": [tool["id"]],
        },
    )
    assert r.status_code == 201, r.text
    agent = r.json()
    assert agent["skill_ids"] == [skill["id"]]
    assert agent["tool_ids"] == [tool["id"]]

    # Bad link id -> 400
    bad = await client.post("/agents", json={"name": "X", "skill_ids": ["nope"]})
    assert bad.status_code == 400

    # Workspace creation; a directory should be created.
    r = await client.post("/workspaces", json={"name": "My Space"})
    assert r.status_code == 201, r.text
    ws = r.json()
    assert os.path.isdir(ws["path"])

    # Thread + message listing.
    r = await client.post(
        "/threads", json={"workspace_id": ws["id"], "agent_id": agent["id"]}
    )
    assert r.status_code == 201, r.text
    thread = r.json()
    assert (await client.get(f"/threads/{thread['id']}/messages")).json() == []


async def test_thread_update_and_run_endpoints(client: AsyncClient):
    """PATCH swaps a thread's agent / renames it; run endpoints behave when idle."""
    a1 = (await client.post("/agents", json={"name": "A1"})).json()
    a2 = (await client.post("/agents", json={"name": "A2"})).json()
    ws = (await client.post("/workspaces", json={"name": "WS"})).json()
    thread = (
        await client.post(
            "/threads", json={"workspace_id": ws["id"], "agent_id": a1["id"]}
        )
    ).json()

    # Rename + swap the agent.
    r = await client.patch(
        f"/threads/{thread['id']}", json={"title": "Renamed", "agent_id": a2["id"]}
    )
    assert r.status_code == 200, r.text
    assert r.json()["title"] == "Renamed"
    assert r.json()["agent_id"] == a2["id"]

    # Unknown agent -> 400; unknown thread -> 404.
    assert (
        await client.patch(f"/threads/{thread['id']}", json={"agent_id": "nope"})
    ).status_code == 400
    assert (await client.patch("/threads/nope", json={"title": "x"})).status_code == 404

    # active-runs must resolve to the literal route (not {thread_id}) and be empty.
    r = await client.get("/threads/active-runs")
    assert r.status_code == 200, r.text
    assert r.json() == []

    # Stopping a thread with no live run is a 404.
    assert (await client.post(f"/threads/{thread['id']}/stop")).status_code == 404

    # A plain chat thread can be promoted to a goal ("plan") thread mid-life so
    # Plan can be entered at any time (see workspace-chat-page handleStartGoal).
    assert thread["mode"] == "chat"
    r = await client.patch(
        f"/threads/{thread['id']}",
        json={
            "mode": "goal",
            "goal": "ship the feature",
            "success_criteria": "tests pass",
            "max_iterations": 10,
            "require_plan_approval": True,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mode"] == "goal"
    assert body["goal"] == "ship the feature"
    assert body["success_criteria"] == "tests pass"
    assert body["max_iterations"] == 10


async def test_pick_folder_and_custom_path(client: AsyncClient, monkeypatch):
    """The pick-folder endpoint returns the native dialog's choice, and a custom
    path is honored (and created) when a workspace is made."""
    import subprocess
    from types import SimpleNamespace

    chosen = f"{_tmp}/picked-workspace"

    def fake_run(cmd, **kwargs):  # noqa: ANN001
        return SimpleNamespace(returncode=0, stdout=f"{chosen}/\n", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr("shutil.which", lambda _cmd: "/usr/bin/dialog")

    r = await client.post("/workspaces/pick-folder")
    assert r.status_code == 200, r.text
    assert r.json()["path"] == chosen  # trailing slash stripped

    r = await client.post("/workspaces", json={"name": "Custom", "path": chosen})
    assert r.status_code == 201, r.text
    ws = r.json()
    assert ws["path"] == chosen
    assert os.path.isdir(chosen)


async def test_pick_folder_cancelled(client: AsyncClient, monkeypatch):
    """A cancelled dialog (non-zero exit / empty output) yields a null path."""
    import subprocess
    from types import SimpleNamespace

    monkeypatch.setattr(
        subprocess, "run", lambda cmd, **kw: SimpleNamespace(returncode=1, stdout="", stderr="")
    )
    monkeypatch.setattr("shutil.which", lambda _cmd: "/usr/bin/dialog")

    r = await client.post("/workspaces/pick-folder")
    assert r.status_code == 200, r.text
    assert r.json()["path"] is None


async def test_build_deep_agent_offline(client: AsyncClient):
    """The builder should construct a pydantic-ai Agent without hitting the network."""
    from app.agents.builder import build_deep_agent
    from app.db.models import Agent as AgentRow

    row = AgentRow(name="local", instructions="hi", model="openrouter:qwen/qwen3.7-max")
    row.skills = []
    agent, deps = build_deep_agent(row, _tmp)
    assert agent is not None
    assert deps is not None


async def test_build_deep_agent_read_only_allowlists_tools(client: AsyncClient):
    """Ask mode (read_only) exposes ONLY read-safe tools to the model.

    Guards against the whole class of write paths — not just write_file/edit, but
    subagent delegation (`task`) and shell/script execution — by driving a real
    agent run through a FunctionModel and asserting on the tools it is offered.
    """
    from app.agents.builder import (
        _READONLY_TOOL_ALLOWLIST,
        _readonly_tool_filter,
        build_deep_agent,
    )
    from app.db.models import Agent as AgentRow
    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.models.function import AgentInfo, FunctionModel

    row = AgentRow(name="local", instructions="hi", model="openrouter:qwen/qwen3.7-max")
    row.skills = []
    row.include_subagents = True  # ensure the `task` delegation tool is present

    # The pure filter keeps only allowlisted names.
    class _Def:
        def __init__(self, name):
            self.name = name

    kept = {
        d.name
        for d in _readonly_tool_filter(
            None, [_Def(n) for n in ["ls", "read_file", "write_file", "task", "execute"]]
        )
    }
    assert kept == {"ls", "read_file"}

    # End-to-end: the tools the model actually sees in read_only mode must be a
    # subset of the allowlist and must not include any write/exec/delegate tool.
    seen: dict[str, list[str]] = {}

    def _capture(_messages, info: AgentInfo):
        seen["tools"] = [t.name for t in info.function_tools]
        return ModelResponse(parts=[TextPart("ok")])

    agent, deps = build_deep_agent(row, _tmp, read_only=True)
    with agent.override(model=FunctionModel(_capture)):
        await agent.run("hi", deps=deps)

    tools = set(seen["tools"])
    assert tools <= _READONLY_TOOL_ALLOWLIST, f"leaked: {tools - _READONLY_TOOL_ALLOWLIST}"
    forbidden = {
        "task",
        "write_file",
        "edit_file",
        "hashline_edit",
        "execute",
        "run_in_background",
        "run_skill_script",
        "send_message_to_subagent",
    }
    assert not (tools & forbidden), f"read-only agent exposed write paths: {tools & forbidden}"


async def test_prompt_template_crud_and_builtin_protection(client: AsyncClient):
    """User templates are full CRUD; built-ins are read-only (403 on edit/delete)."""
    # Create a user template.
    r = await client.post(
        "/prompt-templates",
        json={
            "name": "My template",
            "description": "d",
            "category": "coding",
            "content": "You are...",
        },
    )
    assert r.status_code == 201, r.text
    tmpl = r.json()
    assert tmpl["is_builtin"] is False
    assert tmpl["category"] == "coding"

    # Update + delete work for user templates.
    r = await client.patch(f"/prompt-templates/{tmpl['id']}", json={"name": "Renamed"})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Renamed"

    # A built-in row is read-only: seed one directly and confirm 403s.
    from app.db.models import PromptTemplate
    from app.db.session import async_session_factory

    async with async_session_factory() as session:
        builtin = PromptTemplate(name="Builtin", content="x", is_builtin=True)
        session.add(builtin)
        await session.commit()
        await session.refresh(builtin)
        builtin_id = builtin.id

    assert (
        await client.patch(f"/prompt-templates/{builtin_id}", json={"name": "z"})
    ).status_code == 403
    assert (await client.delete(f"/prompt-templates/{builtin_id}")).status_code == 403

    # User template still deletable.
    assert (await client.delete(f"/prompt-templates/{tmpl['id']}")).status_code == 204


async def test_prompt_generation_validation(client: AsyncClient):
    """Generate/improve reject empty input before any model call."""
    assert (
        await client.post("/agents/prompt/generate", json={"brief": "   "})
    ).status_code == 400
    assert (
        await client.post("/agents/prompt/improve", json={"current": ""})
    ).status_code == 400
