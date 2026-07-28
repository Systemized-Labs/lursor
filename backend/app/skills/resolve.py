"""Which skills are in scope for a run, and in what order.

``app/skills/store.py`` knows where skill folders live; this module knows which
of them a run in a given workspace actually gets. That needs the database,
because a managed skill's reach is an *assignment* (``Skill.is_global`` plus
``SkillWorkspaceLink`` rows), not a location on disk.

Four layers, lowest precedence first:

1. **user** — folders found in a personal root owned by another tool
   (``~/.claude/skills``, ``settings.user_skill_roots``). No owning workspace, so
   they are in scope everywhere;
2. **global** — managed skills with ``is_global`` (every workspace);
3. **workspace** — managed skills linked to *this* workspace;
4. **local** — folders found in one of the workspace's own skill roots
   (``.agents/skills``, ``.claude/skills``, ``.cursor/skills``), committed into
   the repo.

On a slug collision the closest layer wins, exactly as before: a repo's own copy
of ``pdf-tools`` overrides one assigned to the workspace, which overrides a
global one — which in turn overrides one that merely happens to sit in
``~/.claude/skills``. Your Lursor catalog is a deliberate choice; a directory
another tool populates is not, so the catalog wins that tie. Within a layer,
earlier-configured roots win. A managed skill that is neither global nor linked
anywhere is in the catalog but in scope for nothing — the deliberate "parked"
state.

Disk stays authoritative for *content*: a row whose folder has vanished is
skipped rather than injected, so a stale index can never hand the agent a
directory that isn't there.
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import Skill, SkillOrigin, SkillWorkspaceLink
from app.skills import store

# Lowest → highest precedence. Also the order a caller may rely on for
# deterministic merging.
LAYERS = ("user", "global", "workspace", "local")


@dataclass(frozen=True)
class ScopedSkill:
    """One skill in scope for a run, resolved to a real folder on disk.

    ``skill_id`` matters as much as the folder: env vars are attached to skill
    rows, so the runtime needs the identity, not just the path.
    """

    skill_id: str
    slug: str
    name: str
    folder: Path
    layer: str  # one of LAYERS


async def skills_in_scope(
    session: AsyncSession, *, workspace_path: str | Path, workspace_id: str
) -> list[ScopedSkill]:
    """Every skill a run in this workspace sees, closest layer winning per slug.

    Returned in precedence order (global first, local last) after collision
    resolution, so callers can hand the folders straight to the deep agent.
    """
    catalog = store.catalog_root()
    local_keys = store.local_root_keys()
    user_keys = store.user_root_keys()

    def rank(keys: list[str], key: str) -> int:
        """Precedence of a row's root within its layer; unknown roots sort last."""
        return keys.index(key) if key in keys else len(keys)

    linked_ids = set(
        (
            await session.execute(
                select(SkillWorkspaceLink.skill_id).where(
                    SkillWorkspaceLink.workspace_id == workspace_id
                )
            )
        )
        .scalars()
        .all()
    )

    rows = (await session.execute(select(Skill).order_by(Skill.slug))).scalars().all()

    def candidates(layer: str) -> list[tuple[Skill, Path]]:
        """``(row, root)`` for one layer, highest-precedence root first."""
        out: list[tuple[Skill, Path, int]] = []
        for row in rows:
            if not row.slug:
                continue
            if layer == "local":
                if row.origin != SkillOrigin.local or row.workspace_id != workspace_id:
                    continue
                out.append(
                    (
                        row,
                        store.local_root_path(workspace_path, row.root),
                        rank(local_keys, row.root),
                    )
                )
            elif layer == "workspace":
                if row.origin == SkillOrigin.managed and row.id in linked_ids:
                    out.append((row, catalog, 0))
            elif layer == "global":
                if row.origin == SkillOrigin.managed and row.is_global:
                    out.append((row, catalog, 0))
            else:  # user
                if row.origin == SkillOrigin.external and row.root:
                    out.append((row, Path(row.root), rank(user_keys, row.root)))
        return [(row, root) for row, root, _ in sorted(out, key=lambda c: (c[2], c[0].slug))]

    by_slug: dict[str, ScopedSkill] = {}
    # Insert in layer order so a later (closer) layer overwrites an earlier one.
    for layer in LAYERS:
        # Within a layer the first root to claim a slug keeps it, so the order of
        # ``local_skill_roots`` decides a same-layer collision rather than
        # whichever row happened to be scanned last.
        won: dict[str, ScopedSkill] = {}
        for row, root in candidates(layer):
            if row.slug in won:
                continue
            # ``path_for`` rejects a slug that would escape its root, so a
            # malformed row is skipped rather than aborting the whole resolution.
            with contextlib.suppress(ValueError):
                if not store.exists(row.slug, root):
                    continue  # folder gone; reconcile will clean the row up
                won[row.slug] = ScopedSkill(
                    skill_id=row.id,
                    slug=row.slug,
                    name=row.name,
                    folder=store.path_for(row.slug, root),
                    layer=layer,
                )
        by_slug.update(won)

    return sorted(by_slug.values(), key=lambda s: (LAYERS.index(s.layer), s.slug))


def skill_dirs(scoped: list[ScopedSkill]) -> list[str]:
    """The folder list to hand ``create_deep_agent(skill_directories=...)``."""
    return [str(s.folder) for s in scoped]
