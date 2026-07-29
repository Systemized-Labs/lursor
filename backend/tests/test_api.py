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


async def test_skill_layers_and_precedence(client: AsyncClient):
    """Three layers resolve for a workspace, closest one winning on slug collision.

    Exercises the path the builder relies on: a globally-assigned catalog skill, a
    local skill committed into the repo under ``<workspace>/.agents/skills/``, and
    ``skills_in_scope`` returning both with the local copy winning the collision.
    """
    import os

    from app.db.session import async_session_factory
    from app.skills.resolve import skills_in_scope

    ws = (await client.post("/workspaces", json={"name": "Scoped"})).json()

    # A catalog skill (global by default) and a local one sharing the slug "shared".
    g = (
        await client.post("/skills", json={"name": "shared", "content": "GLOBAL"})
    ).json()
    assert g["origin"] == "managed" and g["is_global"] is True
    w = (
        await client.post(
            "/skills",
            json={
                "name": "shared",
                "content": "WORKSPACE",
                "origin": "local",
                "workspace_id": ws["id"],
            },
        )
    ).json()
    assert w["origin"] == "local" and w["workspace_id"] == ws["id"]

    # The local skill landed under <workspace>/.agents/skills/shared/.
    ws_skill_md = os.path.join(ws["path"], ".agents", "skills", "shared", "SKILL.md")
    assert os.path.isfile(ws_skill_md)

    # A local skill requires a workspace_id.
    bad = await client.post("/skills", json={"name": "x", "origin": "local"})
    assert bad.status_code == 400

    # Filtering to a workspace returns what is in scope there, tagged by layer.
    ws_list = (
        await client.get(
            "/skills", params={"assignment": "workspace", "workspace_id": ws["id"]}
        )
    ).json()
    shared_rows = [s for s in ws_list if s["slug"] == "shared"]
    # One winner for the colliding slug, and it is the repo-local copy.
    assert [s["id"] for s in shared_rows] == [w["id"]]
    assert shared_rows[0]["layer"] == "local"

    # Precedence at the resolution layer the builder calls.
    async with async_session_factory() as session:
        scoped = await skills_in_scope(
            session, workspace_path=ws["path"], workspace_id=ws["id"]
        )
    shared_scoped = [s for s in scoped if s.slug == "shared"]
    assert [(s.slug, s.layer) for s in shared_scoped] == [("shared", "local")]
    ws_root = os.path.realpath(os.path.join(ws["path"], ".agents", "skills"))
    assert os.path.realpath(str(shared_scoped[0].folder)).startswith(ws_root)


async def test_skill_reassignment(client: AsyncClient):
    """A catalog skill can be re-pointed at many workspaces, global, or nowhere."""
    a = (await client.post("/workspaces", json={"name": "A"})).json()
    b = (await client.post("/workspaces", json={"name": "B"})).json()
    skill = (
        await client.post(
            "/skills",
            json={"name": "Shared Helper", "content": "body", "is_global": False},
        )
    ).json()
    # No assignment given and is_global explicitly false: parked.
    assert skill["is_global"] is False and skill["workspace_ids"] == []
    parked = (await client.get("/skills", params={"assignment": "unassigned"})).json()
    assert skill["id"] in [s["id"] for s in parked]

    # Assign to two workspaces at once.
    r = await client.put(
        f"/skills/{skill['id']}/assignment",
        json={"is_global": False, "workspace_ids": [a["id"], b["id"]]},
    )
    assert r.status_code == 200
    assert sorted(r.json()["workspace_ids"]) == sorted([a["id"], b["id"]])
    for ws in (a, b):
        in_scope = (
            await client.get(
                "/skills", params={"assignment": "workspace", "workspace_id": ws["id"]}
            )
        ).json()
        mine = [s for s in in_scope if s["id"] == skill["id"]]
        assert [s["layer"] for s in mine] == ["workspace"]

    # Going global clears the per-workspace links (one unambiguous state).
    r = await client.put(
        f"/skills/{skill['id']}/assignment",
        json={"is_global": True, "workspace_ids": [a["id"]]},
    )
    assert r.json()["is_global"] is True and r.json()["workspace_ids"] == []

    # Back to nothing.
    r = await client.put(
        f"/skills/{skill['id']}/assignment", json={"is_global": False}
    )
    assert r.json()["is_global"] is False and r.json()["workspace_ids"] == []
    in_scope = (
        await client.get(
            "/skills", params={"assignment": "workspace", "workspace_id": a["id"]}
        )
    ).json()
    assert skill["id"] not in [s["id"] for s in in_scope]


async def test_local_skill_promote(client: AsyncClient):
    """A repo-local skill can't be assigned until promoted into the catalog."""
    import os

    ws = (await client.post("/workspaces", json={"name": "Repo"})).json()
    other = (await client.post("/workspaces", json={"name": "Other"})).json()
    local = (
        await client.post(
            "/skills",
            json={
                "name": "Repo Skill",
                "content": "body",
                "origin": "local",
                "workspace_id": ws["id"],
            },
        )
    ).json()

    # Assignment is refused while it lives in the repo.
    r = await client.put(
        f"/skills/{local['id']}/assignment",
        json={"is_global": False, "workspace_ids": [other["id"]]},
    )
    assert r.status_code == 409

    promoted = (await client.post(f"/skills/{local['id']}/promote")).json()
    assert promoted["origin"] == "managed"
    # Reach is unchanged by the promote itself: still just its own workspace.
    assert promoted["workspace_ids"] == [ws["id"]]
    # The folder moved out of the repo and into the catalog.
    assert not os.path.exists(
        os.path.join(ws["path"], ".agents", "skills", local["slug"])
    )
    # Now it can be assigned elsewhere.
    r = await client.put(
        f"/skills/{promoted['id']}/assignment",
        json={"is_global": False, "workspace_ids": [other["id"]]},
    )
    assert r.status_code == 200 and r.json()["workspace_ids"] == [other["id"]]


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
        store.write_file(skill["slug"], store.catalog_root(), "../escape.md", "x")

    # Deleting the skill removes the folder and its bundled files.
    assert (await client.delete(f"/skills/{sid}")).status_code == 204
    assert (await client.get(f"/skills/{sid}")).status_code == 404


async def test_skill_md_edited_as_a_file(client: AsyncClient):
    """SKILL.md round-trips through the file endpoints, frontmatter and all.

    The editor shows the real file, so keys the UI doesn't model have to survive a
    save — and the name/description it *does* model must follow the frontmatter.
    """
    skill = (
        await client.post(
            "/skills", json={"name": "Grill", "description": "old", "content": "body"}
        )
    ).json()
    sid = skill["id"]

    raw = (await client.get(f"/skills/{sid}/files/SKILL.md")).json()["content"]
    assert "name: Grill" in raw and "body" in raw

    edited = (
        "---\nname: Grill Deeply\ndescription: sharper\nlicense: MIT\n"
        "allowed-tools: read_file\n---\n\n# Grill\nAsk hard questions.\n"
    )
    r = await client.put(f"/skills/{sid}/files/SKILL.md", json={"content": edited})
    assert r.status_code == 200
    # The index follows the frontmatter immediately, without waiting for a list.
    assert r.json()["name"] == "Grill Deeply"
    assert r.json()["description"] == "sharper"
    assert "Ask hard questions." in r.json()["content"]

    # Unmodelled frontmatter keys are still on disk after the round-trip.
    back = (await client.get(f"/skills/{sid}/files/SKILL.md")).json()["content"]
    assert "license: MIT" in back and "allowed-tools: read_file" in back

    # But it can't be deleted out from under the skill.
    r = await client.delete(f"/skills/{sid}/files/SKILL.md")
    assert r.status_code == 400 and "delete the skill" in r.json()["detail"]


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
    # Skills carry an assignment (global by default) rather than being linked to
    # agents; agents only link tools now.
    skill = (await client.post("/skills", json={"name": "S1"})).json()
    assert skill["is_global"] is True and skill["workspace_id"] is None
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
    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.models.function import AgentInfo, FunctionModel

    from app.agents.builder import build_deep_agent
    from app.db.models import Agent as AgentRow

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
    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.models.function import AgentInfo, FunctionModel

    from app.agents.builder import (
        _READONLY_TOOL_ALLOWLIST,
        _readonly_tool_filter,
        build_deep_agent,
    )
    from app.db.models import Agent as AgentRow

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


async def test_build_deep_agent_plan_mode_keeps_full_toolset(client: AsyncClient, tmp_path):
    """Plan mode does NOT gate tools — the planning prompt is the only guard.

    Plan mode used to run its own allowlist (reads + ``write_file``), but gating
    the toolset starved the planning loop: without the todo board and delegation,
    local reasoning models answered in prose and never wrote the plan doc. So a
    plan turn now sees the same tools as a normal build turn; ``goal_loop``'s
    planning instruction ("do NOT execute yet") is what keeps it to planning.
    """
    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.models.function import AgentInfo, FunctionModel

    from app.agents.builder import build_deep_agent
    from app.db.models import Agent as AgentRow

    row = AgentRow(name="local", instructions="hi", model="openrouter:qwen/qwen3.7-max")
    row.include_subagents = True  # ensure the `task` delegation tool is present

    seen: dict[str, list[str]] = {}

    def _capture(_messages, info: AgentInfo):
        seen["tools"] = [t.name for t in info.function_tools]
        return ModelResponse(parts=[TextPart("ok")])

    # No workspace_id in either build, so browser QA is off on both sides and the
    # only difference under test is the (now absent) plan-mode tool filter.
    agent, deps = build_deep_agent(row, str(tmp_path), plan_mode=True)
    with agent.override(model=FunctionModel(_capture)):
        await agent.run("hi", deps=deps)
    plan_tools = set(seen["tools"])

    agent, deps = build_deep_agent(row, str(tmp_path))
    with agent.override(model=FunctionModel(_capture)):
        await agent.run("hi", deps=deps)
    build_tools = set(seen["tools"])

    assert plan_tools == build_tools, (
        "plan mode must not filter tools: "
        f"missing {build_tools - plan_tools}, extra {plan_tools - build_tools}"
    )
    # The tools the planning loop actually needs, spelled out so a future filter
    # can't quietly take them away again.
    for needed in ("write_file", "write_todos", "task"):
        assert needed in plan_tools, f"plan mode lost {needed}"


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


async def test_file_tree_exposes_plans_but_hides_rest_of_agents(client: AsyncClient):
    """`.agents/plan/` is browsable in the tree; the rest of `.agents/` stays hidden."""
    ws = (await client.post("/workspaces", json={"name": "PlanTree"})).json()
    wid = ws["id"]

    # A plan doc, a skill file, and an ordinary source file.
    for path in (
        ".agents/plan/PLAN-refactor.md",
        ".agents/skills/note/SKILL.md",
        "src/main.py",
    ):
        r = await client.put(
            f"/workspaces/{wid}/files/write", json={"path": path, "content": "x"}
        )
        assert r.status_code == 200, r.text

    # Root: `.agents` is now visible (alongside real source), unlike other noise.
    root = (await client.get(f"/workspaces/{wid}/files/list")).json()
    names = {e["name"] for e in root}
    assert ".agents" in names
    assert "src" in names

    # Inside `.agents`: only the plan folder shows; skills stay hidden.
    agents = (
        await client.get(f"/workspaces/{wid}/files/list", params={"path": ".agents"})
    ).json()
    assert {e["name"] for e in agents} == {"plan"}

    # Inside `.agents/plan`: the plan doc is listed and readable.
    plans = (
        await client.get(
            f"/workspaces/{wid}/files/list", params={"path": ".agents/plan"}
        )
    ).json()
    assert {e["name"] for e in plans} == {"PLAN-refactor.md"}
    read = await client.get(
        f"/workspaces/{wid}/files/read", params={"path": ".agents/plan/PLAN-refactor.md"}
    )
    assert read.status_code == 200 and read.json()["content"] == "x"


async def test_file_upload_rejects_traversal(client: AsyncClient):
    """A filename that climbs out of the workspace root is refused."""
    ws = (await client.post("/workspaces", json={"name": "Escape"})).json()
    r = await client.post(
        f"/workspaces/{ws['id']}/files/upload",
        data={"path": ""},
        files=[("files", ("../escape.txt", b"nope", "text/plain"))],
    )
    assert r.status_code == 400
