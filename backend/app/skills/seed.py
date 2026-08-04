"""Skills that ship with Lursor, seeded into the catalog on every start.

Some knowledge belongs to the product rather than to a user's workspace. The
``video-production`` skill is the first: the video *tools* are useless without the
craft that goes with them (what a render costs, why you draft before committing, the
ffmpeg recipe for each cut and the trap that makes it fail), and asking every user to
author that themselves would mean the feature only works for whoever already knows
how to edit video.

So the folders under ``app/skills/bundled/`` are copied into the catalog
(``settings.skills_dir``, i.e. ``~/.lursor/skills/``) at startup, where they become
ordinary managed skills: visible in Skill Studio, editable, assignable, and
switch-off-able like any other. Nothing here is special-cased at run time.

**The hard part is upgrading without clobbering.** A skill the user has edited must
survive a new release; a skill they have not touched should get the improved version.
So each seeded folder carries a :data:`STAMP` file holding the digest of exactly what
we installed, and startup compares three things:

* no folder → install it (and give it global reach, once — see
  :func:`globalize_bundled`);
* folder + stamp that still matches its contents → ours and unmodified, so refresh it
  from the bundle when the bundle has changed;
* folder with no stamp, or a stamp that no longer matches → **hands off.** That is
  either a user's own skill that happens to share the slug, or our copy with their
  edits in it. Either way the file on disk wins and the skip is logged rather than
  silently overwritten.

The assignment is *not* re-applied on later boots: a user who parks or narrows a
bundled skill must not find it globalized again on the next release. Same one-shot
rule the column backfills in ``db/session.py`` follow, for the same reason.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import Skill, SkillOrigin
from app.skills import store

logger = logging.getLogger(__name__)

# Where the shipped folders live inside the installed package. Beside this module so
# it travels with the wheel (hatchling includes the whole ``app`` package), which is
# what makes it work in the frozen desktop bundle as well as from source.
BUNDLED_ROOT = Path(__file__).parent / "bundled"

# Written into each seeded folder: the digest of what we put there. Its presence is
# the claim "Lursor installed this"; its value is the claim "and it is unchanged".
STAMP = ".bundled"

# Never copied out of the bundle, and never part of a digest.
_IGNORED = {STAMP, "__pycache__", ".DS_Store"}


@dataclass(frozen=True)
class BundledSeed:
    """What one seeding pass did, by slug."""

    installed: tuple[str, ...] = ()
    refreshed: tuple[str, ...] = ()
    # Slug -> why it was left alone. Reported rather than dropped: a skipped
    # upgrade is exactly the kind of quiet no-op that reads as success.
    skipped: dict[str, str] = field(default_factory=dict)


def bundled_slugs() -> list[str]:
    """Slugs available in the bundle, in a stable order."""
    if not BUNDLED_ROOT.is_dir():
        return []
    return sorted(
        entry.name
        for entry in BUNDLED_ROOT.iterdir()
        if entry.is_dir()
        and entry.name not in _IGNORED
        and (entry / store.SKILL_FILE).is_file()
    )


def seed_bundled_skills() -> BundledSeed:
    """Copy shipped skills into the catalog. Filesystem only; idempotent.

    Returns what changed, so the caller can give freshly installed skills their
    initial reach (:func:`globalize_bundled`) and log the rest.
    """
    installed: list[str] = []
    refreshed: list[str] = []
    skipped: dict[str, str] = {}

    try:
        # ``catalog_root`` creates the directory itself, so it is inside the guard:
        # a read-only or full disk must degrade to "no bundled skills this boot",
        # never take the whole app down on startup.
        catalog = store.catalog_root()
        catalog.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        logger.warning("bundled skills: catalog is not writable: %s", exc)
        return BundledSeed(
            skipped={slug: f"catalog not writable: {exc}" for slug in bundled_slugs()}
        )

    for slug in bundled_slugs():
        source = BUNDLED_ROOT / slug
        dest = catalog / slug
        bundle_digest = _digest(source)

        if not dest.exists():
            try:
                _copy(source, dest, bundle_digest)
            except OSError as exc:
                skipped[slug] = f"could not install: {exc}"
                continue
            installed.append(slug)
            continue

        # A symlink here is a *linked* catalog entry — files another tool owns. Never
        # write through one (see ``store.link_skill``).
        if dest.is_symlink():
            skipped[slug] = "a linked catalog entry with this slug already exists"
            continue

        stamp = _read_stamp(dest)
        if stamp is None:
            skipped[slug] = "a skill with this slug already exists and is not ours"
            continue
        current = _digest(dest)
        if stamp != current:
            skipped[slug] = "locally edited, so the newer bundled version was not applied"
            continue
        if current == bundle_digest:
            continue  # already up to date
        try:
            _copy(source, dest, bundle_digest)
        except OSError as exc:
            skipped[slug] = f"could not refresh: {exc}"
            continue
        refreshed.append(slug)

    seed = BundledSeed(
        installed=tuple(installed), refreshed=tuple(refreshed), skipped=dict(skipped)
    )
    if installed:
        logger.info("bundled skills installed: %s", ", ".join(installed))
    if refreshed:
        logger.info("bundled skills refreshed: %s", ", ".join(refreshed))
    for slug, why in skipped.items():
        logger.info("bundled skill %r left alone: %s", slug, why)
    return seed


async def globalize_bundled(session: AsyncSession, slugs: tuple[str, ...]) -> int:
    """Give freshly installed bundled skills global reach. Returns how many changed.

    Only ever called with the slugs a pass *installed*, never with the ones it
    refreshed: the catalog indexes a new folder as parked (``is_global=False``, in
    scope nowhere), which for a skill the product ships would mean it silently does
    nothing until someone finds the assignment toggle. Applying it once at install
    keeps a later "park this" decision intact.

    Runs after ``api.skills.reconcile``, which is what turns the folder into a row.
    """
    if not slugs:
        return 0
    result = await session.execute(
        select(Skill).where(
            Skill.origin == SkillOrigin.managed, Skill.slug.in_(list(slugs))
        )
    )
    changed = 0
    for row in result.scalars().all():
        if not row.is_global:
            row.is_global = True
            session.add(row)
            changed += 1
    if changed:
        await session.commit()
    return changed


def _digest(folder: Path) -> str:
    """A content hash over every file in a skill folder.

    Covers names as well as bytes, so an added or renamed resource counts as a
    change. Sorted, so it is stable across filesystems.
    """
    sha = hashlib.sha256()
    for path in sorted(p for p in folder.rglob("*") if p.is_file()):
        relative = path.relative_to(folder)
        if any(part in _IGNORED for part in relative.parts):
            continue
        sha.update(str(relative.as_posix()).encode())
        sha.update(b"\0")
        sha.update(path.read_bytes())
    return sha.hexdigest()


def _read_stamp(folder: Path) -> str | None:
    marker = folder / STAMP
    if not marker.is_file():
        return None
    try:
        return marker.read_text().strip() or None
    except OSError:
        return None


def _copy(source: Path, dest: Path, digest: str) -> None:
    """Replace ``dest`` with ``source``, then stamp it.

    Written to a sibling and moved into place so an interrupted copy cannot leave a
    half-written skill that the agent library would then fail to parse.
    """
    staging = dest.parent / f".{dest.name}.incoming"
    shutil.rmtree(staging, ignore_errors=True)
    shutil.copytree(
        source, staging, ignore=shutil.ignore_patterns(*sorted(_IGNORED))
    )
    (staging / STAMP).write_text(f"{digest}\n")
    if dest.exists():
        shutil.rmtree(dest)
    staging.replace(dest)
