"""Turning a skill off without deleting it.

``Skill.enabled`` is the only off switch a discovered skill has: ``local`` and
``external`` skills carry no assignment, so before this the only way to stop one
loading was to delete the folder — which for a foreign root means deleting it out
of a repo or out of Claude Code. For a managed skill it is a second axis
alongside assignment: parked says *where* (nowhere), off says *whether*.

Two properties matter beyond "it stops loading". Toggling must not touch
``SKILL.md`` — ``enabled`` is Lursor's state, not the file's, and writing it back
would dirty a git tree to record something the file never holds. And a disabled
row must not *shadow*: switching off a repo's ``pdf`` has to let the catalog's
``pdf`` through, not leave a hole where the skill used to be.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from httpx import AsyncClient

from app.config import get_settings
from app.db.session import async_session_factory
from app.skills.resolve import skills_in_scope

settings = get_settings()

SKILL_MD = "---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"


def write_skill_folder(root: Path, slug: str, *, name: str, description: str, body: str) -> Path:
    folder = root / slug
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(
        SKILL_MD.format(name=name, description=description, body=body), encoding="utf-8"
    )
    return folder


@pytest.fixture
def user_root(tmp_path, monkeypatch):
    root = tmp_path / "home-claude" / "skills"
    root.mkdir(parents=True)
    monkeypatch.setattr(settings, "user_skill_roots", [str(root)], raising=False)
    return root


async def make_workspace(client: AsyncClient, name: str, tmp_path: Path) -> dict:
    path = tmp_path / name
    path.mkdir(parents=True, exist_ok=True)
    response = await client.post("/workspaces", json={"name": name, "path": str(path)})
    assert response.status_code == 201, response.text
    return response.json()


def find(listed: list[dict], slug: str, origin: str | None = None) -> dict:
    hits = [
        s for s in listed if s["slug"] == slug and (origin is None or s["origin"] == origin)
    ]
    assert len(hits) == 1, f"expected one {origin or 'any'} skill {slug!r}, got {len(hits)}"
    return hits[0]


async def in_scope(client: AsyncClient, workspace_id: str) -> set[str]:
    response = await client.get(
        "/skills", params={"assignment": "workspace", "workspace_id": workspace_id}
    )
    assert response.status_code == 200, response.text
    return {s["slug"] for s in response.json()}


async def test_disabled_skill_leaves_scope_but_keeps_its_row(
    client: AsyncClient, tmp_path
) -> None:
    ws = await make_workspace(client, "toggle", tmp_path)
    folder = write_skill_folder(
        Path(ws["path"]) / ".claude/skills", "toggler", name="Toggler", description="d", body="b"
    )
    skill = find((await client.get("/skills")).json(), "toggler", "local")
    assert skill["enabled"] is True
    assert "toggler" in await in_scope(client, ws["id"])

    off = await client.patch(f"/skills/{skill['id']}", json={"enabled": False})
    assert off.status_code == 200, off.text
    assert off.json()["enabled"] is False

    # Out of scope, but still listed in the manager and still on disk.
    assert "toggler" not in await in_scope(client, ws["id"])
    assert find((await client.get("/skills")).json(), "toggler", "local")["enabled"] is False
    assert (folder / "SKILL.md").is_file()

    # ...and it comes back.
    on = await client.patch(f"/skills/{skill['id']}", json={"enabled": True})
    assert on.status_code == 200, on.text
    assert "toggler" in await in_scope(client, ws["id"])


async def test_toggling_does_not_touch_skill_md(client: AsyncClient, tmp_path) -> None:
    """``enabled`` is our state, not the file's — writing it back would dirty a repo."""
    ws = await make_workspace(client, "untouched", tmp_path)
    folder = Path(ws["path"]) / ".claude" / "skills" / "pristine"
    folder.mkdir(parents=True)
    original = (
        "---\n"
        "name: Pristine\n"
        "description: Unchanged.\n"
        "allowed-tools: Bash(git status:*)\n"
        "---\n\n"
        "Body.\n"
    )
    skill_md = folder / "SKILL.md"
    skill_md.write_text(original, encoding="utf-8")
    skill = find((await client.get("/skills")).json(), "pristine", "local")
    before = skill_md.stat().st_mtime_ns

    off = await client.patch(f"/skills/{skill['id']}", json={"enabled": False})
    assert off.status_code == 200, off.text

    assert skill_md.read_text(encoding="utf-8") == original
    assert skill_md.stat().st_mtime_ns == before, "a toggle rewrote a file we don't own"


async def test_disabled_row_does_not_shadow_a_further_layer(
    client: AsyncClient, tmp_path
) -> None:
    """Switching off a repo's copy reveals the catalog one, rather than a hole."""
    ws = await make_workspace(client, "shadow", tmp_path)
    write_skill_folder(
        Path(ws["path"]) / ".claude/skills",
        "layered",
        name="layered",
        description="From the repo.",
        body="repo",
    )
    created = await client.post(
        "/skills",
        json={
            "name": "layered",
            "description": "From the catalog.",
            "content": "catalog",
            "origin": "managed",
            "is_global": True,
        },
    )
    assert created.status_code in (200, 201), created.text

    scoped = await client.get(
        "/skills", params={"assignment": "workspace", "workspace_id": ws["id"]}
    )
    winner = find(scoped.json(), "layered")
    assert winner["layer"] == "local"

    local_row = find((await client.get("/skills")).json(), "layered", "local")
    off = await client.patch(f"/skills/{local_row['id']}", json={"enabled": False})
    assert off.status_code == 200, off.text

    scoped = await client.get(
        "/skills", params={"assignment": "workspace", "workspace_id": ws["id"]}
    )
    winner = find(scoped.json(), "layered")
    assert winner["layer"] == "global"
    assert winner["description"] == "From the catalog."


async def test_disabling_a_user_skill_removes_it_everywhere(
    client: AsyncClient, tmp_path, user_root
) -> None:
    write_skill_folder(user_root, "personal", name="Personal", description="d", body="b")
    first = await make_workspace(client, "one", tmp_path)
    second = await make_workspace(client, "two", tmp_path)
    skill = find((await client.get("/skills")).json(), "personal", "external")
    assert "personal" in await in_scope(client, first["id"])

    off = await client.patch(f"/skills/{skill['id']}", json={"enabled": False})
    assert off.status_code == 200, off.text

    for ws in (first, second):
        assert "personal" not in await in_scope(client, ws["id"])
    assert (user_root / "personal" / "SKILL.md").is_file()


async def test_disabled_skill_is_not_handed_to_a_run(client: AsyncClient, tmp_path) -> None:
    """The folder list the agent actually receives, not just the listing."""
    ws = await make_workspace(client, "runtime", tmp_path)
    write_skill_folder(
        Path(ws["path"]) / ".agents/skills", "runner", name="Runner", description="d", body="b"
    )
    skill = find((await client.get("/skills")).json(), "runner", "local")

    async with async_session_factory() as session:
        scoped = await skills_in_scope(
            session, workspace_path=ws["path"], workspace_id=ws["id"]
        )
    assert any(s.slug == "runner" for s in scoped)

    off = await client.patch(f"/skills/{skill['id']}", json={"enabled": False})
    assert off.status_code == 200, off.text

    async with async_session_factory() as session:
        scoped = await skills_in_scope(
            session, workspace_path=ws["path"], workspace_id=ws["id"]
        )
    assert not any(s.slug == "runner" for s in scoped)


async def test_reconcile_preserves_the_toggle(client: AsyncClient, tmp_path) -> None:
    """Disk is authoritative for content, not for whether the skill is on."""
    ws = await make_workspace(client, "survives", tmp_path)
    folder = write_skill_folder(
        Path(ws["path"]) / ".claude/skills",
        "sticky",
        name="Sticky",
        description="Before.",
        body="b",
    )
    skill = find((await client.get("/skills")).json(), "sticky", "local")
    off = await client.patch(f"/skills/{skill['id']}", json={"enabled": False})
    assert off.status_code == 200, off.text

    # An out-of-band edit forces reconcile to refresh the cache from disk.
    (folder / "SKILL.md").write_text(
        SKILL_MD.format(name="Sticky", description="After.", body="b"), encoding="utf-8"
    )

    refreshed = find((await client.get("/skills")).json(), "sticky", "local")
    assert refreshed["description"] == "After."
    assert refreshed["enabled"] is False


async def test_enabled_column_backfills_to_on(tmp_path) -> None:
    """An upgrade changes nothing about what loads."""
    import sqlite3

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlmodel import SQLModel

    from app.db import models  # noqa: F401  (registers tables on the metadata)
    from app.db.session import _apply_lightweight_migrations

    path = tmp_path / "pre-enabled.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
            await conn.execute(text("ALTER TABLE skills DROP COLUMN enabled"))
    finally:
        await engine.dispose()

    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO skills (id, created_at, updated_at, slug, name, description,"
        " content, origin, is_global, root)"
        " VALUES ('old', datetime('now'), datetime('now'), 'old', 'Old', '', '',"
        " 'managed', 1, '')"
    )
    con.commit()
    con.close()

    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await _apply_lightweight_migrations(conn)
        async with engine.connect() as conn:
            rows = (await conn.execute(text("SELECT id, enabled FROM skills"))).all()
    finally:
        await engine.dispose()

    assert rows == [("old", 1)]
