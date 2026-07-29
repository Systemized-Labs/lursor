"""Sidebar groups for workspaces.

A folder is a label with a place in the list, so what has to hold is that it
never behaves like a directory: filing a workspace into one leaves its checkout
alone, and deleting the group turns its members loose instead of taking them
down with it. The rest is ordering — one drop can move a workspace between
groups and renumber both, and the layout endpoint has to land all of it.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlmodel import select

from app.db.models import Workspace, WorkspaceFolder
from app.db.session import async_session_factory, init_db


@pytest.fixture
async def db():
    """A freshly-initialized database with no workspaces or folders in it."""
    await init_db()
    async with async_session_factory() as session:
        for ws in (await session.execute(select(Workspace))).scalars().all():
            await session.delete(ws)
        for folder in (await session.execute(select(WorkspaceFolder))).scalars().all():
            await session.delete(folder)
        await session.commit()
    yield


async def _workspace(client: AsyncClient, name: str) -> dict:
    response = await client.post("/workspaces", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def test_new_rows_land_at_the_bottom_of_the_root(client: AsyncClient, db):
    """Creation order is the starting arrangement, groups included."""
    first = await _workspace(client, "first")
    folder = (await client.post("/workspace-folders", json={"name": "Group"})).json()
    second = await _workspace(client, "second")

    assert first["position"] == 0
    assert first["folder_id"] is None
    assert folder["position"] == 1
    assert second["position"] == 2


async def test_layout_files_a_workspace_and_reorders_the_root(
    client: AsyncClient, db, tmp_path
):
    """One drop: `alpha` moves into the group, which moves above `beta`."""
    alpha = await _workspace(client, "alpha")
    beta = await _workspace(client, "beta")
    folder = (await client.post("/workspace-folders", json={"name": "Group"})).json()

    response = await client.put(
        "/workspace-folders/layout",
        json={
            "folders": [{"id": folder["id"], "position": 0}],
            "workspaces": [
                {"id": beta["id"], "folder_id": None, "position": 1},
                {"id": alpha["id"], "folder_id": folder["id"], "position": 0},
            ],
        },
    )
    assert response.status_code == 200, response.text

    listed = (await client.get("/workspaces")).json()
    by_id = {w["id"]: w for w in listed}
    assert by_id[alpha["id"]]["folder_id"] == folder["id"]
    assert by_id[alpha["id"]]["position"] == 0
    assert by_id[beta["id"]]["folder_id"] is None
    assert by_id[beta["id"]]["position"] == 1
    # Filing a workspace is a sidebar move, not a move on disk.
    assert by_id[alpha["id"]]["path"] == alpha["path"]


async def test_layout_moves_a_workspace_between_groups(client: AsyncClient, db):
    """The drag the rail actually sends: whole tree, both groups renumbered."""
    moved = await _workspace(client, "moved")
    stays = await _workspace(client, "stays")
    source = (await client.post("/workspace-folders", json={"name": "Source"})).json()
    dest = (await client.post("/workspace-folders", json={"name": "Dest"})).json()

    def layout(folder_for_moved: str, moved_position: int) -> dict:
        return {
            "folders": [
                {"id": source["id"], "position": 0},
                {"id": dest["id"], "position": 1},
            ],
            "workspaces": [
                {"id": stays["id"], "folder_id": source["id"], "position": 0},
                {
                    "id": moved["id"],
                    "folder_id": folder_for_moved,
                    "position": moved_position,
                },
            ],
        }

    assert (
        await client.put("/workspace-folders/layout", json=layout(source["id"], 1))
    ).status_code == 200
    assert (
        await client.put("/workspace-folders/layout", json=layout(dest["id"], 0))
    ).status_code == 200

    by_id = {w["id"]: w for w in (await client.get("/workspaces")).json()}
    assert by_id[moved["id"]]["folder_id"] == dest["id"]
    assert by_id[moved["id"]]["position"] == 0
    # The group it left keeps its own numbering rather than a hole where it was.
    assert by_id[stays["id"]]["folder_id"] == source["id"]
    assert by_id[stays["id"]]["position"] == 0


async def test_layout_skips_rows_that_have_since_disappeared(client: AsyncClient, db):
    """A layout computed against a stale list still lands for what's left."""
    kept = await _workspace(client, "kept")
    response = await client.put(
        "/workspace-folders/layout",
        json={
            "folders": [{"id": "gone", "position": 0}],
            "workspaces": [
                {"id": "gone-too", "folder_id": None, "position": 0},
                {"id": kept["id"], "folder_id": None, "position": 3},
            ],
        },
    )
    assert response.status_code == 200, response.text
    listed = (await client.get("/workspaces")).json()
    assert [w["position"] for w in listed if w["id"] == kept["id"]] == [3]


async def test_layout_refuses_an_unknown_folder(client: AsyncClient, db):
    """Filing a workspace into a folder that isn't there would orphan its row."""
    ws = await _workspace(client, "orphan-me")
    response = await client.put(
        "/workspace-folders/layout",
        json={
            "workspaces": [{"id": ws["id"], "folder_id": "nope", "position": 0}],
        },
    )
    assert response.status_code == 404
    listed = (await client.get("/workspaces")).json()
    assert [w["folder_id"] for w in listed if w["id"] == ws["id"]] == [None]


async def test_deleting_a_folder_frees_its_workspaces(client: AsyncClient, db):
    """The group goes; the projects inside it come back out at the root."""
    loose = await _workspace(client, "loose")
    inside = await _workspace(client, "inside")
    folder = (await client.post("/workspace-folders", json={"name": "Group"})).json()
    await client.put(
        "/workspace-folders/layout",
        json={
            "folders": [{"id": folder["id"], "position": 0}],
            "workspaces": [
                {"id": loose["id"], "folder_id": None, "position": 1},
                {"id": inside["id"], "folder_id": folder["id"], "position": 0},
            ],
        },
    )

    response = await client.delete(f"/workspace-folders/{folder['id']}")
    assert response.status_code == 204
    assert (await client.get("/workspace-folders")).json() == []

    listed = (await client.get("/workspaces")).json()
    ids = [w["id"] for w in listed]
    assert set(ids) == {loose["id"], inside["id"]}
    freed = next(w for w in listed if w["id"] == inside["id"])
    assert freed["folder_id"] is None
    # Appended after everything already at the root, so it doesn't jump the list.
    assert ids == [loose["id"], inside["id"]]


async def test_folder_rename_and_validation(client: AsyncClient, db):
    folder = (await client.post("/workspace-folders", json={"name": "  Group  "})).json()
    assert folder["name"] == "Group"

    renamed = await client.patch(
        f"/workspace-folders/{folder['id']}", json={"name": "Clients"}
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Clients"

    blank = await client.patch(
        f"/workspace-folders/{folder['id']}", json={"name": "   "}
    )
    assert blank.status_code == 400
    assert (await client.post("/workspace-folders", json={"name": ""})).status_code == 400
    assert (await client.patch("/workspace-folders/nope", json={})).status_code == 404
    assert (await client.delete("/workspace-folders/nope")).status_code == 404
