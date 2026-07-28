"""Managing a personal skill without taking a copy of it.

Two mechanisms, one goal: a skill in ``~/.claude/skills`` or ``~/.hermes/skills``
should be manageable *as it lies*, so that nothing has to be ingested before it can
be pointed at the right workspaces, and nothing the user edits here drifts from
what the other tool reads.

- **assignment** — an ``external`` row carries reach like a managed one. Newly
  discovered means global (what discovery has always implied), and from there it can
  be narrowed or parked with no files moving anywhere.
- **linking** — ``POST /skills/{id}/link`` symlinks the folder into the catalog, so
  it also appears in the Skill Studio and can be edited there, still writing through
  to the original.

The failure modes worth pinning are the destructive ones: a link must never become a
copy, a delete must never follow a link into somebody else's directory, and a target
that disappears must take its row with it rather than being rebuilt from the index
cache — the catalog is ours to rebuild, but the folder a link names is not.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from httpx import AsyncClient

from app.config import get_settings
from tests.test_skills_ingestion import (
    find,
    make_workspace,
    scoped_slugs,
    write_skill_folder,
)

settings = get_settings()


async def listed(client: AsyncClient) -> list[dict]:
    response = await client.get("/skills")
    assert response.status_code == 200, response.text
    return response.json()


def catalog_entry(slug: str) -> Path:
    return settings.skills_dir.expanduser() / slug


# --- Assignment, with no copy anywhere -------------------------------------------


async def test_a_discovered_personal_skill_applies_everywhere(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """Discovery still means "available", so an upgrade changes nothing about reach."""
    write_skill_folder(user_root, "lk-mine", name="Mine", description="d", body="b")
    ws = await make_workspace(client, "anywhere", tmp_path)

    skill = find(await listed(client), "lk-mine", "external")
    assert skill["is_global"] is True
    assert (await scoped_slugs(client, ws["id"]))["lk-mine"] == "user"


async def test_narrowing_a_personal_skill_moves_no_files(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """The point of the whole change: manage reach without ingesting anything."""
    folder = write_skill_folder(user_root, "lk-narrow", name="Narrow", description="d", body="b")
    here = await make_workspace(client, "here", tmp_path)
    there = await make_workspace(client, "there", tmp_path)
    skill = find(await listed(client), "lk-narrow", "external")

    assigned = await client.put(
        f"/skills/{skill['id']}/assignment",
        json={"is_global": False, "workspace_ids": [here["id"]]},
    )
    assert assigned.status_code == 200, assigned.text
    body = assigned.json()
    assert body["origin"] == "external", "narrowing must not relocate the skill"
    assert body["workspace_ids"] == [here["id"]]

    assert "lk-narrow" in await scoped_slugs(client, here["id"])
    assert "lk-narrow" not in await scoped_slugs(client, there["id"])
    # Still exactly where the other tool put it, and nowhere else.
    assert (folder / "SKILL.md").is_file()
    assert not catalog_entry("lk-narrow").exists()


async def test_parking_a_personal_skill_takes_it_out_of_every_run(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """Assigned nowhere is a real state for a personal skill now, not just a managed one."""
    write_skill_folder(user_root, "lk-parked", name="Parked", description="d", body="b")
    ws = await make_workspace(client, "parking", tmp_path)
    skill = find(await listed(client), "lk-parked", "external")

    assigned = await client.put(
        f"/skills/{skill['id']}/assignment",
        json={"is_global": False, "workspace_ids": []},
    )
    assert assigned.status_code == 200, assigned.text
    assert "lk-parked" not in await scoped_slugs(client, ws["id"])
    # Parked, not deleted: still listed and still on disk.
    assert find(await listed(client), "lk-parked", "external")["is_global"] is False


async def test_a_narrowed_personal_skill_still_loses_to_your_own(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """Assigning one deliberately doesn't promote it past a skill you wrote."""
    write_skill_folder(user_root, "lk-clash", name="Clash", description="Theirs.", body="b")
    ws = await make_workspace(client, "collide", tmp_path)
    skill = find(await listed(client), "lk-clash", "external")
    await client.put(
        f"/skills/{skill['id']}/assignment",
        json={"is_global": False, "workspace_ids": [ws["id"]]},
    )
    # Named to slugify onto the personal one — the collision is what's under test.
    created = await client.post(
        "/skills",
        json={
            "name": "lk-clash",
            "description": "Mine.",
            "content": "b",
            "is_global": True,
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["slug"] == "lk-clash"

    scoped = await client.get(
        "/skills", params={"assignment": "workspace", "workspace_id": ws["id"]}
    )
    winners = [s for s in scoped.json() if s["slug"] == "lk-clash"]
    assert len(winners) == 1
    assert winners[0]["layer"] == "global"
    assert winners[0]["description"] == "Mine."


# --- Linking ---------------------------------------------------------------------


async def test_link_points_the_catalog_at_the_original(
    client: AsyncClient, tmp_path, user_root
) -> None:
    folder = write_skill_folder(
        user_root, "lk-linkme", name="Link Me", description="d", body="Body."
    )
    (folder / "notes.md").write_text("bundled", encoding="utf-8")
    skill = find(await listed(client), "lk-linkme", "external")

    linked = await client.post(f"/skills/{skill['id']}/link", json={})
    assert linked.status_code == 200, linked.text
    body = linked.json()
    assert body["id"] == skill["id"], "linking re-points the row, it doesn't duplicate it"
    assert body["origin"] == "managed"
    assert body["link_target"] == str(folder.resolve())
    assert body["link_label"]
    assert "notes.md" in body["resources"]

    entry = catalog_entry(body["slug"])
    assert entry.is_symlink(), "the catalog entry must be a link, not a copy"
    assert entry.resolve() == folder.resolve()


async def test_a_linked_skill_is_indexed_once(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """One SKILL.md must not become two rows with two enable switches over it."""
    write_skill_folder(user_root, "lk-once", name="Once", description="d", body="b")
    skill = find(await listed(client), "lk-once", "external")
    await client.post(f"/skills/{skill['id']}/link", json={})

    rows = [s for s in await listed(client) if s["name"] == "Once"]
    assert len(rows) == 1, rows
    assert rows[0]["origin"] == "managed"


async def test_link_keeps_the_reach_it_already_had(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """Linking changes where a skill is managed from, not where it applies."""
    write_skill_folder(user_root, "lk-keep", name="Keep", description="d", body="b")
    ws = await make_workspace(client, "keeper", tmp_path)
    skill = find(await listed(client), "lk-keep", "external")
    await client.put(
        f"/skills/{skill['id']}/assignment",
        json={"is_global": False, "workspace_ids": [ws["id"]]},
    )

    linked = await client.post(f"/skills/{skill['id']}/link", json={})
    assert linked.status_code == 200, linked.text
    assert linked.json()["is_global"] is False
    assert linked.json()["workspace_ids"] == [ws["id"]]
    # Now at the catalog's precedence, since that is where it is managed from.
    assert (await scoped_slugs(client, ws["id"]))["lk-keep"] == "workspace"


async def test_editing_a_linked_skill_writes_through_to_the_original(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """The reason to link rather than copy: one file, no drift."""
    folder = write_skill_folder(
        user_root, "lk-shared", name="Shared", description="Before.", body="b"
    )
    skill = find(await listed(client), "lk-shared", "external")
    linked = (await client.post(f"/skills/{skill['id']}/link", json={})).json()

    patched = await client.patch(
        f"/skills/{linked['id']}", json={"description": "After."}
    )
    assert patched.status_code == 200, patched.text
    assert "After." in (folder / "SKILL.md").read_text(encoding="utf-8")


async def test_a_linked_skill_reaches_the_agent(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """The whole point, checked at the layer that matters: what a run loads.

    ``skill_dirs`` hands over the link, and the agent's own discovery resolves it —
    so the folder must both be the catalog entry and read as the real skill.
    """
    from app.db.session import async_session_factory
    from app.skills.resolve import skill_dirs, skills_in_scope

    folder = write_skill_folder(
        user_root, "lk-runtime", name="Runtime", description="d", body="Do the thing."
    )
    ws = await make_workspace(client, "runner", tmp_path)
    skill = find(await listed(client), "lk-runtime", "external")
    linked = (await client.post(f"/skills/{skill['id']}/link", json={})).json()

    async with async_session_factory() as session:
        scoped = await skills_in_scope(
            session, workspace_path=ws["path"], workspace_id=ws["id"]
        )
    dirs = [Path(d) for d in skill_dirs(scoped) if Path(d).name == linked["slug"]]
    assert len(dirs) == 1, dirs
    handed = dirs[0]
    assert handed == catalog_entry(linked["slug"]), "the link is what gets handed over"
    assert handed.resolve() == folder.resolve(), "and it resolves to the original"
    assert "Do the thing." in (handed / "SKILL.md").read_text(encoding="utf-8")


async def test_link_is_refused_for_a_repo_skill(client: AsyncClient, tmp_path) -> None:
    """A link into a working tree would die the moment the repo moved."""
    ws = await make_workspace(client, "repo-link", tmp_path)
    write_skill_folder(
        Path(ws["path"]) / ".claude/skills", "lk-repo", name="Repo", description="d", body="b"
    )
    skill = find(await listed(client), "lk-repo", "local")

    refused = await client.post(f"/skills/{skill['id']}/link", json={})
    assert refused.status_code == 409
    assert "copy" in refused.json()["detail"].lower()


async def test_linking_twice_is_refused(client: AsyncClient, tmp_path, user_root) -> None:
    write_skill_folder(user_root, "lk-twice", name="Twice", description="d", body="b")
    skill = find(await listed(client), "lk-twice", "external")
    first = await client.post(f"/skills/{skill['id']}/link", json={})
    assert first.status_code == 200, first.text

    again = await client.post(f"/skills/{skill['id']}/link", json={})
    assert again.status_code == 409
    assert "linked" in again.json()["detail"].lower()


# --- Auto-linking, which is how it actually happens ------------------------------


async def test_discovered_skills_are_linked_without_being_asked(
    client: AsyncClient, tmp_path, user_root, auto_link
) -> None:
    """The catalog ends up holding every skill, so the Studio's tree shows them all."""
    for slug in ("lk-auto-one", "lk-auto-two"):
        write_skill_folder(user_root, slug, name=slug, description="d", body="b")

    rows = {s["slug"]: s for s in await listed(client)}
    for slug in ("lk-auto-one", "lk-auto-two"):
        row = rows[slug]
        assert row["origin"] == "managed", "still needs ingesting to be managed"
        assert row["link_target"] == str((user_root / slug).resolve())
        assert row["is_global"] is True, "discovery still means available"
        entry = catalog_entry(slug)
        assert entry.is_symlink(), "auto-link copied instead of pointing"
        assert entry.resolve() == (user_root / slug).resolve()


async def test_auto_link_leaves_a_shadowed_skill_alone(
    client: AsyncClient, tmp_path, user_root, auto_link
) -> None:
    """A personal skill your own catalog overrides must not become a second skill.

    It loses the slug collision today, so linking it as ``foo-2`` would quietly
    turn one active skill into two that both load.
    """
    created = await client.post(
        "/skills",
        json={"name": "lk-shadow", "description": "Mine.", "content": "b", "is_global": True},
    )
    assert created.status_code == 201, created.text
    write_skill_folder(user_root, "lk-shadow", name="Theirs", description="d", body="b")
    ws = await make_workspace(client, "shadowed", tmp_path)

    rows = [s for s in await listed(client) if s["slug"] == "lk-shadow"]
    assert len(rows) == 2, rows
    theirs = find(rows, "lk-shadow", "external")
    assert theirs["link_target"] == "", "a shadowed skill was linked anyway"
    # And the catalog one still wins, exactly as before.
    scoped = await scoped_slugs(client, ws["id"])
    assert scoped["lk-shadow"] == "global"


async def test_auto_link_survives_a_root_that_disappears(
    client: AsyncClient, tmp_path, user_root, auto_link, monkeypatch
) -> None:
    """Unplugging the directory still degrades to "those skills are gone"."""
    folder = write_skill_folder(
        user_root, "lk-auto-gone", name="Gone", description="d", body="b"
    )
    await listed(client)  # a listing is what reconciles, and so what links
    assert catalog_entry("lk-auto-gone").is_symlink()

    shutil.rmtree(folder)
    rows = await listed(client)
    assert not any(s["slug"] == "lk-auto-gone" for s in rows)
    assert not catalog_entry("lk-auto-gone").exists(), "a dead link was left behind"


async def test_auto_link_off_leaves_skills_discovered(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """With the setting off nothing is written to the catalog — just not in the tree."""
    write_skill_folder(user_root, "lk-manual", name="Manual", description="d", body="b")

    row = find(await listed(client), "lk-manual", "external")
    assert row["link_target"] == ""
    assert not catalog_entry("lk-manual").exists()
    # Still fully managed, which is the half that needs no link at all.
    assert row["is_global"] is True


# --- The destructive edges -------------------------------------------------------


async def test_a_link_whose_target_is_gone_is_dropped_not_rebuilt(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """The catalog is ours to rebuild; the folder a link names is not.

    Without the per-row rule this is the crash: reconcile would try to materialize
    the cached content over a dangling symlink and ``mkdir`` would raise.
    """
    folder = write_skill_folder(user_root, "lk-doomed", name="Doomed", description="d", body="b")
    skill = find(await listed(client), "lk-doomed", "external")
    linked = (await client.post(f"/skills/{skill['id']}/link", json={})).json()
    entry = catalog_entry(linked["slug"])
    assert entry.is_symlink()

    # The other tool deletes it.
    (folder / "SKILL.md").unlink()
    folder.rmdir()

    rows = await listed(client)
    assert not any(s["id"] == linked["id"] for s in rows), "a dead link kept its row"
    assert not entry.is_symlink(), "a dangling link was left in the catalog"
    assert not entry.exists(), "the index cache was materialized over a dead link"


async def test_deleting_a_linked_skill_deletes_the_original(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """Delete keeps one meaning: the folder goes, in the other tool too.

    Removing only the link would be undone by the next reconcile once discovery
    links automatically, so a delete that *looked* safe would silently be a no-op.
    The confirmation names the absolute path for exactly this reason.
    """
    folder = write_skill_folder(
        user_root, "lk-unlink", name="Unlink", description="d", body="b"
    )
    skill = find(await listed(client), "lk-unlink", "external")
    linked = (await client.post(f"/skills/{skill['id']}/link", json={})).json()

    deleted = await client.delete(f"/skills/{linked['id']}")
    assert deleted.status_code == 204
    assert not folder.exists(), "the original survived a delete"
    assert not catalog_entry(linked["slug"]).is_symlink()
    assert not any(s["slug"] == "lk-unlink" for s in await listed(client))


async def test_a_link_dropped_into_the_catalog_by_hand_is_recognized(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """Indexing records the link, so the folder is never treated as ours to rebuild."""
    folder = write_skill_folder(user_root, "lk-byhand", name="By Hand", description="d", body="b")
    monkeyed = catalog_entry("lk-byhand-manual")
    monkeyed.parent.mkdir(parents=True, exist_ok=True)
    monkeyed.symlink_to(folder.resolve(), target_is_directory=True)

    row = find(await listed(client), "lk-byhand-manual", "managed")
    assert row["link_target"] == str(folder.resolve())
    # And it gets the foreign-root rule: the target going away drops the row.
    (folder / "SKILL.md").unlink()
    folder.rmdir()
    assert not any(s["slug"] == "lk-byhand-manual" for s in await listed(client))


# --- The Skill Studio file tree --------------------------------------------------


async def studio_id(client: AsyncClient) -> str:
    """The catalog registered as a workspace, which is what the Studio browses.

    Normally done once in the app lifespan, which the ASGI test transport doesn't
    run — and being *at that path* is the whole definition (``is_skills_catalog``),
    so creating it here yields the same workspace the app would have.
    """
    catalog = str(settings.skills_dir.expanduser().resolve())
    for ws in (await client.get("/workspaces")).json():
        if ws["is_system"]:
            return ws["id"]
    created = await client.post(
        "/workspaces", json={"name": "Skill Studio", "path": catalog}
    )
    assert created.status_code == 201, created.text
    assert created.json()["is_system"] is True
    return created.json()["id"]


async def test_the_studio_tree_says_where_each_skill_came_from(
    client: AsyncClient, tmp_path, user_root, auto_link, monkeypatch
) -> None:
    """A flat directory of links is unreadable unless each row names its source.

    Three sources at once, which is the case that matters: two different tools and
    the catalog's own. Nested rows stay unlabelled — the folder above them already
    said it, and repeating it down the tree is noise.
    """
    hermes = tmp_path / "home-hermes" / "skills"
    hermes.mkdir(parents=True)
    monkeypatch.setattr(
        settings, "user_skill_roots", [str(user_root), str(hermes)], raising=False
    )
    write_skill_folder(user_root, "lk-src-claude", name="C", description="d", body="b")
    write_skill_folder(hermes, "lk-src-hermes", name="H", description="d", body="b")
    created = await client.post(
        "/skills",
        json={"name": "lk-src-own", "description": "d", "content": "b", "is_global": True},
    )
    assert created.status_code == 201, created.text

    await listed(client)  # a listing is what reconciles, and so what links
    ws_id = await studio_id(client)
    listing = await client.get(f"/workspaces/{ws_id}/files/list")
    assert listing.status_code == 200, listing.text
    by_name = {e["name"]: e for e in listing.json()}

    claude = by_name["lk-src-claude"]
    assert claude["source_label"] == "~/home-claude" or claude["source_label"].endswith(
        "home-claude"
    ), claude
    assert claude["link_target"] == str((user_root / "lk-src-claude").resolve())

    assert by_name["lk-src-hermes"]["link_target"] == str(
        (hermes / "lk-src-hermes").resolve()
    )
    assert (
        by_name["lk-src-hermes"]["source_label"]
        != by_name["lk-src-claude"]["source_label"]
    ), "two tools must not collapse into one label"

    own = by_name["lk-src-own"]
    assert own["link_target"] == "", "a real catalog folder is not a link"
    assert own["source_label"] == "Lursor"

    # Inside a linked skill there is nothing left to say.
    nested = await client.get(
        f"/workspaces/{ws_id}/files/list", params={"path": "lk-src-claude"}
    )
    assert nested.status_code == 200, nested.text
    assert all(e["source_label"] == "" for e in nested.json()), nested.json()


async def test_an_ordinary_workspace_tree_carries_no_source_labels(
    client: AsyncClient, tmp_path
) -> None:
    """The grouping is the catalog's problem; every other tree renders as before."""
    ws = await make_workspace(client, "plain-tree", tmp_path)
    (Path(ws["path"]) / "src").mkdir()
    (Path(ws["path"]) / "README.md").write_text("hi", encoding="utf-8")

    listing = await client.get(f"/workspaces/{ws['id']}/files/list")
    assert listing.status_code == 200, listing.text
    entries = listing.json()
    assert entries
    assert all(e["source_label"] == "" and e["link_target"] == "" for e in entries)


async def test_the_studio_tree_reads_and_writes_through_a_link(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """The catalog is a workspace, so a linked entry has to be browsable in it."""
    folder = write_skill_folder(
        user_root, "lk-browse", name="Browse", description="d", body="Body."
    )
    (folder / "notes.md").write_text("bundled", encoding="utf-8")
    skill = find(await listed(client), "lk-browse", "external")
    linked = (await client.post(f"/skills/{skill['id']}/link", json={})).json()
    slug, ws_id = linked["slug"], await studio_id(client)

    tree = await client.get(
        f"/workspaces/{ws_id}/files/list", params={"path": slug}
    )
    assert tree.status_code == 200, tree.text
    assert {e["name"] for e in tree.json()} >= {"SKILL.md", "notes.md"}
    assert all(e["path"].startswith(f"{slug}/") for e in tree.json())

    read = await client.get(
        f"/workspaces/{ws_id}/files/read", params={"path": f"{slug}/notes.md"}
    )
    assert read.status_code == 200, read.text
    assert read.json()["content"] == "bundled"

    wrote = await client.put(
        f"/workspaces/{ws_id}/files/write",
        json={"path": f"{slug}/notes.md", "content": "edited"},
    )
    assert wrote.status_code == 200, wrote.text
    assert (folder / "notes.md").read_text(encoding="utf-8") == "edited"


@pytest.mark.parametrize(
    "path",
    [
        "../escape.txt",
        "../../etc/hosts",
        "/etc/hosts",
    ],
)
async def test_the_studio_tree_still_refuses_a_real_escape(
    client: AsyncClient, tmp_path, path
) -> None:
    """The link exception must not have become a hole for everything else."""
    ws_id = await studio_id(client)
    (settings.skills_dir.expanduser().parent / "escape.txt").write_text("no", encoding="utf-8")

    read = await client.get(f"/workspaces/{ws_id}/files/read", params={"path": path})
    assert read.status_code == 400, read.text


async def test_a_link_below_the_top_level_is_still_refused(
    client: AsyncClient, tmp_path, user_root
) -> None:
    """Only an entry Lursor itself links is admitted, not any link at any depth."""
    secret = tmp_path / "outside"
    secret.mkdir()
    (secret / "secret.txt").write_text("no", encoding="utf-8")
    folder = write_skill_folder(user_root, "lk-deep", name="Deep", description="d", body="b")
    skill = find(await listed(client), "lk-deep", "external")
    linked = (await client.post(f"/skills/{skill['id']}/link", json={})).json()
    # A link *inside* the linked skill folder points somewhere we never sanctioned.
    (folder / "sneaky").symlink_to(secret, target_is_directory=True)

    read = await client.get(
        f"/workspaces/{await studio_id(client)}/files/read",
        params={"path": f"{linked['slug']}/sneaky/secret.txt"},
    )
    assert read.status_code == 400, read.text
