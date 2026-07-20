"""End-to-end CRUD tests exercising the ASGI app against a temp SQLite DB."""

from __future__ import annotations

import os

import pytest
from httpx import AsyncClient

# DB / workspace isolation and the ``client`` fixture live in ``conftest.py``.


async def test_health(client: AsyncClient):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


async def test_skill_and_tool_crud(client: AsyncClient):
    r = await client.post("/skills", json={"name": "Summarize", "content": "# how to"})
    assert r.status_code == 201
    skill = r.json()
    # Skills are stored as standard folders: a slug is assigned and content is
    # sourced from the on-disk SKILL.md.
    assert skill["slug"] == "summarize"
    assert skill["content"] == "# how to"
    assert skill["resources"] == [] and skill["scripts"] == []

    r = await client.post("/tools", json={"name": "search", "kind": "http"})
    assert r.status_code == 201
    tool = r.json()

    assert (await client.get("/skills")).json()[0]["id"] == skill["id"]
    assert (await client.get("/tools")).json()[0]["kind"] == "http"
    return skill, tool


async def test_workspace_scoped_skills_and_precedence(client: AsyncClient):
    """Skills come from two scopes; the workspace copy wins on slug collision.

    Exercises the whole path the builder relies on: a workspace-scoped skill is
    written under ``<workspace>/.agents/skills/`` and ``merged_skill_dirs`` returns
    global + workspace dirs with the workspace winning when slugs collide.
    """
    import os

    from app.skills import store

    ws = (await client.post("/workspaces", json={"name": "Scoped"})).json()

    # A global skill and a workspace skill that share the slug "shared".
    g = (
        await client.post("/skills", json={"name": "shared", "content": "GLOBAL"})
    ).json()
    assert g["scope"] == "global"
    w = (
        await client.post(
            "/skills",
            json={
                "name": "shared",
                "content": "WORKSPACE",
                "scope": "workspace",
                "workspace_id": ws["id"],
            },
        )
    ).json()
    assert w["scope"] == "workspace" and w["workspace_id"] == ws["id"]

    # The workspace skill landed under <workspace>/.agents/skills/shared/.
    ws_skill_md = os.path.join(ws["path"], ".agents", "skills", "shared", "SKILL.md")
    assert os.path.isfile(ws_skill_md)

    # A workspace skill requires a workspace_id.
    bad = await client.post(
        "/skills", json={"name": "x", "scope": "workspace"}
    )
    assert bad.status_code == 400

    # Filtering by scope works.
    ws_list = (
        await client.get("/skills", params={"scope": "workspace", "workspace_id": ws["id"]})
    ).json()
    assert [s["id"] for s in ws_list] == [w["id"]]

    # Precedence: merged dirs include both slugs' folders, workspace winning on
    # the colliding "shared" slug.
    dirs = store.merged_skill_dirs(ws["path"])
    shared = [d for d in dirs if d.rstrip("/").endswith("/shared")]
    assert len(shared) == 1
    ws_root = os.path.realpath(os.path.join(ws["path"], ".agents", "skills"))
    assert os.path.realpath(shared[0]).startswith(ws_root)


async def test_skill_bundled_resources(client: AsyncClient):
    """A skill supports the full standard: bundled resource files and scripts."""
    skill = (
        await client.post("/skills", json={"name": "PDF Tools", "content": "body"})
    ).json()
    sid = skill["id"]

    # Write a resource and a script into the skill folder.
    assert (
        await client.put(
            f"/skills/{sid}/files/references/FORMS.md",
            json={"content": "# Forms"},
        )
    ).status_code == 200
    r = await client.put(
        f"/skills/{sid}/files/scripts/fill.py", json={"content": "print('hi')"}
    )
    assert r.status_code == 200
    updated = r.json()
    assert "references/FORMS.md" in updated["resources"]
    assert "scripts/fill.py" in updated["scripts"]

    # Read it back.
    got = await client.get(f"/skills/{sid}/files/references/FORMS.md")
    assert got.status_code == 200 and got.json()["content"] == "# Forms"

    # Path traversal is rejected at the store layer (URLs normalize `..` away).
    from app.skills import store

    with pytest.raises(ValueError):
        store.write_file(skill["slug"], store.global_skills_root(), "../escape.md", "x")

    # Deleting the skill removes the folder and its bundled files.
    assert (await client.delete(f"/skills/{sid}")).status_code == 204
    assert (await client.get(f"/skills/{sid}")).status_code == 404


async def test_import_skill_from_zip(client: AsyncClient):
    """A standard skill archive (SKILL.md + resources/scripts) imports intact."""
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "pdf-tools/SKILL.md",
            "---\nname: PDF Tools\ndescription: work with pdfs\n---\n\nDo the thing.",
        )
        zf.writestr("pdf-tools/references/FORMS.md", "# Forms")
        zf.writestr("pdf-tools/scripts/fill.py", "print('hi')")
    buf.seek(0)

    r = await client.post(
        "/skills/import",
        files={"files": ("pdf-tools.zip", buf.read(), "application/zip")},
    )
    assert r.status_code == 201, r.text
    created = r.json()
    assert len(created) == 1
    skill = created[0]
    assert skill["slug"] == "pdf-tools"
    assert skill["description"] == "work with pdfs"
    assert "references/FORMS.md" in skill["resources"]
    assert "scripts/fill.py" in skill["scripts"]

    # It shows up in the list and is attachable like any other skill.
    listed = {s["id"] for s in (await client.get("/skills")).json()}
    assert skill["id"] in listed


async def test_import_skill_from_markdown(client: AsyncClient):
    """A lone SKILL.md / .md document imports as a skill."""
    doc = b"---\nname: Terse\ndescription: be brief\n---\n\nLead with the answer."
    r = await client.post(
        "/skills/import",
        files={"files": ("SKILL.md", doc, "text/markdown")},
    )
    assert r.status_code == 201, r.text
    skill = r.json()[0]
    assert skill["slug"] == "terse"
    assert skill["content"] == "Lead with the answer."

    # A non-skill file type is rejected.
    bad = await client.post(
        "/skills/import", files={"files": ("art.png", b"\x89PNG", "image/png")}
    )
    assert bad.status_code == 400


async def test_import_skill_from_folder(client: AsyncClient):
    """A folder upload (files carrying relative paths) rebuilds the skill tree."""
    r = await client.post(
        "/skills/import",
        files=[
            (
                "files",
                (
                    "my-skill/SKILL.md",
                    b"---\nname: My Skill\ndescription: folder import\n---\n\nBody.",
                    "text/markdown",
                ),
            ),
            (
                "files",
                ("my-skill/references/NOTES.md", b"# Notes", "text/markdown"),
            ),
            (
                "files",
                ("my-skill/scripts/run.py", b"print('go')", "text/x-python"),
            ),
        ],
    )
    assert r.status_code == 201, r.text
    created = r.json()
    assert len(created) == 1
    skill = created[0]
    assert skill["slug"] == "my-skill"
    assert skill["description"] == "folder import"
    assert "references/NOTES.md" in skill["resources"]
    assert "scripts/run.py" in skill["scripts"]

    # A folder with no SKILL.md is rejected.
    bad = await client.post(
        "/skills/import",
        files=[("files", ("notes/readme.txt", b"hi", "text/plain"))],
    )
    assert bad.status_code == 400


async def test_agent_with_links_and_workspace_thread(client: AsyncClient):
    # Skills are global (scope-discovered), not linked to agents; agents only link
    # tools now.
    skill = (await client.post("/skills", json={"name": "S1"})).json()
    assert skill["scope"] == "global" and skill["workspace_id"] is None
    tool = (await client.post("/tools", json={"name": "T1"})).json()

    r = await client.post(
        "/agents",
        json={
            "name": "Builder",
            "instructions": "Be helpful",
            "thinking": "medium",
            "tool_ids": [tool["id"]],
        },
    )
    assert r.status_code == 201, r.text
    agent = r.json()
    assert "skill_ids" not in agent
    assert agent["tool_ids"] == [tool["id"]]

    # Bad tool link id -> 400
    bad = await client.post("/agents", json={"name": "X", "tool_ids": ["nope"]})
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

    # A plain chat thread can be promoted to a goal thread mid-life so a goal
    # can be entered at any time (see workspace-chat-page enterMode).
    assert thread["mode"] == "chat"
    r = await client.patch(
        f"/threads/{thread['id']}",
        json={
            "mode": "goal",
            "goal": "ship the feature",
            "success_criteria": "tests pass",
            "max_iterations": 10,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mode"] == "goal"
    assert body["goal"] == "ship the feature"
    assert body["success_criteria"] == "tests pass"
    assert body["max_iterations"] == 10


async def test_pick_folder_and_custom_path(client: AsyncClient, monkeypatch, tmp_path):
    """The pick-folder endpoint returns the native dialog's choice, and a custom
    path is honored (and created) when a workspace is made."""
    import subprocess
    from types import SimpleNamespace

    chosen = f"{tmp_path}/picked-workspace"

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


async def test_build_deep_agent_offline(client: AsyncClient, tmp_path):
    """The builder should construct a pydantic-ai Agent without hitting the network."""
    from app.agents.builder import build_deep_agent
    from app.db.models import Agent as AgentRow

    row = AgentRow(name="local", instructions="hi", model="openrouter:qwen/qwen3.7-max")
    agent, deps = build_deep_agent(row, str(tmp_path))
    assert agent is not None
    assert deps is not None


async def test_build_deep_agent_injects_environment_block(client: AsyncClient, tmp_path):
    """The agent's instructions must state its workspace name and filesystem root.

    Without this anchor the model never learns which directory it is rooted in
    (`ls` prints only relative names), so it guesses absolute paths and gets lost.
    """
    from app.agents.builder import build_deep_agent
    from app.db.models import Agent as AgentRow
    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.models.function import AgentInfo, FunctionModel

    row = AgentRow(name="local", instructions="hi", model="openrouter:qwen/qwen3.7-max")

    seen: dict[str, str] = {}

    def _capture(messages, _info: AgentInfo):
        for m in messages:
            if getattr(m, "instructions", None):
                seen["instructions"] = m.instructions
        return ModelResponse(parts=[TextPart("ok")])

    agent, deps = build_deep_agent(
        row,
        str(tmp_path),
        workspace_name="my-project",
        workspace_description="a demo workspace",
    )
    with agent.override(model=FunctionModel(_capture)):
        await agent.run("hi", deps=deps)

    instructions = seen["instructions"]
    assert "# Environment" in instructions
    assert "my-project" in instructions
    assert "a demo workspace" in instructions
    assert str(tmp_path) in instructions


async def test_build_deep_agent_read_only_allowlists_tools(client: AsyncClient, tmp_path):
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

    agent, deps = build_deep_agent(row, str(tmp_path), read_only=True)
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


async def test_file_upload_into_folder(client: AsyncClient):
    """Uploading files lands raw bytes in the target folder, binary intact."""
    ws = (await client.post("/workspaces", json={"name": "Uploads"})).json()
    wid = ws["id"]

    # Two files into a subfolder: a text file and a binary one with a NUL byte.
    png_bytes = b"\x89PNG\r\n\x00\x01logo"
    r = await client.post(
        f"/workspaces/{wid}/files/upload",
        data={"path": "assets"},
        files=[
            ("files", ("notes.txt", b"hello world", "text/plain")),
            ("files", ("logo.png", png_bytes, "image/png")),
        ],
    )
    assert r.status_code == 201
    created = {e["path"] for e in r.json()}
    assert created == {"assets/notes.txt", "assets/logo.png"}

    # The folder is now listed and the binary round-trips byte-for-byte.
    listed = (
        await client.get(f"/workspaces/{wid}/files/list", params={"path": "assets"})
    ).json()
    assert {e["name"] for e in listed} == {"notes.txt", "logo.png"}
    raw = await client.get(
        f"/workspaces/{wid}/files/raw", params={"path": "assets/logo.png"}
    )
    assert raw.content == png_bytes


async def test_file_upload_rejects_traversal(client: AsyncClient):
    """A filename that climbs out of the workspace root is refused."""
    ws = (await client.post("/workspaces", json={"name": "Escape"})).json()
    r = await client.post(
        f"/workspaces/{ws['id']}/files/upload",
        data={"path": ""},
        files=[("files", ("../escape.txt", b"nope", "text/plain"))],
    )
    assert r.status_code == 400
