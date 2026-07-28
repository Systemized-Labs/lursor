"""Ingesting a skill folder that is already on disk in a workspace.

The gap: a skill folder only gets discovered when it sits in a configured root,
so a vendored ``skills/`` directory or a collection cloned into a repo is visible
in the file tree and invisible to the manager. ``GET /skills/scan`` +
``POST /skills/ingest`` are the file explorer's right-click answer to that.

What is pinned here is mostly what ingest must *not* do: never move or mutate the
source folder (it is part of someone's repo), never escape the workspace root on
a client-supplied path, and never copy a folder onto itself when the destination
root lives inside the folder being ingested.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from httpx import AsyncClient

from app.config import get_settings
from app.skills import store

settings = get_settings()

SKILL_MD = "---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"


def write_skill_folder(root: Path, slug: str, *, name: str, description: str = "d") -> Path:
    folder = root / slug
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(
        SKILL_MD.format(name=name, description=description, body="Body."),
        encoding="utf-8",
    )
    return folder


async def make_workspace(client: AsyncClient, name: str, tmp_path: Path) -> dict:
    path = tmp_path / name
    path.mkdir(parents=True, exist_ok=True)
    response = await client.post("/workspaces", json={"name": name, "path": str(path)})
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture(autouse=True)
def isolated_catalog(tmp_path, monkeypatch):
    """A throwaway catalog per test, so slug de-duplication is deterministic.

    ``get_settings`` is ``lru_cache``d, so the live object is patched in place —
    that is the instance every request reads.
    """
    catalog = tmp_path / "catalog"
    catalog.mkdir()
    monkeypatch.setattr(settings, "skills_dir", catalog, raising=False)
    return catalog


# --- Scan -----------------------------------------------------------------------


async def test_scan_finds_skill_folders_anywhere_in_the_tree(
    client: AsyncClient, tmp_path
) -> None:
    ws = await make_workspace(client, "repo", tmp_path)
    root = Path(ws["path"])
    write_skill_folder(root / "vendor" / "skills", "pdf-tools", name="PDF Tools")
    write_skill_folder(root / "vendor" / "skills", "xlsx", name="XLSX")

    response = await client.get(
        "/skills/scan", params={"workspace_id": ws["id"], "path": "vendor/skills"}
    )
    assert response.status_code == 200, response.text
    found = response.json()["skills"]
    assert [s["slug"] for s in found] == ["pdf-tools", "xlsx"]
    assert found[0]["path"] == "vendor/skills/pdf-tools"
    assert found[0]["name"] == "PDF Tools"


async def test_scan_of_a_skill_folder_itself_returns_just_it(
    client: AsyncClient, tmp_path
) -> None:
    """Right-clicking the skill folder, not its parent, is the common case."""
    ws = await make_workspace(client, "repo-single", tmp_path)
    write_skill_folder(Path(ws["path"]) / "docs", "notes", name="Notes")

    response = await client.get(
        "/skills/scan", params={"workspace_id": ws["id"], "path": "docs/notes"}
    )
    assert response.status_code == 200, response.text
    assert [s["slug"] for s in response.json()["skills"]] == ["notes"]


async def test_scan_of_an_ordinary_folder_finds_nothing(
    client: AsyncClient, tmp_path
) -> None:
    """The menu entry hangs off this: no skills here means no action offered."""
    ws = await make_workspace(client, "repo-empty", tmp_path)
    (Path(ws["path"]) / "src").mkdir()

    response = await client.get(
        "/skills/scan", params={"workspace_id": ws["id"], "path": "src"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["skills"] == []


async def test_scan_prunes_generated_directories(client: AsyncClient, tmp_path) -> None:
    """A SKILL.md inside node_modules is a dependency's, not the user's."""
    ws = await make_workspace(client, "repo-noise", tmp_path)
    write_skill_folder(
        Path(ws["path"]) / "node_modules" / "pkg", "vendored", name="Vendored"
    )

    response = await client.get(
        "/skills/scan", params={"workspace_id": ws["id"], "path": ""}
    )
    assert response.status_code == 200, response.text
    assert response.json()["skills"] == []


async def test_scan_marks_an_already_discovered_folder(
    client: AsyncClient, tmp_path
) -> None:
    """``.claude/skills`` is discovered, so ingesting it would duplicate it."""
    ws = await make_workspace(client, "repo-claude", tmp_path)
    root = Path(ws["path"])
    write_skill_folder(root / ".claude" / "skills", "known", name="Known")
    write_skill_folder(root / "vendor", "unknown", name="Unknown")

    response = await client.get(
        "/skills/scan", params={"workspace_id": ws["id"], "path": ""}
    )
    assert response.status_code == 200, response.text
    by_slug = {s["slug"]: s for s in response.json()["skills"]}
    assert by_slug["known"]["indexed"] is True
    assert by_slug["unknown"]["indexed"] is False


async def test_scan_marks_a_skill_ingested_earlier_as_managed(
    client: AsyncClient, tmp_path
) -> None:
    """Ingesting into the repo's own root makes the copy discoverable, once."""
    ws = await make_workspace(client, "repo-twice", tmp_path)
    write_skill_folder(Path(ws["path"]) / "vendor", "twice", name="Twice")

    ingested = await client.post(
        "/skills/ingest",
        json={"workspace_id": ws["id"], "path": "vendor/twice", "origin": "local"},
    )
    assert ingested.status_code == 201, ingested.text

    response = await client.get(
        "/skills/scan", params={"workspace_id": ws["id"], "path": ".agents/skills"}
    )
    assert response.status_code == 200, response.text
    assert [s["indexed"] for s in response.json()["skills"]] == [True]


async def test_ingest_refuses_an_already_discovered_folder(
    client: AsyncClient, tmp_path, isolated_catalog
) -> None:
    ws = await make_workspace(client, "ingest-known", tmp_path)
    write_skill_folder(Path(ws["path"]) / ".claude" / "skills", "known", name="Known")
    # Index it, which is what discovery does the first time skills are listed.
    listed = await client.get("/skills")
    assert listed.status_code == 200, listed.text

    response = await client.post(
        "/skills/ingest",
        json={"workspace_id": ws["id"], "path": ".claude/skills/known"},
    )
    assert response.status_code == 400, response.text
    assert "Already in" in response.json()["detail"]
    assert "known" not in store.list_slugs(isolated_catalog)


async def test_a_top_level_skills_folder_is_already_discovered(
    client: AsyncClient, tmp_path
) -> None:
    """``<repo>/skills`` is a configured root, so it needs no ingesting.

    Pinned because it's the folder a user is most likely to right-click, and the
    honest answer there is "already handled", not a second copy.
    """
    ws = await make_workspace(client, "repo-bare-skills", tmp_path)
    write_skill_folder(Path(ws["path"]) / "skills", "bare", name="Bare")

    scanned = await client.get(
        "/skills/scan", params={"workspace_id": ws["id"], "path": "skills"}
    )
    assert scanned.status_code == 200, scanned.text
    assert [s["indexed"] for s in scanned.json()["skills"]] == [True]

    response = await client.post(
        "/skills/ingest", json={"workspace_id": ws["id"], "path": "skills"}
    )
    assert response.status_code == 400, response.text


async def test_ingest_skips_discovered_folders_but_takes_the_rest(
    client: AsyncClient, tmp_path, isolated_catalog
) -> None:
    """Ingesting a whole tree takes what isn't managed and leaves what is."""
    ws = await make_workspace(client, "ingest-mixed", tmp_path)
    root = Path(ws["path"])
    write_skill_folder(root / ".claude" / "skills", "managed", name="Managed")
    write_skill_folder(root / "vendor", "loose", name="Loose")

    response = await client.post(
        "/skills/ingest", json={"workspace_id": ws["id"], "path": ""}
    )
    assert response.status_code == 201, response.text
    assert [s["slug"] for s in response.json()] == ["loose"]
    catalog = store.list_slugs(isolated_catalog)
    assert "loose" in catalog and "managed" not in catalog


async def test_scan_rejects_a_path_escaping_the_workspace(
    client: AsyncClient, tmp_path
) -> None:
    ws = await make_workspace(client, "repo-escape", tmp_path)
    response = await client.get(
        "/skills/scan", params={"workspace_id": ws["id"], "path": "../.."}
    )
    assert response.status_code == 400, response.text


async def test_scan_404s_for_a_missing_folder(client: AsyncClient, tmp_path) -> None:
    ws = await make_workspace(client, "repo-missing", tmp_path)
    response = await client.get(
        "/skills/scan", params={"workspace_id": ws["id"], "path": "nope"}
    )
    assert response.status_code == 404, response.text


# --- Ingest --------------------------------------------------------------------


async def test_ingest_copies_into_the_catalog_scoped_to_the_workspace(
    client: AsyncClient, tmp_path, isolated_catalog
) -> None:
    ws = await make_workspace(client, "ingest-catalog", tmp_path)
    src = write_skill_folder(
        Path(ws["path"]) / "vendor" / "skills", "pdf-tools", name="PDF Tools"
    )
    (src / "scripts").mkdir()
    (src / "scripts" / "fill.py").write_text("print('hi')\n", encoding="utf-8")

    response = await client.post(
        "/skills/ingest",
        json={"workspace_id": ws["id"], "path": "vendor/skills/pdf-tools"},
    )
    assert response.status_code == 201, response.text
    [created] = response.json()
    assert created["origin"] == "managed"
    assert created["is_global"] is False
    # A skill found in a repo is about that repo: assigned there, not everywhere.
    assert created["workspace_ids"] == [ws["id"]]
    # Bundled files come along.
    assert created["scripts"] == ["scripts/fill.py"]
    assert (isolated_catalog / "pdf-tools" / "SKILL.md").is_file()
    # The source is untouched — it is part of the repo.
    assert (src / "SKILL.md").is_file()


async def test_ingest_can_assign_globally(client: AsyncClient, tmp_path) -> None:
    ws = await make_workspace(client, "ingest-global", tmp_path)
    write_skill_folder(
        Path(ws["path"]) / "vendor" / "skills", "everywhere", name="Everywhere"
    )

    response = await client.post(
        "/skills/ingest",
        json={"workspace_id": ws["id"], "path": "vendor/skills", "is_global": True},
    )
    assert response.status_code == 201, response.text
    [created] = response.json()
    assert created["is_global"] is True
    assert created["workspace_ids"] == []


async def test_ingest_a_folder_of_several_skills(client: AsyncClient, tmp_path) -> None:
    ws = await make_workspace(client, "ingest-many", tmp_path)
    root = Path(ws["path"]) / "collection"
    write_skill_folder(root, "one", name="One")
    write_skill_folder(root, "two", name="Two")

    response = await client.post(
        "/skills/ingest", json={"workspace_id": ws["id"], "path": "collection"}
    )
    assert response.status_code == 201, response.text
    assert sorted(s["slug"] for s in response.json()) == ["one", "two"]


async def test_ingest_local_writes_into_the_repos_own_root(
    client: AsyncClient, tmp_path
) -> None:
    ws = await make_workspace(client, "ingest-local", tmp_path)
    root = Path(ws["path"])
    src = write_skill_folder(root / "vendor", "repo-skill", name="Repo Skill")

    response = await client.post(
        "/skills/ingest",
        json={"workspace_id": ws["id"], "path": "vendor/repo-skill", "origin": "local"},
    )
    assert response.status_code == 201, response.text
    [created] = response.json()
    assert created["origin"] == "local"
    assert created["workspace_id"] == ws["id"]
    assert created["root"] == store.DEFAULT_LOCAL_SKILL_ROOT
    assert (root / ".agents" / "skills" / "repo-skill" / "SKILL.md").is_file()
    assert (src / "SKILL.md").is_file()  # copied, not moved


async def test_ingest_de_duplicates_a_slug_already_in_the_destination(
    client: AsyncClient, tmp_path, isolated_catalog
) -> None:
    ws = await make_workspace(client, "ingest-dupe", tmp_path)
    # Two different skills that happen to share a folder name — identical ones are
    # refused as duplicates instead (see the ingest-twice test below).
    write_skill_folder(Path(ws["path"]) / "a", "notes", name="Notes", description="one")
    write_skill_folder(Path(ws["path"]) / "b", "notes", name="Notes", description="two")

    first = await client.post(
        "/skills/ingest", json={"workspace_id": ws["id"], "path": "a/notes"}
    )
    second = await client.post(
        "/skills/ingest", json={"workspace_id": ws["id"], "path": "b/notes"}
    )
    assert first.status_code == 201 and second.status_code == 201, second.text
    assert first.json()[0]["slug"] == "notes"
    assert second.json()[0]["slug"] == "notes-2"
    assert (isolated_catalog / "notes-2" / "SKILL.md").is_file()


async def test_ingesting_the_same_folder_twice_is_refused(
    client: AsyncClient, tmp_path, isolated_catalog
) -> None:
    """Ingest copies and leaves the source in place, so the source stays unindexed.

    Nothing about that folder changes when it is ingested, so without matching on
    what the skill *says* a second right-click would happily leave ``demo`` and
    ``demo-2`` in the catalog.
    """
    ws = await make_workspace(client, "ingest-twice-refused", tmp_path)
    write_skill_folder(Path(ws["path"]) / "vendor", "demo", name="Demo")

    first = await client.post(
        "/skills/ingest", json={"workspace_id": ws["id"], "path": "vendor/demo"}
    )
    assert first.status_code == 201, first.text

    scanned = await client.get(
        "/skills/scan", params={"workspace_id": ws["id"], "path": "vendor/demo"}
    )
    assert scanned.status_code == 200, scanned.text
    assert [s["indexed"] for s in scanned.json()["skills"]] == [True]

    second = await client.post(
        "/skills/ingest", json={"workspace_id": ws["id"], "path": "vendor/demo"}
    )
    assert second.status_code == 400, second.text
    assert "demo-2" not in store.list_slugs(isolated_catalog)


async def test_ingest_of_a_folder_with_no_skill_is_a_400(
    client: AsyncClient, tmp_path
) -> None:
    ws = await make_workspace(client, "ingest-none", tmp_path)
    (Path(ws["path"]) / "src").mkdir()

    response = await client.post(
        "/skills/ingest", json={"workspace_id": ws["id"], "path": "src"}
    )
    assert response.status_code == 400, response.text
    assert "SKILL.md" in response.json()["detail"]


async def test_ingest_local_skips_folders_already_in_the_destination(
    client: AsyncClient, tmp_path
) -> None:
    """Ingesting a tree that *contains* .agents/skills must not copy it onto itself."""
    ws = await make_workspace(client, "ingest-self", tmp_path)
    root = Path(ws["path"])
    write_skill_folder(root / ".agents" / "skills", "already", name="Already")

    response = await client.post(
        "/skills/ingest",
        json={"workspace_id": ws["id"], "path": ".agents/skills", "origin": "local"},
    )
    assert response.status_code == 400, response.text
    assert "Already in" in response.json()["detail"]
    # Nothing was duplicated inside itself.
    assert store.list_slugs(root / ".agents" / "skills") == ["already"]


async def test_ingest_rejects_a_path_escaping_the_workspace(
    client: AsyncClient, tmp_path
) -> None:
    ws = await make_workspace(client, "ingest-escape", tmp_path)
    response = await client.post(
        "/skills/ingest", json={"workspace_id": ws["id"], "path": "../../etc"}
    )
    assert response.status_code in (400, 404), response.text


async def test_ingest_into_an_external_root_is_refused(
    client: AsyncClient, tmp_path
) -> None:
    """Personal directories belong to another tool; ingest never writes there."""
    ws = await make_workspace(client, "ingest-external", tmp_path)
    write_skill_folder(Path(ws["path"]) / "vendor", "nope", name="Nope")

    response = await client.post(
        "/skills/ingest",
        json={"workspace_id": ws["id"], "path": "vendor", "origin": "external"},
    )
    assert response.status_code == 400, response.text


async def test_ingested_skill_is_in_scope_for_its_workspace(
    client: AsyncClient, tmp_path
) -> None:
    """The point of the whole action: the agent running there now loads it."""
    ws = await make_workspace(client, "ingest-scope", tmp_path)
    write_skill_folder(Path(ws["path"]) / "vendor", "scoped", name="Scoped")

    ingested = await client.post(
        "/skills/ingest", json={"workspace_id": ws["id"], "path": "vendor/scoped"}
    )
    assert ingested.status_code == 201, ingested.text

    listed = await client.get(
        "/skills", params={"assignment": "workspace", "workspace_id": ws["id"]}
    )
    assert listed.status_code == 200, listed.text
    scoped = {s["slug"]: s["layer"] for s in listed.json()}
    assert scoped.get("scoped") == "workspace"
