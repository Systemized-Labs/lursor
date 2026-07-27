"""The skills catalog is registered as an ordinary — but guarded — workspace.

Pointing the existing chat + dock surface at ``~/.lursor/skills`` is the whole
feature: no new agent, no new panels. What has to hold is that the row exists
exactly once, that it can't be deleted or relocated out from under the app, and
that a skill the agent writes into the catalog shows up in the manager waiting
to be assigned.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlmodel import select

from app.api.workspaces import SKILLS_WORKSPACE_NAME, ensure_skills_workspace
from app.config import get_settings
from app.db.models import Workspace
from app.db.session import async_session_factory, init_db
from app.schemas.workspace import WorkspaceRead

settings = get_settings()


async def _catalog_rows() -> list[Workspace]:
    """Every workspace row pointing at the skills catalog."""
    async with async_session_factory() as session:
        result = await session.execute(select(Workspace))
        return [
            w
            for w in result.scalars().all()
            if w.path == str(settings.skills_dir.expanduser().resolve())
        ]


@pytest.fixture
async def db():
    """A freshly-initialized database, without the app's lifespan seeding."""
    await init_db()
    async with async_session_factory() as session:
        for ws in (await session.execute(select(Workspace))).scalars().all():
            await session.delete(ws)
        await session.commit()
    yield


async def test_ensure_is_idempotent(db) -> None:
    async with async_session_factory() as session:
        first = await ensure_skills_workspace(session)
        second = await ensure_skills_workspace(session)

    assert first.id == second.id
    assert first.name == SKILLS_WORKSPACE_NAME
    rows = await _catalog_rows()
    assert len(rows) == 1
    assert rows[0].path == str(settings.skills_dir.expanduser().resolve())


async def test_ensure_adopts_existing_row(db) -> None:
    """A workspace already pointing at the catalog is the skills workspace."""
    async with async_session_factory() as session:
        handmade = Workspace(
            name="My skills", path=str(settings.skills_dir.expanduser().resolve())
        )
        session.add(handmade)
        await session.commit()
        adopted = await ensure_skills_workspace(session)
        assert adopted.id == handmade.id
        # Adopted, not overwritten: the user's name survives.
        assert adopted.name == "My skills"

    assert len(await _catalog_rows()) == 1


async def test_superseded_default_name_is_refreshed(db) -> None:
    """A row still carrying an old default name was never named by anyone."""
    async with async_session_factory() as session:
        stale = Workspace(
            name="Skills", path=str(settings.skills_dir.expanduser().resolve())
        )
        session.add(stale)
        await session.commit()
        refreshed = await ensure_skills_workspace(session)

    assert refreshed.id == stale.id
    assert refreshed.name == SKILLS_WORKSPACE_NAME
    assert len(await _catalog_rows()) == 1


async def test_user_chosen_name_survives(db) -> None:
    """Only *superseded defaults* are refreshed — a real rename is the user's."""
    async with async_session_factory() as session:
        session.add(
            Workspace(
                name="Skills (mine)",
                path=str(settings.skills_dir.expanduser().resolve()),
            )
        )
        await session.commit()
        adopted = await ensure_skills_workspace(session)

    assert adopted.name == "Skills (mine)"


async def test_delete_is_refused(client: AsyncClient) -> None:
    async with async_session_factory() as session:
        ws = await ensure_skills_workspace(session)

    response = await client.delete(f"/workspaces/{ws.id}")
    assert response.status_code == 400
    assert "can't be deleted" in response.json()["detail"]
    assert len(await _catalog_rows()) == 1


async def test_rename_allowed_relocate_refused(client: AsyncClient, tmp_path) -> None:
    async with async_session_factory() as session:
        ws = await ensure_skills_workspace(session)

    moved = await client.patch(
        f"/workspaces/{ws.id}", json={"path": str(tmp_path / "elsewhere")}
    )
    assert moved.status_code == 400
    assert "can't be moved" in moved.json()["detail"]
    # Refused before the directory is materialized.
    assert not (tmp_path / "elsewhere").exists()

    renamed = await client.patch(f"/workspaces/{ws.id}", json={"name": "Skill Smith"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Skill Smith"
    assert renamed.json()["path"] == ws.path
    assert renamed.json()["is_system"] is True

    # Echoing the current path back (what the edit dialog sends) is a no-op, not
    # a move.
    echoed = await client.patch(f"/workspaces/{ws.id}", json={"path": ws.path})
    assert echoed.status_code == 200


async def test_is_system_flag(client: AsyncClient) -> None:
    async with async_session_factory() as session:
        skills_ws = await ensure_skills_workspace(session)

    created = await client.post("/workspaces", json={"name": "Ordinary"})
    assert created.status_code == 201
    assert created.json()["is_system"] is False

    listed = (await client.get("/workspaces")).json()
    by_id = {w["id"]: w for w in listed}
    assert by_id[skills_ws.id]["is_system"] is True
    assert by_id[created.json()["id"]]["is_system"] is False

    async with async_session_factory() as session:
        row = await session.get(Workspace, skills_ws.id)
        assert WorkspaceRead.from_workspace(row).is_system is True


async def test_agent_written_skill_lands_unassigned(client: AsyncClient) -> None:
    """The handoff the whole design leans on: a folder written into the catalog
    (by the agent, in the skills workspace) is indexed on the next ``GET /skills``
    as a managed skill applying nowhere — the "Not assigned" bucket."""
    async with async_session_factory() as session:
        await ensure_skills_workspace(session)

    folder = settings.skills_dir.expanduser() / "agent-authored"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(
        "---\n"
        "name: Agent Authored\n"
        "description: Written into the catalog by an agent run.\n"
        "---\n\n"
        "Do the thing.\n"
    )

    response = await client.get("/skills")
    assert response.status_code == 200
    skill = next(s for s in response.json() if s["slug"] == "agent-authored")
    assert skill["origin"] == "managed"
    assert skill["is_global"] is False
    assert skill["workspace_ids"] == []


async def test_deep_link_path_resolves(client: AsyncClient) -> None:
    """The path the UI deep-links a skill by is a real file in the workspace.

    The manager's "Open in Skill Studio" builds ``<slug>/SKILL.md`` relative to
    the studio workspace (``frontend/src/lib/skill-location.ts``). That is a
    convention spanning two layouts on disk, so pin it: if the catalog ever
    stopped being flat, the deep link would 404 with nothing else failing.
    """
    async with async_session_factory() as session:
        studio = await ensure_skills_workspace(session)

    created = await client.post(
        "/skills",
        json={
            "name": "Deep Link",
            "description": "Reachable by path.",
            "content": "Body.",
            "origin": "managed",
            "is_global": False,
        },
    )
    assert created.status_code in (200, 201), created.text
    slug = created.json()["slug"]

    read = await client.get(
        f"/workspaces/{studio.id}/files/read", params={"path": f"{slug}/SKILL.md"}
    )
    assert read.status_code == 200, read.text
    assert "Body." in read.json()["content"]

    # The other half of the convention: a repo-local skill opens in the repo
    # that owns it, under .agents/skills/<slug>/.
    repo = (await client.post("/workspaces", json={"name": "Repo"})).json()
    local = await client.post(
        "/skills",
        json={
            "name": "Local Link",
            "description": "Lives in the repo.",
            "content": "Local body.",
            "origin": "local",
            "workspace_id": repo["id"],
        },
    )
    assert local.status_code in (200, 201), local.text
    local_read = await client.get(
        f"/workspaces/{repo['id']}/files/read",
        params={"path": f".agents/skills/{local.json()['slug']}/SKILL.md"},
    )
    assert local_read.status_code == 200, local_read.text
    assert "Local body." in local_read.json()["content"]
