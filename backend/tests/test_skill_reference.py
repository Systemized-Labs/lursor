"""Unit tests for @-referenced skill force-loading (chat composer `@skill`).

Covers ``app.api.chat._referenced_skill_instructions``: the helper that turns the
slugs a user @-references in the composer into a per-turn instruction block, with
workspace-over-global precedence and safe handling of client-supplied slugs.
"""

from __future__ import annotations

import json

from ag_ui.core import RunAgentInput, UserMessage
from httpx import AsyncClient
from pydantic_ai.models.test import TestModel
from pydantic_ai_backends import LocalBackend
from pydantic_deep import create_deep_agent, create_default_deps

from app.api.chat import _referenced_skill_instructions
from app.skills import store

# DB / workspace isolation and temp SKILLS_DIR live in ``conftest.py``.


def _write_global(slug: str, *, name: str, content: str) -> None:
    store.write_skill(
        slug, store.global_skills_root(), name=name, description="", content=content
    )


def _write_workspace(ws: str, slug: str, *, name: str, content: str) -> None:
    store.write_skill(
        slug,
        store.workspace_skills_root(ws),
        name=name,
        description="",
        content=content,
    )


def test_none_when_no_slugs(tmp_path):
    assert _referenced_skill_instructions([], str(tmp_path)) is None


def test_loads_global_skill_body(tmp_path):
    _write_global("summarize", name="Summarize", content="Lead with the answer.")
    out = _referenced_skill_instructions(["summarize"], str(tmp_path))
    assert out is not None
    assert "referenced the following skill" in out
    assert "## Summarize" in out
    assert "Lead with the answer." in out


def test_workspace_wins_slug_collision(tmp_path):
    ws = str(tmp_path)
    _write_global("shared", name="Shared", content="GLOBAL BODY")
    _write_workspace(ws, "shared", name="Shared", content="WORKSPACE BODY")
    out = _referenced_skill_instructions(["shared"], ws) or ""
    assert "WORKSPACE BODY" in out
    assert "GLOBAL BODY" not in out


def test_unknown_slug_skipped(tmp_path):
    _write_global("real", name="Real", content="body")
    # Only an unknown slug → nothing to inject.
    assert _referenced_skill_instructions(["nope"], str(tmp_path)) is None
    # Mixed: the known one still loads, the unknown is dropped.
    out = _referenced_skill_instructions(["nope", "real"], str(tmp_path)) or ""
    assert "body" in out


def test_malformed_slug_is_safe(tmp_path):
    # Client-supplied slugs could attempt traversal; must not raise or escape.
    _write_global("real", name="Real", content="body")
    out = _referenced_skill_instructions(["../../etc/passwd", "real"], str(tmp_path))
    assert out is not None and "body" in out


def test_duplicate_slugs_loaded_once(tmp_path):
    _write_global("dup", name="Dup", content="ONCE")
    out = _referenced_skill_instructions(["dup", "dup"], str(tmp_path)) or ""
    assert out.count("## Dup") == 1


# --- End-to-end: the referenced skill body reaches the turn's instructions ------


def _fake_deep_agent(row, workspace_path, *args, **kwargs):
    """Minimal offline deep agent (TestModel, no tools) — mirrors test_goal_chat."""
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


async def _drain(client: AsyncClient, thread_id: str, body: str) -> None:
    async with client.stream(
        "POST",
        f"/threads/{thread_id}/chat",
        content=body,
        headers={"accept": "text/event-stream", "content-type": "application/json"},
    ) as resp:
        assert resp.status_code == 200, await resp.aread()
        async for _line in resp.aiter_lines():
            pass


async def test_at_referenced_skill_force_loaded_into_turn(
    client: AsyncClient, monkeypatch
):
    """POSTing a chat turn with forwardedProps.skills injects that skill's full
    body into the run-scoped instructions the agent turn receives."""
    monkeypatch.setattr("app.api.chat.build_deep_agent", _fake_deep_agent)

    from app.api import chat as chat_mod

    real_stream_turn = chat_mod._stream_turn
    captured: list[str | None] = []

    async def spy_stream_turn(*args, **kwargs):
        captured.append(kwargs.get("instructions"))
        return await real_stream_turn(*args, **kwargs)

    monkeypatch.setattr("app.api.chat._stream_turn", spy_stream_turn)

    agent = (await client.post("/agents", json={"name": "Ref"})).json()
    ws = (await client.post("/workspaces", json={"name": "RefWS"})).json()
    # A workspace-scoped skill the user will @-reference.
    await client.post(
        "/skills",
        json={
            "name": "House Style",
            "content": "ALWAYS write in the second person.",
            "scope": "workspace",
            "workspace_id": ws["id"],
        },
    )
    thread = (
        await client.post(
            "/threads", json={"workspace_id": ws["id"], "agent_id": agent["id"]}
        )
    ).json()

    body = RunAgentInput(
        thread_id=thread["id"],
        run_id="r1",
        state=None,
        messages=[UserMessage(id="m1", role="user", content="write it @house-style")],
        tools=[],
        context=[],
        forwarded_props={"turn": "chat", "skills": ["house-style"]},
    ).model_dump_json(by_alias=True)

    await _drain(client, thread["id"], body)

    assert captured, "the turn never ran"
    joined = captured[-1] or ""
    assert "House Style" in joined
    assert "ALWAYS write in the second person." in joined
    assert "referenced the following skill" in joined

    # Control: a turn with no @reference gets no skill block.
    captured.clear()
    body2 = RunAgentInput(
        thread_id=thread["id"],
        run_id="r2",
        state=None,
        messages=[UserMessage(id="m2", role="user", content="plain message")],
        tools=[],
        context=[],
        forwarded_props={"turn": "chat"},
    ).model_dump_json(by_alias=True)
    await _drain(client, thread["id"], body2)
    assert "second person" not in (captured[-1] or "")
