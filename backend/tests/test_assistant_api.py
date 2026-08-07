"""The Assistant over HTTP: seeding, the workspace guards, and the ordinary agent.

The theme of this file is what the Assistant *is not*. Privilege lives on the
workspace, so the seeded agent must behave like any other row — editable,
deletable, listed in every picker — and the tests below are mostly assertions
that nothing special is happening to it.
"""

from __future__ import annotations

from app.assistant.identity import (
    ASSISTANT_AGENT_ID,
    ASSISTANT_WORKSPACE_ID,
    DEFAULT_ASSISTANT_MODEL,
    ensure_assistant_records,
)
from app.db.session import async_session_factory


async def _seed() -> None:
    async with async_session_factory() as session:
        await ensure_assistant_records(session)


# --- seeding --------------------------------------------------------------------


async def test_seeding_is_idempotent(client):
    """Every boot runs it; a second pair of rows would be a duplicate Assistant."""
    await _seed()
    await _seed()
    await _seed()

    agents = (await client.get("/agents")).json()
    workspaces = (await client.get("/workspaces")).json()

    assert [a["id"] for a in agents].count(ASSISTANT_AGENT_ID) == 1
    assert [w["id"] for w in workspaces].count(ASSISTANT_WORKSPACE_ID) == 1


async def test_the_workspace_is_flagged_for_the_ui(client):
    """The sidebar pins on this, so it has to be on the wire."""
    await _seed()

    workspace = next(
        w for w in (await client.get("/workspaces")).json() if w["id"] == ASSISTANT_WORKSPACE_ID
    )
    assert workspace["is_assistant"] is True


async def test_the_agent_carries_no_flag_at_all(client):
    """The agent is ordinary, and the wire format must not suggest otherwise.

    An ``is_assistant`` field on ``AgentRead`` is what the old shape used to hide
    this row from every picker. Its absence is the simplification: there is
    nothing about this agent for a picker to filter on, because there is nothing
    special about it.
    """
    await _seed()
    agent = next(a for a in (await client.get("/agents")).json() if a["id"] == ASSISTANT_AGENT_ID)
    assert "is_assistant" not in agent


async def test_the_agent_ships_pointed_at_glm(client):
    """The model lives on the row, like every other agent's."""
    await _seed()
    agent = next(a for a in (await client.get("/agents")).json() if a["id"] == ASSISTANT_AGENT_ID)
    assert agent["model"] == DEFAULT_ASSISTANT_MODEL
    assert agent["instructions"].strip() != ""


# --- the agent is ordinary ------------------------------------------------------


async def test_the_agent_can_be_edited_and_deleted(client):
    """Rename it, retarget it, delete it — none of that touches what it can do."""
    await _seed()

    renamed = await client.patch(
        f"/agents/{ASSISTANT_AGENT_ID}",
        json={"name": "Ops", "model": "openrouter:anthropic/claude-opus-4"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Ops"
    assert renamed.json()["model"] == "openrouter:anthropic/claude-opus-4"

    assert (await client.delete(f"/agents/{ASSISTANT_AGENT_ID}")).status_code == 204
    assert ASSISTANT_AGENT_ID not in {a["id"] for a in (await client.get("/agents")).json()}


async def test_an_edit_survives_the_next_boot(client):
    """Seeding writes the row once. A boot that re-asserted it would undo the editor."""
    await _seed()
    await client.patch(f"/agents/{ASSISTANT_AGENT_ID}", json={"name": "Ops", "web_search": False})

    await _seed()

    agent = next(a for a in (await client.get("/agents")).json() if a["id"] == ASSISTANT_AGENT_ID)
    assert agent["name"] == "Ops"
    assert agent["web_search"] is False


# --- the workspace is not -------------------------------------------------------


async def test_the_workspace_cannot_be_moved_or_deleted(client, tmp_path):
    """This row *is* the privilege, so it stays where it is."""
    await _seed()

    moved = await client.patch(
        f"/workspaces/{ASSISTANT_WORKSPACE_ID}", json={"path": str(tmp_path / "elsewhere")}
    )
    assert moved.status_code == 400

    deleted = await client.delete(f"/workspaces/{ASSISTANT_WORKSPACE_ID}")
    assert deleted.status_code == 400

    # A rename is allowed — it is a label, not a location.
    renamed = await client.patch(f"/workspaces/{ASSISTANT_WORKSPACE_ID}", json={"name": "Ops"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Ops"


# --- routes ---------------------------------------------------------------------


async def test_assistant_conversations_are_ordinary_threads(client):
    """The whole point of the pinned-row shape: history needs no special API.

    The Assistant is a workspace, so its past conversations come back from the
    same ``GET /threads`` the sidebar already calls for every other row. If this
    ever stops being true, the sidebar silently loses its history.
    """
    await _seed()
    created = (
        await client.post(
            "/threads",
            json={
                "workspace_id": ASSISTANT_WORKSPACE_ID,
                "agent_id": ASSISTANT_AGENT_ID,
            },
        )
    ).json()

    listed = (
        await client.get("/threads", params={"workspace_id": ASSISTANT_WORKSPACE_ID})
    ).json()
    assert created["id"] in {t["id"] for t in listed}

    # And it shows up in the unscoped list the sidebar actually uses.
    everything = (await client.get("/threads")).json()
    assert created["id"] in {t["id"] for t in everything}


async def test_the_model_setting_is_gone(client):
    """It was redundant once any agent could be selected: the row carries the model."""
    assert (await client.get("/settings/assistant")).status_code == 404


async def test_resolving_an_unknown_confirmation_is_404(client):
    resp = await client.post("/assistant/confirm/nope", json={"approved": True})
    assert resp.status_code == 404
