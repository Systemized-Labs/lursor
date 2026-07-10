"""End-to-end CRUD tests exercising the ASGI app against a temp SQLite DB."""

from __future__ import annotations

import os
import tempfile

import pytest
from httpx import ASGITransport, AsyncClient

# Point the app at throwaway DB + workspace dirs before importing it.
_tmp = tempfile.mkdtemp(prefix="hearthstack-test-")
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

    # Workspace with the agent attached; a directory should be created.
    r = await client.post(
        "/workspaces", json={"name": "My Space", "agent_ids": [agent["id"]]}
    )
    assert r.status_code == 201, r.text
    ws = r.json()
    assert ws["agent_ids"] == [agent["id"]]
    assert os.path.isdir(ws["path"])

    # Thread + message listing.
    r = await client.post(
        "/threads", json={"workspace_id": ws["id"], "agent_id": agent["id"]}
    )
    assert r.status_code == 201, r.text
    thread = r.json()
    assert (await client.get(f"/threads/{thread['id']}/messages")).json() == []


async def test_build_deep_agent_offline(client: AsyncClient):
    """The builder should construct a pydantic-ai Agent without hitting the network."""
    from app.agents.builder import build_deep_agent
    from app.db.models import Agent as AgentRow

    row = AgentRow(name="local", instructions="hi", model="openrouter:qwen/qwen3.7-max")
    row.skills = []
    agent, deps = build_deep_agent(row, _tmp)
    assert agent is not None
    assert deps is not None
