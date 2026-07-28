"""One unreadable SKILL.md must not take the whole app down with it.

This is the shape of a real outage. A skill in ``~/.claude/skills`` — written by
another tool, never opened in Lursor — had an unquoted ``description:`` whose
value itself contained a colon. Valid enough for the tool that wrote it; not
valid YAML. ``pydantic_deep`` parses frontmatter strictly and *raises*
``SkillValidationError`` from ``SkillsDirectory``, which propagated out of
``create_deep_agent``, failed the agent build, and returned a bare 500 from
``POST /threads/{id}/chat``. Every message in every workspace, dead, because of
one file the user didn't write and couldn't see was broken.

Three properties keep that from happening again, and each is tested here:

- **Scope excludes it** — the resolver drops a folder it knows the agent can't
  parse, so the blast radius is the one skill rather than the run.
- **The library can't fail the build anyway** — the directories are constructed
  with ``validate=False``, so even a file that breaks *between* resolution and
  the build (or reaches the library by another path) is skipped with a warning.
- **The user is told** — the skill stays listed and editable, carrying the parse
  error, so a skill that silently stopped applying says why.

The fourth property — that a failed build reports as JSON with CORS headers
rather than as an unreadable 500 — lives in ``test_error_responses.py``, since it
is about every error and not only this one.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from httpx import AsyncClient

from app.agents.builder import _skill_directories
from app.agents.skill_runtime import load_skill_runtime
from app.db.session import async_session_factory
from app.skills import store
from app.skills.resolve import skills_in_scope

# The exact frontmatter that caused the outage: an unquoted scalar containing
# ": ", which YAML reads as a nested mapping key.
BROKEN_SKILL_MD = (
    "---\n"
    "name: playable-ads\n"
    "description: Convert web games into ads. Covers the playbook for Vite builds: "
    "auditing CDNs, gating them behind a flag.\n"
    "---\n\n"
    "Body.\n"
)

GOOD_SKILL_MD = "---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"


def write_skill_folder(root: Path, slug: str, content: str) -> Path:
    folder = root / slug
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(content, encoding="utf-8")
    return folder


def write_good(root: Path, slug: str, *, body: str = "Body.") -> Path:
    return write_skill_folder(
        root,
        slug,
        GOOD_SKILL_MD.format(name=slug, description=f"The {slug} skill.", body=body),
    )


async def make_workspace(client: AsyncClient, name: str, tmp_path: Path) -> dict:
    path = tmp_path / name
    path.mkdir(parents=True, exist_ok=True)
    response = await client.post("/workspaces", json={"name": name, "path": str(path)})
    assert response.status_code == 201, response.text
    return response.json()


async def scoped_slugs(workspace: dict) -> set[str]:
    async with async_session_factory() as session:
        scoped = await skills_in_scope(
            session, workspace_path=workspace["path"], workspace_id=workspace["id"]
        )
    return {s.slug for s in scoped}


def find(listed: list[dict], slug: str) -> dict:
    hits = [s for s in listed if s["slug"] == slug]
    assert len(hits) == 1, f"expected one skill {slug!r}, got {len(hits)}"
    return hits[0]


# --- The parser reports rather than swallows -----------------------------------


def test_frontmatter_error_names_the_problem_and_the_line(tmp_path) -> None:
    write_skill_folder(tmp_path, "broken", BROKEN_SKILL_MD)
    error = store.frontmatter_error("broken", tmp_path)
    assert "mapping values are not allowed here" in error
    assert "line 3" in error, f"no location to act on: {error!r}"
    # One line: this ends up in a badge, not a log.
    assert "\n" not in error


def test_frontmatter_error_is_empty_for_a_valid_skill(tmp_path) -> None:
    write_good(tmp_path, "fine")
    assert store.frontmatter_error("fine", tmp_path) == ""


def test_a_skill_with_no_frontmatter_at_all_is_not_an_error(tmp_path) -> None:
    """Absent is not malformed — the library gives it a folder-name title."""
    write_skill_folder(tmp_path, "bare", "Just a body, no frontmatter block.\n")
    assert store.frontmatter_error("bare", tmp_path) == ""


def test_a_missing_folder_reports_rather_than_raises(tmp_path) -> None:
    assert "could not be read" in store.frontmatter_error("nope", tmp_path)


def test_reading_a_broken_skill_still_returns_its_body(tmp_path) -> None:
    """Indexing must survive it: the row exists, flagged, so the UI can offer a fix."""
    write_skill_folder(tmp_path, "broken", BROKEN_SKILL_MD)
    parsed = store.read_skill("broken", tmp_path)
    assert parsed is not None
    assert parsed.content == "Body."
    assert parsed.name == "broken"  # falls back to the slug
    assert "mapping values are not allowed here" in parsed.error


# --- Scope drops it, and only it -----------------------------------------------


async def test_broken_skill_is_excluded_from_scope(client: AsyncClient, tmp_path) -> None:
    ws = await make_workspace(client, "malformed", tmp_path)
    root = Path(ws["path"]) / ".claude" / "skills"
    write_skill_folder(root, "scope-broken", BROKEN_SKILL_MD)
    write_good(root, "scope-healthy")
    assert (await client.get("/skills")).status_code == 200  # index it

    slugs = await scoped_slugs(ws)
    assert "scope-broken" not in slugs
    assert "scope-healthy" in slugs, "one bad skill took a good one with it"


async def test_broken_skill_does_not_shadow_a_further_layer(
    client: AsyncClient, tmp_path
) -> None:
    """A repo copy that can't be read reveals the catalog one, not a hole.

    The same rule as a disabled skill. Falling back matters more here, because
    unlike a switch nobody chose this: the skill simply stopped working, and the
    version that still parses should carry on.
    """
    ws = await make_workspace(client, "shadowed", tmp_path)
    created = await client.post(
        "/skills",
        json={"name": "pdf", "description": "Catalog copy.", "content": "Catalog body."},
    )
    assert created.status_code == 201, created.text
    write_skill_folder(Path(ws["path"]) / ".claude" / "skills", "pdf", BROKEN_SKILL_MD)
    assert (await client.get("/skills")).status_code == 200

    async with async_session_factory() as session:
        scoped = await skills_in_scope(
            session, workspace_path=ws["path"], workspace_id=ws["id"]
        )
    pdf = [s for s in scoped if s.slug == "pdf"]
    assert len(pdf) == 1, "the unreadable repo copy left a hole"
    assert pdf[0].layer == "global", "the broken local copy still won the slug"


async def test_a_skill_broken_after_indexing_leaves_scope(
    client: AsyncClient, tmp_path
) -> None:
    """Disk is authoritative, so the check is against the file, not a cached row."""
    ws = await make_workspace(client, "regressed", tmp_path)
    root = Path(ws["path"]) / ".claude" / "skills"
    write_good(root, "drifter")
    assert (await client.get("/skills")).status_code == 200
    assert "drifter" in await scoped_slugs(ws)

    (root / "drifter" / "SKILL.md").write_text(BROKEN_SKILL_MD, encoding="utf-8")
    assert "drifter" not in await scoped_slugs(ws)


# --- The library can't fail the build, even handed a broken folder --------------


def test_skill_directories_are_built_non_validating(tmp_path) -> None:
    """The guarantee the resolver's filter is the *second* line of defence for.

    Constructed with the library default (``validate=True``) this raises, which is
    precisely the failure that reached the user: not one skill lost, but the whole
    ``create_deep_agent`` call, and the run with it.
    """
    from app.skills.resolve import ScopedSkill

    broken = write_skill_folder(tmp_path, "broken", BROKEN_SKILL_MD)
    good = write_good(tmp_path, "healthy")

    from app.agents.skill_runtime import SkillRuntime

    runtime = SkillRuntime(
        scoped=(
            ScopedSkill(
                skill_id="1", slug="broken", name="broken", folder=broken, layer="user"
            ),
            ScopedSkill(
                skill_id="2", slug="healthy", name="healthy", folder=good, layer="user"
            ),
        )
    )
    directories = _skill_directories(runtime)

    assert len(directories) == 2
    loaded = [name for d in directories for name in d.get_skills()]
    assert len(loaded) == 1, "the malformed folder was loaded, or took the good one down"


async def test_the_runtime_a_run_gets_never_includes_a_broken_folder(
    client: AsyncClient, tmp_path
) -> None:
    """End to end over the real seam: what ``build_deep_agent`` would be handed."""
    ws = await make_workspace(client, "runtime", tmp_path)
    root = Path(ws["path"]) / ".claude" / "skills"
    write_skill_folder(root, "runtime-broken", BROKEN_SKILL_MD)
    write_good(root, "runtime-healthy")
    assert (await client.get("/skills")).status_code == 200

    async with async_session_factory() as session:
        runtime = await load_skill_runtime(
            session, workspace_path=ws["path"], workspace_id=ws["id"]
        )
    # Only this workspace's two folders are of interest; the module's shared DB
    # carries catalog skills from earlier tests, which are global and legitimately
    # in scope here too.
    mine = [Path(d).name for d in runtime.skill_dirs if str(root) in d]
    assert mine == ["runtime-healthy"]
    directories = _skill_directories(runtime)
    # ``get_skills`` is keyed by folder URI.
    loaded = {Path(uri).name for d in directories for uri in d.get_skills()}
    assert "runtime-healthy" in loaded
    assert "runtime-broken" not in loaded


# --- ...and the user finds out why ---------------------------------------------


async def test_the_skill_is_still_listed_and_carries_the_reason(
    client: AsyncClient, tmp_path
) -> None:
    ws = await make_workspace(client, "reported", tmp_path)
    write_skill_folder(
        Path(ws["path"]) / ".claude" / "skills", "listed-broken", BROKEN_SKILL_MD
    )

    listed = (await client.get("/skills")).json()
    skill = find(listed, "listed-broken")
    assert "mapping values are not allowed here" in skill["error"]
    # Still a normal row: editable, deletable, and honest about being on.
    assert skill["enabled"] is True
    again = find((await client.get("/skills")).json(), "listed-broken")
    assert again["error"] == skill["error"]


async def test_a_healthy_skill_reports_no_error(client: AsyncClient, tmp_path) -> None:
    ws = await make_workspace(client, "clean", tmp_path)
    write_good(Path(ws["path"]) / ".claude" / "skills", "clean-healthy")
    assert find((await client.get("/skills")).json(), "clean-healthy")["error"] == ""


async def test_saving_from_the_editor_repairs_the_frontmatter(
    client: AsyncClient, tmp_path
) -> None:
    """The fix the UI offers has to actually work — and bring the skill back."""
    ws = await make_workspace(client, "repaired", tmp_path)
    root = Path(ws["path"]) / ".claude" / "skills"
    write_skill_folder(root, "fixable", BROKEN_SKILL_MD)
    skill = find((await client.get("/skills")).json(), "fixable")
    assert skill["error"]

    saved = await client.patch(
        f"/skills/{skill['id']}",
        json={
            "name": "fixable",
            "description": "Covers the playbook for Vite builds: auditing CDNs.",
            "content": "Body.",
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["error"] == "", "the rewrite left it unparseable"
    assert store.frontmatter_error("fixable", root) == ""
    assert "fixable" in await scoped_slugs(ws)


@pytest.mark.parametrize(
    "frontmatter",
    [
        pytest.param("---\nname: a\ndescription: has: a colon\n---\n\nBody.\n", id="colon"),
        pytest.param("---\nname: a\n  description: bad indent\n---\n\nBody.\n", id="indent"),
        pytest.param("---\nname: [unclosed\n---\n\nBody.\n", id="unclosed-bracket"),
        pytest.param('---\nname: "unterminated\n---\n\nBody.\n', id="unterminated-quote"),
        pytest.param("---\njust a string\n---\n\nBody.\n", id="not-a-mapping"),
    ],
)
def test_every_shape_of_bad_frontmatter_is_caught(tmp_path, frontmatter: str) -> None:
    """Whatever the flavour, the answer is the same: reported, never raised."""
    write_skill_folder(tmp_path, "broken", frontmatter)
    assert store.frontmatter_error("broken", tmp_path) != ""
    assert store.read_skill("broken", tmp_path) is not None
