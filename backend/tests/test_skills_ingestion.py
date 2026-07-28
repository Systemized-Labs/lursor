"""Skills that already exist on disk, in roots Lursor didn't create.

Two claims are under test. The first is that discovery is *complete*: a repo
carrying ``.claude/skills`` and a home directory carrying ``~/.claude/skills``
are both indexed, both reach a run, and collisions between them resolve by layer.

The second is that discovery is *inert*. Everything outside ``.agents/skills``
and the catalog belongs to another tool, so Lursor may index it and may edit a
file it is pointed at, but must never bring a directory into existence, rebuild a
folder someone deleted, move a folder out of a git tree, or drop frontmatter keys
it doesn't model. Those are the regressions that would show up as junk in a
user's repo rather than as a failing request, so they are pinned here.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlmodel import select

from app.config import Settings, get_settings
from app.db.models import Skill
from app.db.session import async_session_factory
from app.skills import store

settings = get_settings()

SKILL_MD = "---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"


def write_skill_folder(root: Path, slug: str, *, name: str, description: str, body: str) -> Path:
    folder = root / slug
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(
        SKILL_MD.format(name=name, description=description, body=body),
        encoding="utf-8",
    )
    return folder


async def make_workspace(client: AsyncClient, name: str, tmp_path: Path) -> dict:
    path = tmp_path / name
    path.mkdir(parents=True, exist_ok=True)
    response = await client.post("/workspaces", json={"name": name, "path": str(path)})
    assert response.status_code == 201, response.text
    return response.json()


def find(listed: list[dict], slug: str, origin: str | None = None) -> dict:
    """The one row with this slug (and origin).

    The catalog is a real directory shared by the whole test session, so a bare
    slug lookup can land on another test's skill. Every assertion here names the
    origin it means.
    """
    hits = [s for s in listed if s["slug"] == slug and (origin is None or s["origin"] == origin)]
    assert len(hits) == 1, f"expected one {origin or 'any'} skill {slug!r}, got {len(hits)}"
    return hits[0]


async def scoped_slugs(client: AsyncClient, workspace_id: str) -> dict[str, str]:
    """slug -> layer, for everything in scope in one workspace."""
    response = await client.get(
        "/skills", params={"assignment": "workspace", "workspace_id": workspace_id}
    )
    assert response.status_code == 200, response.text
    return {s["slug"]: s["layer"] for s in response.json()}


# --- Discovery ------------------------------------------------------------------


async def test_claude_skills_folder_is_discovered(client: AsyncClient, tmp_path) -> None:
    """The gap this whole change exists to close: a cloned repo's .claude/skills."""
    ws = await make_workspace(client, "repo", tmp_path)
    write_skill_folder(
        Path(ws["path"]) / ".claude" / "skills",
        "foo",
        name="Foo",
        description="Committed in the repo by whoever wrote it.",
        body="Do foo.",
    )

    listed = (await client.get("/skills")).json()
    foo = find(listed, "foo", "local")
    assert foo["origin"] == "local"
    assert foo["root"] == ".claude/skills"
    assert foo["root_label"] == ".claude"
    assert foo["is_owned_root"] is False
    assert foo["workspace_id"] == ws["id"]
    assert foo["description"] == "Committed in the repo by whoever wrote it."

    assert (await scoped_slugs(client, ws["id"]))["foo"] == "local"


async def test_all_local_roots_are_in_scope_together(client: AsyncClient, tmp_path) -> None:
    ws = await make_workspace(client, "three-roots", tmp_path)
    for subdir, slug in (
        (".agents/skills", "ours"),
        (".claude/skills", "claude"),
        (".cursor/skills", "cursor"),
    ):
        write_skill_folder(
            Path(ws["path"]) / subdir, slug, name=slug, description=slug, body=slug
        )

    scoped = await scoped_slugs(client, ws["id"])
    assert {k: scoped.get(k) for k in ("ours", "claude", "cursor")} == {
        "ours": "local",
        "claude": "local",
        "cursor": "local",
    }

    # The folder list handed to the agent is the point of the exercise.
    from app.skills.resolve import skill_dirs, skills_in_scope

    async with async_session_factory() as session:
        scoped = await skills_in_scope(
            session, workspace_path=ws["path"], workspace_id=ws["id"]
        )
    local_dirs = [d for d in skill_dirs(scoped) if d.startswith(ws["path"])]
    assert len(local_dirs) == 3
    assert {Path(d).parent.parent.name for d in local_dirs} == {
        ".agents",
        ".claude",
        ".cursor",
    }


async def test_same_slug_in_two_local_roots_resolves_to_ours(
    client: AsyncClient, tmp_path
) -> None:
    """Config order decides a within-layer collision — ``.agents`` is first."""
    ws = await make_workspace(client, "collide", tmp_path)
    ours = write_skill_folder(
        Path(ws["path"]) / ".agents/skills",
        "pdf",
        name="PDF",
        description="Ours.",
        body="Ours.",
    )
    theirs = write_skill_folder(
        Path(ws["path"]) / ".claude/skills",
        "pdf",
        name="PDF",
        description="Theirs.",
        body="Theirs.",
    )

    response = await client.get(
        "/skills", params={"assignment": "workspace", "workspace_id": ws["id"]}
    )
    scoped = [s for s in response.json() if s["slug"] == "pdf"]
    assert len(scoped) == 1
    assert scoped[0]["root"] == ".agents/skills"
    assert scoped[0]["description"] == "Ours."

    # Both are still indexed as separate rows — the loser isn't deleted, just
    # shadowed — and an edit lands in the winner's own file.
    edited = await client.patch(
        f"/skills/{scoped[0]['id']}", json={"description": "Edited."}
    )
    assert edited.status_code == 200, edited.text
    assert "Edited." in (ours / "SKILL.md").read_text()
    assert "Theirs." in (theirs / "SKILL.md").read_text()


async def test_bare_skills_directory_is_discovered(client: AsyncClient, tmp_path) -> None:
    """Plenty of repos keep skills at the top level, not under a dotfolder."""
    ws = await make_workspace(client, "top-level", tmp_path)
    root = Path(ws["path"]) / "skills"
    write_skill_folder(root, "vertica", name="vertica", description="Query it.", body="b")
    # The junk that shares such a directory: a helper folder with no SKILL.md and
    # a loose document. Neither is a skill, so neither may be indexed.
    (root / "_shared").mkdir()
    (root / "_shared" / "helpers.py").write_text("x", encoding="utf-8")
    (root / "add-endpoint.md").write_text("# notes", encoding="utf-8")

    listed = (await client.get("/skills")).json()
    skill = find(listed, "vertica", "local")
    assert skill["root"] == "skills"
    assert skill["root_label"] == "skills"
    assert skill["is_owned_root"] is False
    assert not any(s["slug"] in {"_shared", "add-endpoint"} for s in listed)
    assert (await scoped_slugs(client, ws["id"]))["vertica"] == "local"


async def test_catalog_is_never_scanned_as_a_local_root(client: AsyncClient) -> None:
    """A workspace whose ``skills/`` *is* the catalog must not double-index it.

    The Skill Studio workspace points at the catalog itself, and a workspace
    registered at ``~/.lursor`` would match the bare ``skills`` entry — indexing
    every managed skill a second time as a local one that shadows it.
    """
    from app.api.workspaces import ensure_skills_workspace

    catalog = settings.skills_dir.expanduser()
    write_skill_folder(catalog, "catalog-only", name="Catalog Only", description="d", body="b")

    async with async_session_factory() as session:
        studio = await ensure_skills_workspace(session)
    parent = str(Path(studio.path).parent)
    created = await client.post("/workspaces", json={"name": "Data root", "path": parent})
    assert created.status_code == 201, created.text

    assert store.local_skill_roots(parent) == []
    rows = [s for s in (await client.get("/skills")).json() if s["slug"] == "catalog-only"]
    assert len(rows) == 1
    assert rows[0]["origin"] == "managed"


# --- The materialize guard ------------------------------------------------------


async def test_reconcile_never_creates_a_foreign_root(client: AsyncClient, tmp_path) -> None:
    """A workspace with no ``.claude/`` must still have none after a listing."""
    ws = await make_workspace(client, "bare", tmp_path)

    assert (await client.get("/skills")).status_code == 200

    assert not (Path(ws["path"]) / ".claude").exists()
    assert not (Path(ws["path"]) / ".cursor").exists()


async def test_deleted_foreign_folder_drops_the_row_and_stays_deleted(
    client: AsyncClient, tmp_path
) -> None:
    """The regression that matters most: no resurrecting what another tool deleted."""
    ws = await make_workspace(client, "deleter", tmp_path)
    root = Path(ws["path"]) / ".claude" / "skills"
    folder = write_skill_folder(root, "gone", name="Gone", description="d", body="b")

    indexed = (await client.get("/skills")).json()
    assert any(s["slug"] == "gone" for s in indexed)

    # The user deletes it in Cursor / with rm / by pulling a commit that drops it.
    import shutil

    shutil.rmtree(folder)

    listed = (await client.get("/skills")).json()
    assert not any(s["slug"] == "gone" for s in listed)
    assert not folder.exists(), "reconcile rebuilt a folder in a root it doesn't own"

    async with async_session_factory() as session:
        rows = (await session.execute(select(Skill))).scalars().all()
        assert not any(r.slug == "gone" for r in rows)


async def test_deleted_owned_folder_is_still_materialized(
    client: AsyncClient, tmp_path
) -> None:
    """The other side of the flag: ``.agents/skills`` is ours, so the cache rebuilds."""
    ws = await make_workspace(client, "owned", tmp_path)
    created = await client.post(
        "/skills",
        json={
            "name": "Ours",
            "description": "d",
            "content": "Body.",
            "origin": "local",
            "workspace_id": ws["id"],
        },
    )
    assert created.status_code in (200, 201), created.text
    slug = created.json()["slug"]
    folder = Path(ws["path"]) / ".agents" / "skills" / slug

    import shutil

    shutil.rmtree(folder)

    listed = (await client.get("/skills")).json()
    assert any(s["slug"] == slug for s in listed)
    assert (folder / "SKILL.md").is_file()


# --- The user layer -------------------------------------------------------------


async def test_user_root_is_in_scope_everywhere(
    client: AsyncClient, tmp_path, user_root
) -> None:
    write_skill_folder(
        user_root, "bar", name="Bar", description="Personal.", body="Personal."
    )
    first = await make_workspace(client, "first", tmp_path)
    second = await make_workspace(client, "second", tmp_path)

    listed = (await client.get("/skills")).json()
    bar = find(listed, "bar", "external")
    assert bar["origin"] == "external"
    assert bar["root"] == str(user_root)
    assert bar["root_label"].endswith("skills") or bar["root_label"].endswith("claude")
    assert bar["is_owned_root"] is False
    assert bar["workspace_id"] is None

    for ws in (first, second):
        assert (await scoped_slugs(client, ws["id"]))["bar"] == "user"

    filtered = (await client.get("/skills", params={"assignment": "user"})).json()
    assert [s["slug"] for s in filtered] == ["bar"]


async def test_catalog_beats_a_personal_root(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """Your Lursor catalog is a choice; a directory another tool fills is not."""
    write_skill_folder(
        user_root,
        "user-vs-catalog",
        name="user-vs-catalog",
        description="From ~/.claude.",
        body="theirs",
    )
    ws = await make_workspace(client, "collides-global", tmp_path)
    created = await client.post(
        "/skills",
        json={
            "name": "user-vs-catalog",
            "description": "From the catalog.",
            "content": "ours",
            "origin": "managed",
            "is_global": True,
        },
    )
    assert created.status_code in (200, 201), created.text

    response = await client.get(
        "/skills", params={"assignment": "workspace", "workspace_id": ws["id"]}
    )
    winners = [s for s in response.json() if s["slug"] == "user-vs-catalog"]
    assert len(winners) == 1
    assert winners[0]["layer"] == "global"
    assert winners[0]["description"] == "From the catalog."


async def test_unconfigured_user_root_drops_its_rows(
    client: AsyncClient, tmp_path, user_root, monkeypatch
) -> None:
    """Unplugging a directory degrades to 'those skills are gone', not an error."""
    write_skill_folder(user_root, "temp", name="Temp", description="d", body="b")
    assert any(s["slug"] == "temp" for s in (await client.get("/skills")).json())

    monkeypatch.setattr(settings, "user_skill_roots", [], raising=False)
    assert not any(s["slug"] == "temp" for s in (await client.get("/skills")).json())
    # Nothing was deleted on disk — the directory is simply no longer indexed.
    assert (user_root / "temp" / "SKILL.md").is_file()


# --- Guards ---------------------------------------------------------------------


async def test_promote_is_refused_on_a_user_skill(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """Reach is ours to set, but the folder is not ours to take."""
    write_skill_folder(user_root, "guarded", name="Guarded", description="d", body="b")
    skill = find((await client.get("/skills")).json(), "guarded", "external")

    promoted = await client.post(f"/skills/{skill['id']}/promote", json={})
    assert promoted.status_code == 409
    assert "copy" in promoted.json()["detail"].lower()
    assert (user_root / "guarded").is_dir()


async def test_assignment_is_refused_on_a_repo_skill(
    client: AsyncClient, tmp_path
) -> None:
    """A committed skill applies where its files are; there is nothing to re-point."""
    ws = await make_workspace(client, "pinned", tmp_path)
    write_skill_folder(
        Path(ws["path"]) / ".claude/skills", "pin", name="Pin", description="d", body="b"
    )
    skill = find((await client.get("/skills")).json(), "pin", "local")

    assigned = await client.put(
        f"/skills/{skill['id']}/assignment",
        json={"is_global": True, "workspace_ids": []},
    )
    assert assigned.status_code == 409
    assert "catalog" in assigned.json()["detail"].lower()


async def test_promote_is_refused_from_a_foreign_repo_root(
    client: AsyncClient, tmp_path
) -> None:
    ws = await make_workspace(client, "no-move", tmp_path)
    folder = write_skill_folder(
        Path(ws["path"]) / ".claude/skills", "stay", name="Stay", description="d", body="b"
    )
    skill = find((await client.get("/skills")).json(), "stay", "local")

    promoted = await client.post(f"/skills/{skill['id']}/promote", json={})
    assert promoted.status_code == 409
    assert ".claude" in promoted.json()["detail"]
    assert (folder / "SKILL.md").is_file(), "a git-tracked folder was moved"


# --- Copy -----------------------------------------------------------------------


async def test_copy_duplicates_into_the_catalog_leaving_the_source(
    client: AsyncClient, tmp_path
) -> None:
    ws = await make_workspace(client, "copier", tmp_path)
    folder = write_skill_folder(
        Path(ws["path"]) / ".claude/skills",
        "dup",
        name="Dup",
        description="Original.",
        body="Original body.",
    )
    (folder / "notes.md").write_text("bundled", encoding="utf-8")
    source = find((await client.get("/skills")).json(), "dup", "local")

    copied = await client.post(f"/skills/{source['id']}/copy", json={})
    assert copied.status_code == 200, copied.text
    body = copied.json()
    assert body["id"] != source["id"]
    assert body["origin"] == "managed"
    assert body["root"] == ""
    assert body["is_owned_root"] is True
    # A local source keeps its reach: assigned to the workspace it came from.
    assert body["workspace_ids"] == [ws["id"]]
    assert "notes.md" in body["resources"]
    assert (settings.skills_dir.expanduser() / body["slug"] / "notes.md").is_file()

    # The source is untouched, on disk and in the index.
    assert (folder / "SKILL.md").read_text().count("Original body.") == 1
    still = next(s for s in (await client.get("/skills")).json() if s["id"] == source["id"])
    assert still["origin"] == "local"
    assert still["root"] == ".claude/skills"


async def test_copy_of_a_user_skill_defaults_to_global(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """An external skill was already in scope everywhere; the copy matches it."""
    write_skill_folder(user_root, "mine", name="Mine", description="d", body="b")
    source = find((await client.get("/skills")).json(), "mine", "external")

    copied = await client.post(f"/skills/{source['id']}/copy", json={})
    assert copied.status_code == 200, copied.text
    assert copied.json()["is_global"] is True
    assert (user_root / "mine" / "SKILL.md").is_file()


# --- Delete ---------------------------------------------------------------------


async def test_delete_removes_the_real_folder_in_a_user_root(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """Deleting ``~/.claude/skills/x`` from Lursor removes it from Claude Code too."""
    write_skill_folder(user_root, "doomed", name="Doomed", description="d", body="b")
    skill = find((await client.get("/skills")).json(), "doomed", "external")

    deleted = await client.delete(f"/skills/{skill['id']}")
    assert deleted.status_code == 204
    assert not (user_root / "doomed").exists()


# --- Frontmatter ----------------------------------------------------------------


async def test_patch_preserves_unmodelled_frontmatter(
    client: AsyncClient, tmp_path
) -> None:
    """``allowed-tools`` and friends survive an edit to a file we don't own."""
    ws = await make_workspace(client, "frontmatter", tmp_path)
    folder = Path(ws["path"]) / ".claude" / "skills" / "rich"
    folder.mkdir(parents=True)
    (folder / "SKILL.md").write_text(
        "---\n"
        "name: Rich\n"
        "description: Before.\n"
        "allowed-tools: Bash(git status:*)\n"
        "license: MIT\n"
        "version: 2.1.0\n"
        "---\n\n"
        "Body.\n",
        encoding="utf-8",
    )
    skill = find((await client.get("/skills")).json(), "rich", "local")

    patched = await client.patch(f"/skills/{skill['id']}", json={"description": "After."})
    assert patched.status_code == 200, patched.text

    text = (folder / "SKILL.md").read_text()
    assert "description: After." in text
    assert "allowed-tools: Bash(git status:*)" in text
    assert "license: MIT" in text
    assert "version: 2.1.0" in text
    assert "Body." in text


# --- Store units ----------------------------------------------------------------


def test_root_label_and_ownership() -> None:
    assert store.root_label("") == ""
    assert store.root_label(".agents/skills") == ".agents"
    assert store.root_label(".claude/skills") == ".claude"
    assert store.root_label(".cursor/skills") == ".cursor"
    assert store.root_label(str(Path.home() / ".claude" / "skills")) == "~/.claude"
    assert store.root_label("/opt/shared/skills") == "/opt/shared"

    # A personal root keeps its whole ``~``-relative path: the tail alone is not
    # unique across the configured tools, and two roots sharing a badge would read
    # as one place in the UI.
    assert store.root_label(str(Path.home() / ".agents" / "skills")) == "~/.agents"
    assert (
        store.root_label(str(Path.home() / ".config" / "agents" / "skills"))
        == "~/.config/agents"
    )
    assert (
        store.root_label(str(Path.home() / ".gemini" / "config" / "skills"))
        == "~/.gemini/config"
    )
    # A root sitting directly in the home directory has no dotfolder to name it.
    assert store.root_label(str(Path.home() / "skills")) == "~"

    assert store.is_owned_root("") is True
    assert store.is_owned_root(".agents/skills") is True
    assert store.is_owned_root(".agents/skills/") is True
    assert store.is_owned_root(".claude/skills") is False
    assert store.is_owned_root(str(Path.home() / ".claude" / "skills")) is False
    # ``~/.agents/skills`` is our own convention but still someone else's copy of
    # it: personal roots are read in place, never created or rebuilt from the index.
    assert store.is_owned_root(str(Path.home() / ".agents" / "skills")) is False


def test_shipped_roots_are_labelled_uniquely() -> None:
    """Every root we ship is distinguishable in the UI, and none is a duplicate.

    The badge is the only thing telling a user which tool a discovered skill came
    from, so two roots collapsing to one label would read as one place. Asserted
    against the field defaults rather than the live settings because ``conftest``
    blanks ``user_skill_roots`` to keep the developer's own machine out of the
    other tests.
    """
    fields = Settings.model_fields
    local = [str(r) for r in fields["local_skill_roots"].default]
    user = [str(Path(r).expanduser()) for r in fields["user_skill_roots"].default]

    for keys in (local, user):
        assert len(set(keys)) == len(keys), f"duplicate root in {keys}"
        labels = [store.root_label(k) for k in keys]
        assert all(labels), f"unlabelled root in {keys}"
        assert len(set(labels)) == len(labels), f"duplicate label in {labels}"

    # The cross-tool standard leads both layers, so it wins a slug collision
    # against any single tool's own directory.
    assert local[0] == store.DEFAULT_LOCAL_SKILL_ROOT
    assert user[0] == str(Path.home() / ".agents" / "skills")


def test_path_for_still_rejects_traversal(tmp_path) -> None:
    for bad in ("..", "../outside", "a/b", "", "."):
        with pytest.raises(ValueError):
            store.path_for(bad, tmp_path)


async def test_root_column_backfills_to_the_one_root_there_was(tmp_path) -> None:
    """An existing install's local rows predate roots being plural."""
    import sqlite3

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlmodel import SQLModel

    from app.db import models  # noqa: F401  (registers tables on the metadata)
    from app.db.session import _apply_lightweight_migrations

    path = tmp_path / "pre-root.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
            # Walk `skills` back to the shape it had before this change.
            await conn.execute(text("DROP INDEX IF EXISTS ix_skills_root"))
            await conn.execute(text("ALTER TABLE skills DROP COLUMN root"))
    finally:
        await engine.dispose()

    con = sqlite3.connect(path)
    con.executemany(
        "INSERT INTO skills (id, created_at, updated_at, slug, name, description,"
        " content, origin, is_global, workspace_id)"
        " VALUES (?, datetime('now'), datetime('now'), ?, ?, '', '', ?, ?, ?)",
        [
            ("l1", "repo-skill", "Repo Skill", "local", 0, "ws-1"),
            ("m1", "catalog-skill", "Catalog Skill", "managed", 1, None),
        ],
    )
    con.commit()
    con.close()

    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as conn:
            await _apply_lightweight_migrations(conn)
        async with engine.connect() as conn:
            rows = (
                await conn.execute(text("SELECT id, root FROM skills ORDER BY id"))
            ).all()
    finally:
        await engine.dispose()

    # The local row points at the only root that existed; the catalog row stays
    # on the empty key, and both still resolve exactly as before.
    assert dict(rows) == {"l1": ".agents/skills", "m1": ""}
    assert store.is_owned_root(".agents/skills") is True


def test_symlinked_skill_folder_is_readable(tmp_path) -> None:
    """A hand-maintained ``~/.claude/skills`` is full of symlinks; don't choke."""
    real = tmp_path / "elsewhere" / "linked"
    write_skill_folder(real.parent, "linked", name="Linked", description="d", body="b")
    root = tmp_path / "root"
    root.mkdir()
    (root / "linked").symlink_to(real, target_is_directory=True)

    assert store.list_slugs(root) == ["linked"]
    parsed = store.read_skill("linked", root)
    assert parsed is not None and parsed.name == "Linked"
