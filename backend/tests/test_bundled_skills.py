"""Shipped skills reach the catalog, and a user's edits survive the next release.

The seeding pass has one interesting property and it is not "does the copy work":
it runs on **every** start, against a directory the user can edit, so the whole
design is about telling three states apart —

* never installed → install it, and give it reach once;
* installed and untouched → safe to replace with a newer bundled version;
* installed and edited, or a same-slug skill that was never ours → hands off, and
  say so.

Getting the third one wrong silently destroys work, which is why the stamp exists.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import delete
from sqlmodel import select

from app.api import skills as skills_api
from app.config import get_settings
from app.db.models import Skill, SkillOrigin
from app.db.session import async_session_factory
from app.skills import seed as seed_mod
from app.skills.seed import (
    STAMP,
    bundled_slugs,
    globalize_bundled,
    seed_bundled_skills,
)


@pytest.fixture
def bundle(tmp_path, monkeypatch):
    """An isolated catalog plus a two-skill bundle standing in for the shipped one."""
    catalog = tmp_path / "catalog"
    catalog.mkdir()
    monkeypatch.setattr(get_settings(), "skills_dir", catalog)

    root = tmp_path / "bundled"
    for slug, body in (("alpha", "Alpha v1"), ("beta", "Beta v1")):
        folder = root / slug
        folder.mkdir(parents=True)
        (folder / "SKILL.md").write_text(_skill_md(slug, body))
    monkeypatch.setattr(seed_mod, "BUNDLED_ROOT", root)
    return root, catalog


def _skill_md(slug: str, body: str) -> str:
    return f"---\nname: {slug}\ndescription: A {slug} skill.\n---\n\n# {slug}\n\n{body}\n"


def test_the_real_bundle_is_discoverable_and_parses(tmp_path):
    """Guards the packaging: a folder that ships but has no SKILL.md is invisible."""
    slugs = bundled_slugs()
    assert "video-production" in slugs, "the shipped skill must be discoverable"
    for slug in slugs:
        text = (seed_mod.BUNDLED_ROOT / slug / "SKILL.md").read_text()
        assert text.startswith("---"), f"{slug} needs YAML frontmatter to load"
        assert "\nname:" in text and "\ndescription:" in text


def test_first_run_installs_and_stamps(bundle):
    _, catalog = bundle
    result = seed_bundled_skills()

    assert set(result.installed) == {"alpha", "beta"}
    assert not result.refreshed and not result.skipped
    assert (catalog / "alpha/SKILL.md").read_text().endswith("Alpha v1\n")
    # The stamp is the claim "we installed this, and this is what we installed".
    assert (catalog / "alpha" / STAMP).read_text().strip()
    # Staging directories must not be left behind.
    assert not list(catalog.glob(".*incoming"))


def test_second_run_with_no_change_does_nothing(bundle):
    seed_bundled_skills()
    again = seed_bundled_skills()
    assert not again.installed and not again.refreshed and not again.skipped


def test_an_untouched_skill_is_upgraded(bundle):
    root, catalog = bundle
    seed_bundled_skills()

    (root / "alpha/SKILL.md").write_text(_skill_md("alpha", "Alpha v2, better"))
    result = seed_bundled_skills()

    assert result.refreshed == ("alpha",)
    assert "Alpha v2" in (catalog / "alpha/SKILL.md").read_text()
    assert "Beta v1" in (catalog / "beta/SKILL.md").read_text()


def test_a_locally_edited_skill_is_never_clobbered(bundle):
    """The failure this whole design exists to prevent."""
    root, catalog = bundle
    seed_bundled_skills()
    (catalog / "alpha/SKILL.md").write_text(_skill_md("alpha", "MY OWN NOTES"))

    # A new release changes the same skill.
    (root / "alpha/SKILL.md").write_text(_skill_md("alpha", "Alpha v2, better"))
    result = seed_bundled_skills()

    assert "alpha" in result.skipped
    assert "edited" in result.skipped["alpha"]
    assert "MY OWN NOTES" in (catalog / "alpha/SKILL.md").read_text()
    assert not result.refreshed


def test_a_users_own_skill_with_the_same_slug_is_left_alone(bundle):
    """No stamp means it was never ours, whatever the slug says."""
    _, catalog = bundle
    (catalog / "alpha").mkdir()
    (catalog / "alpha/SKILL.md").write_text(_skill_md("alpha", "hand-written"))

    result = seed_bundled_skills()

    assert result.installed == ("beta",)
    assert "not ours" in result.skipped["alpha"]
    assert "hand-written" in (catalog / "alpha/SKILL.md").read_text()


def test_a_linked_catalog_entry_is_not_written_through(bundle, tmp_path):
    """A symlinked entry is another tool's files; writing through it is not ours."""
    _, catalog = bundle
    foreign = tmp_path / "elsewhere/alpha"
    foreign.mkdir(parents=True)
    (foreign / "SKILL.md").write_text(_skill_md("alpha", "owned by another tool"))
    (catalog / "alpha").symlink_to(foreign, target_is_directory=True)

    result = seed_bundled_skills()

    assert "linked" in result.skipped["alpha"]
    assert (foreign / "SKILL.md").read_text().endswith("owned by another tool\n")


def test_added_resources_count_as_a_change(bundle):
    """The digest covers names as well as bytes, so a new file is an upgrade."""
    root, catalog = bundle
    seed_bundled_skills()
    (root / "alpha/reference.md").write_text("extra detail\n")

    assert seed_bundled_skills().refreshed == ("alpha",)
    assert (catalog / "alpha/reference.md").is_file()


async def test_a_newly_installed_skill_is_globalized_once(bundle, client: AsyncClient):
    """Parked is the catalog's default for a new folder, and would mean "does
    nothing" for a skill the product ships. But parking one by hand has to stick."""
    _, catalog = bundle
    async with async_session_factory() as session:
        await session.execute(delete(Skill))
        await session.commit()

    result = seed_bundled_skills()
    async with async_session_factory() as session:
        await skills_api.reconcile(session)
        changed = await globalize_bundled(session, result.installed)
        assert changed == 2
        rows = await _managed(session)
    assert {r.slug for r in rows if r.is_global} == {"alpha", "beta"}

    # The user parks one; the next boot must not undo that.
    async with async_session_factory() as session:
        rows = await _managed(session)
        for row in rows:
            if row.slug == "alpha":
                row.is_global = False
                session.add(row)
        await session.commit()

    again = seed_bundled_skills()
    assert not again.installed, "nothing new to install, so nothing to re-globalize"
    async with async_session_factory() as session:
        await skills_api.reconcile(session)
        await globalize_bundled(session, again.installed)
        rows = await _managed(session)
    parked = {r.slug: r.is_global for r in rows}
    assert parked["alpha"] is False, "a deliberate park must survive the next release"
    assert parked["beta"] is True


async def _managed(session) -> list[Skill]:
    result = await session.execute(
        select(Skill).where(Skill.origin == SkillOrigin.managed)
    )
    return list(result.scalars().all())


def test_an_unwritable_catalog_is_reported_not_raised(bundle, monkeypatch):
    """Startup must not die because a directory is read-only."""

    def deny(*args, **kwargs):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(Path, "mkdir", deny)
    result = seed_bundled_skills()
    assert set(result.skipped) == {"alpha", "beta"}
