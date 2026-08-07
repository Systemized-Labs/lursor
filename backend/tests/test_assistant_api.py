"""The Assistant over HTTP: seeding, the system-row guards, and the model setting."""

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


async def test_the_rows_are_flagged_for_the_ui(client):
    """The frontend filters on these, so they have to be on the wire."""
    await _seed()

    agent = next(a for a in (await client.get("/agents")).json() if a["id"] == ASSISTANT_AGENT_ID)
    workspace = next(
        w for w in (await client.get("/workspaces")).json() if w["id"] == ASSISTANT_WORKSPACE_ID
    )

    assert agent["is_assistant"] is True
    assert workspace["is_assistant"] is True
    # An ordinary row must not be flagged.
    other = (await client.post("/agents", json={"name": "Builder", "instructions": "hi"})).json()
    assert other["is_assistant"] is False


async def test_the_model_column_stays_null(client):
    """One source of truth: the effective model comes from AppConfig, not the row."""
    await _seed()
    agent = next(a for a in (await client.get("/agents")).json() if a["id"] == ASSISTANT_AGENT_ID)
    assert agent["model"] is None


# --- guards ---------------------------------------------------------------------


async def test_the_assistant_agent_cannot_be_edited_or_deleted(client):
    await _seed()

    patched = await client.patch(f"/agents/{ASSISTANT_AGENT_ID}", json={"name": "Pwned"})
    assert patched.status_code == 400
    assert "Settings" in patched.json()["detail"]

    deleted = await client.delete(f"/agents/{ASSISTANT_AGENT_ID}")
    assert deleted.status_code == 400

    # Still there, still itself.
    agent = next(a for a in (await client.get("/agents")).json() if a["id"] == ASSISTANT_AGENT_ID)
    assert agent["name"] == "Assistant"


async def test_the_assistant_workspace_cannot_be_moved_or_deleted(client, tmp_path):
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


# --- the model setting ----------------------------------------------------------


async def test_the_model_setting_round_trips(client):
    """Unset inherits the shipped default; a saved value wins; blank clears it."""
    initial = (await client.get("/settings/assistant")).json()
    assert initial["model"] == DEFAULT_ASSISTANT_MODEL
    assert initial["default_model"] == DEFAULT_ASSISTANT_MODEL
    assert initial["source"] == "default"

    saved = (
        await client.put(
            "/settings/assistant", json={"model": "openrouter:anthropic/claude-opus-4"}
        )
    ).json()
    assert saved["model"] == "openrouter:anthropic/claude-opus-4"
    assert saved["source"] == "database"
    # And it survives a re-read rather than only being echoed back.
    assert (await client.get("/settings/assistant")).json()["model"] == saved["model"]

    cleared = (await client.put("/settings/assistant", json={"model": ""})).json()
    assert cleared["model"] == DEFAULT_ASSISTANT_MODEL
    assert cleared["source"] == "default"


async def test_the_setting_is_what_the_build_resolves(client):
    """The setting has to reach the run, not just the settings page."""
    from sqlmodel import select

    from app.assistant.builder import resolve_assistant_model
    from app.db.models import AppConfig

    await client.put("/settings/assistant", json={"model": "custom:box:glm-5.2"})
    async with async_session_factory() as session:
        cfg = (await session.execute(select(AppConfig))).scalars().first()
    assert resolve_assistant_model(cfg) == "custom:box:glm-5.2"

    await client.put("/settings/assistant", json={"model": ""})
    async with async_session_factory() as session:
        cfg = (await session.execute(select(AppConfig))).scalars().first()
    assert resolve_assistant_model(cfg) == DEFAULT_ASSISTANT_MODEL
    assert resolve_assistant_model(None) == DEFAULT_ASSISTANT_MODEL


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


async def test_resolving_an_unknown_confirmation_is_404(client):
    resp = await client.post("/assistant/confirm/nope", json={"approved": True})
    assert resp.status_code == 404
