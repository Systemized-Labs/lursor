"""Skills API.

Skills are stored on disk as standard skill folders (``SKILL.md`` + optional
resources and ``scripts/``); see ``app/skills/store.py``. A skill folder lives in
one of three kinds of root, which is what :class:`SkillOrigin` records, narrowed
to the exact directory by ``Skill.root``:

- **managed** — the catalog, ``settings.skills_dir`` (``~/.lursor/skills/``). One
  copy, wherever it applies: reach is an *assignment* in the database
  (``is_global``, or ``skill_workspaces`` rows), so re-pointing a skill at other
  workspaces is a DB write and never moves files.
- **local** — one of the workspace's own roots (``settings.local_skill_roots``:
  ``.agents/skills`` and the other tools' in-repo conventions), committed into a
  repo. It applies only in that workspace and has no assignment to edit.
- **external** — a personal directory owned by another tool
  (``settings.user_skill_roots``: ``~/.agents/skills``, ``~/.claude/skills``, one
  per tool beyond that). In scope everywhere, lowest precedence, no assignment.

Only ``.agents/skills`` and the catalog are Lursor's to create or rebuild; every
other root is *discovered*. That distinction is load-bearing in two places:
``POST /skills/{id}/promote`` (which moves a folder) is refused for a root we
don't own, in favour of ``POST /skills/{id}/copy``; and ``reconcile`` never
materializes a missing folder there — for a foreign root, disk is authoritative
for existence, not just content.

The ``skills`` DB table is a rebuildable index over those roots so listing stays
cheap and the UI has a stable id per skill — which is also what assignments and
env vars hang off. Skills are **not** linked to agents: an agent discovers
whatever is in scope for the workspace it runs in (``app/skills/resolve.py``).

``reconcile`` keeps the index and the on-disk folders in sync, per root: in an
owned root, DB rows whose folder is missing are materialized from their cached
content (auto-migrating pre-folder rows); in a foreign root they are dropped.
Either way skill folders on disk with no DB row get indexed, and rows with an
existing folder have their cache refreshed from disk (disk is authoritative).
Rows whose root or workspace is gone are dropped, along with any assignment or
env-var link pointing at a workspace/skill that no longer exists.
"""

from __future__ import annotations

import contextlib
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import delete, select

from app.db.models import (
    EnvVarSkillLink,
    Skill,
    SkillOrigin,
    SkillWorkspaceLink,
    Workspace,
)
from app.db.session import get_session
from app.schemas.skill import (
    SkillAssignment,
    SkillCreate,
    SkillIngest,
    SkillPromote,
    SkillRead,
    SkillResourceContent,
    SkillScanEntry,
    SkillScanResult,
    SkillUpdate,
)
from app.skills import store
from app.skills.resolve import skills_in_scope

router = APIRouter(prefix="/skills", tags=["skills"])


# --- Origin → on-disk root resolution ------------------------------------------


async def _workspace_or_404(session: AsyncSession, workspace_id: str) -> Workspace:
    ws = await session.get(Workspace, workspace_id)
    if ws is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    return ws


async def _root_for(
    session: AsyncSession, origin: SkillOrigin, workspace_id: str | None
) -> Path:
    """Resolve the on-disk root a *new* skill of this origin is written into.

    Authoring has one destination per origin: the catalog, or the workspace's own
    ``.agents/skills``. Discovery reads other roots; creation never writes to them.
    """
    if origin == SkillOrigin.external:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "External skills are discovered in another tool's directory and can't "
            "be created here. Create it in the catalog instead.",
        )
    if origin == SkillOrigin.local:
        if not workspace_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "workspace_id is required for a workspace-local skill",
            )
        ws = await _workspace_or_404(session, workspace_id)
        return store.workspace_skills_root(ws.path)
    return store.catalog_root()


def _root_for_row(row: Skill, ws_by_id: dict[str, Workspace]) -> Path | None:
    """The root an already-loaded row's folder lives in, from ``row.root``.

    ``None`` when it is gone: the workspace was deleted, or a root we don't own
    (and therefore never create) is no longer on disk.
    """
    if row.origin == SkillOrigin.managed:
        return store.catalog_root()
    if row.origin == SkillOrigin.external:
        if not row.root:  # pragma: no cover — reconcile never writes such a row
            return None
        root = Path(row.root).expanduser()
    else:
        ws = ws_by_id.get(row.workspace_id or "")
        if ws is None:
            return None
        root = store.local_root_path(ws.path, row.root)
    # An owned root is created on demand, so its absence isn't an error.
    return root if (store.is_owned_root(row.root) or root.is_dir()) else None


async def _row_root(session: AsyncSession, row: Skill) -> Path | None:
    """:func:`_root_for_row` for a single row, loading its workspace on demand."""
    ws_by_id: dict[str, Workspace] = {}
    if row.workspace_id:
        ws = await session.get(Workspace, row.workspace_id)
        if ws is not None:
            ws_by_id[ws.id] = ws
    return _root_for_row(row, ws_by_id)


async def _row_root_or_404(session: AsyncSession, row: Skill) -> Path:
    root = await _row_root(session, row)
    if root is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "This skill's folder is no longer on disk",
        )
    return root


def _to_read(
    row: Skill,
    root: Path | None,
    *,
    workspace_ids: list[str] | None = None,
    env_var_ids: list[str] | None = None,
    layer: str | None = None,
) -> SkillRead:
    """Compose a `SkillRead`, sourcing content/resources/scripts from disk."""
    parsed = store.read_skill(row.slug, root) if (root and row.slug) else None
    return SkillRead(
        id=row.id,
        slug=row.slug,
        name=parsed.name if parsed else row.name,
        description=parsed.description if parsed else row.description,
        content=parsed.content if parsed else row.content,
        origin=row.origin,
        is_global=row.is_global,
        workspace_ids=workspace_ids or [],
        workspace_id=row.workspace_id,
        root=row.root,
        root_label=store.root_label(row.root),
        is_owned_root=store.is_owned_root(row.root),
        enabled=row.enabled,
        layer=layer,
        env_var_ids=env_var_ids or [],
        resources=parsed.resources if parsed else [],
        scripts=parsed.scripts if parsed else [],
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# --- Assignment / env-link lookups ---------------------------------------------


async def _assignments(session: AsyncSession) -> dict[str, list[str]]:
    """skill_id -> assigned workspace ids."""
    rows = (await session.execute(select(SkillWorkspaceLink))).scalars().all()
    out: dict[str, list[str]] = {}
    for link in rows:
        out.setdefault(link.skill_id, []).append(link.workspace_id)
    return out


async def _env_links(session: AsyncSession) -> dict[str, list[str]]:
    """skill_id -> attached env var ids."""
    rows = (await session.execute(select(EnvVarSkillLink))).scalars().all()
    out: dict[str, list[str]] = {}
    for link in rows:
        out.setdefault(link.skill_id, []).append(link.env_var_id)
    return out


async def _set_assignment(
    session: AsyncSession, skill: Skill, *, is_global: bool, workspace_ids: list[str]
) -> None:
    """Apply an assignment, normalizing "global wins" and validating workspaces.

    Global already covers every workspace, so the links are cleared rather than
    kept alongside it — that way the UI has one unambiguous state to render and
    can't drift into "global, but also these three".
    """
    await session.execute(
        delete(SkillWorkspaceLink).where(SkillWorkspaceLink.skill_id == skill.id)
    )
    skill.is_global = is_global
    if not is_global:
        for workspace_id in dict.fromkeys(workspace_ids):  # de-dupe, keep order
            await _workspace_or_404(session, workspace_id)
            session.add(
                SkillWorkspaceLink(skill_id=skill.id, workspace_id=workspace_id)
            )
    session.add(skill)


# --- Reconcile -----------------------------------------------------------------


async def _reconcile_root(
    session: AsyncSession,
    root: Path,
    rows: list[Skill],
    *,
    origin: SkillOrigin,
    workspace_id: str | None,
    root_key: str,
    materialize: bool,
    dropped: set[str],
) -> bool:
    """Sync one root's DB rows against its on-disk folders. Returns whether dirty.

    ``materialize`` is the whole difference between a root we own and one we
    merely read. With it, a row whose folder is missing is rebuilt from the DB
    cache (that is how a pre-folder row migrates). Without it, the row is
    **deleted**: pointed at ``.claude/skills`` the rebuild would create a
    ``.claude/`` directory in a repo that never had one and resurrect skills the
    user deleted in another tool, so for a foreign root disk is authoritative for
    existence, not merely for content.
    """
    taken = set(store.list_slugs(root)) | {r.slug for r in rows if r.slug}
    indexed: set[str] = set()
    dirty = False

    for row in rows:
        if not row.slug:
            row.slug = store.slugify(row.name, taken=taken)
            taken.add(row.slug)
            session.add(row)
            dirty = True
        if row.root != root_key:
            # Heal a row that predates ``root`` being recorded, or one grouped
            # here by the empty-key fallback, so later lookups don't re-derive it.
            row.root = root_key
            session.add(row)
            dirty = True

        if not store.exists(row.slug, root):
            if not materialize:
                await session.delete(row)
                dropped.add(row.id)
                dirty = True
                continue
            # Pre-folder row (or a deleted folder): materialize from the cache.
            store.write_skill(
                row.slug,
                root,
                name=row.name,
                description=row.description,
                content=row.content,
            )
        else:
            # Folder is authoritative: refresh the cache from disk.
            parsed = store.read_skill(row.slug, root)
            if parsed and (
                row.name != parsed.name
                or row.description != parsed.description
                or row.content != parsed.content
            ):
                row.name, row.description, row.content = (
                    parsed.name,
                    parsed.description,
                    parsed.content,
                )
                session.add(row)
                dirty = True
        indexed.add(row.slug)

    # Skill folders on disk with no index row yet. A folder that appears in the
    # catalog out of band (dropped in by hand, restored from a backup) is indexed
    # unassigned: it shows up in the UI to be assigned, rather than silently
    # applying everywhere.
    for slug in store.list_slugs(root):
        if slug in indexed:
            continue
        parsed = store.read_skill(slug, root)
        if parsed is None:
            continue
        session.add(
            Skill(
                slug=slug,
                name=parsed.name,
                description=parsed.description,
                content=parsed.content,
                origin=origin,
                is_global=False,
                workspace_id=workspace_id,
                root=root_key,
            )
        )
        dirty = True

    return dirty


def _by_root(rows: list[Skill], *, default: str = "") -> dict[str, list[Skill]]:
    """Group rows by the root they claim, so each root reconciles against its own."""
    out: dict[str, list[Skill]] = {}
    for row in rows:
        out.setdefault(row.root or default, []).append(row)
    return out


async def reconcile(session: AsyncSession) -> None:
    """Make the DB index and the on-disk skill folders consistent, per root."""
    workspaces = (await session.execute(select(Workspace))).scalars().all()
    ws_by_id = {w.id: w for w in workspaces}
    rows = (await session.execute(select(Skill))).scalars().all()
    dropped: set[str] = set()
    dirty = False

    # The catalog.
    dirty |= await _reconcile_root(
        session,
        store.catalog_root(),
        [r for r in rows if r.origin == SkillOrigin.managed],
        origin=SkillOrigin.managed,
        workspace_id=None,
        root_key="",
        materialize=True,
        dropped=dropped,
    )

    # Every configured local root of every existing workspace. Skip a workspace
    # whose directory is gone so we don't resurrect a deleted workspace folder by
    # materializing skills into it.
    for ws in workspaces:
        if not Path(ws.path).is_dir():
            continue
        pending = _by_root(
            [r for r in rows if r.origin == SkillOrigin.local and r.workspace_id == ws.id],
            default=store.DEFAULT_LOCAL_SKILL_ROOT,
        )
        # Only roots that exist are scanned, plus our own — which is the write
        # target for ``POST /skills`` whatever the config says, so rows there must
        # always get the chance to materialize.
        scanned = store.local_skill_roots(ws.path)
        if all(key != store.DEFAULT_LOCAL_SKILL_ROOT for key, _ in scanned):
            scanned.insert(
                0, (store.DEFAULT_LOCAL_SKILL_ROOT, store.workspace_skills_root(ws.path))
            )
        for key, root in scanned:
            dirty |= await _reconcile_root(
                session,
                root,
                pending.pop(key, []),
                origin=SkillOrigin.local,
                workspace_id=ws.id,
                root_key=key,
                materialize=store.is_owned_root(key),
                dropped=dropped,
            )
        # Rows in a root that has been un-configured or has vanished from disk.
        # Nothing is deleted on disk — the directory is simply no longer indexed.
        for orphans in pending.values():
            for row in orphans:
                await session.delete(row)
                dropped.add(row.id)
                dirty = True

    # Personal roots owned by another tool. No workspace, never materialized.
    pending_user = _by_root([r for r in rows if r.origin == SkillOrigin.external])
    for key, root in store.user_skill_roots():
        dirty |= await _reconcile_root(
            session,
            root,
            pending_user.pop(key, []),
            origin=SkillOrigin.external,
            workspace_id=None,
            root_key=key,
            materialize=False,
            dropped=dropped,
        )
    for orphans in pending_user.values():
        for row in orphans:
            await session.delete(row)
            dropped.add(row.id)
            dirty = True

    # Drop local rows whose workspace no longer exists at all.
    live_ids = {r.id for r in rows} - dropped
    for row in rows:
        if row.id in dropped:
            continue
        if row.origin == SkillOrigin.local and row.workspace_id not in ws_by_id:
            await session.delete(row)
            live_ids.discard(row.id)
            dirty = True

    # Assignments and env-var links pointing at something that is gone. Workspace
    # deletion doesn't cascade in SQLite, so a stale link would otherwise keep a
    # skill "assigned" to a workspace that no longer exists.
    for link in (await session.execute(select(SkillWorkspaceLink))).scalars().all():
        if link.workspace_id not in ws_by_id or link.skill_id not in live_ids:
            await session.delete(link)
            dirty = True
    for env_link in (await session.execute(select(EnvVarSkillLink))).scalars().all():
        if env_link.skill_id not in live_ids:
            await session.delete(env_link)
            dirty = True

    if dirty:
        await session.commit()


# --- CRUD ----------------------------------------------------------------------


async def _get_or_404(skill_id: str, session: AsyncSession) -> Skill:
    skill = await session.get(Skill, skill_id)
    if skill is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")
    return skill


async def _taken_slugs(
    session: AsyncSession,
    root: Path,
    origin: SkillOrigin,
    workspace_id: str | None,
    *,
    root_key: str = "",
) -> set[str]:
    """Slugs already used within one root (disk + DB).

    Scoped to ``root_key`` as well as the workspace: two roots of the same
    workspace may each hold a ``pdf-tools``, and that collision is resolved by
    layer precedence, not by renaming one of them.
    """
    stmt = select(Skill.slug).where(Skill.origin == origin, Skill.root == root_key)
    stmt = (
        stmt.where(Skill.workspace_id == workspace_id)
        if workspace_id
        else stmt.where(Skill.workspace_id.is_(None))
    )
    existing = (await session.execute(stmt)).scalars().all()
    return set(store.list_slugs(root)) | {s for s in existing if s}


@router.get("", response_model=list[SkillRead])
async def list_skills(
    assignment: str = Query(
        "all",
        pattern="^(all|global|unassigned|workspace|local|user)$",
        description=(
            "all — every skill; global — assigned everywhere; unassigned — in the "
            "catalog but applying nowhere; workspace — everything in scope for "
            "`workspace_id`, tagged with the layer it won at; local — skills living "
            "in one of a repo's skill roots (optionally filtered to `workspace_id`); "
            "user — skills discovered in a personal directory owned by another tool."
        ),
    ),
    workspace_id: str | None = Query(None),
    session: AsyncSession = Depends(get_session),
):
    """List skills, filtered by where they apply."""
    await reconcile(session)
    workspaces = (await session.execute(select(Workspace))).scalars().all()
    ws_by_id = {w.id: w for w in workspaces}
    assigned = await _assignments(session)
    env_links = await _env_links(session)

    if assignment == "workspace":
        if not workspace_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "workspace_id is required for assignment=workspace",
            )
        ws = await _workspace_or_404(session, workspace_id)
        scoped = await skills_in_scope(
            session, workspace_path=ws.path, workspace_id=workspace_id
        )
        out: list[SkillRead] = []
        for entry in scoped:
            row = await session.get(Skill, entry.skill_id)
            if row is None:  # pragma: no cover — deleted between the two queries
                continue
            out.append(
                _to_read(
                    row,
                    entry.folder.parent,
                    workspace_ids=assigned.get(row.id, []),
                    env_var_ids=env_links.get(row.id, []),
                    layer=entry.layer,
                )
            )
        return out

    rows = (
        (await session.execute(select(Skill).order_by(Skill.created_at)))
        .scalars()
        .all()
    )
    if assignment == "global":
        rows = [r for r in rows if r.origin == SkillOrigin.managed and r.is_global]
    elif assignment == "unassigned":
        rows = [
            r
            for r in rows
            if r.origin == SkillOrigin.managed
            and not r.is_global
            and not assigned.get(r.id)
        ]
    elif assignment == "local":
        rows = [
            r
            for r in rows
            if r.origin == SkillOrigin.local
            and (workspace_id is None or r.workspace_id == workspace_id)
        ]
    elif assignment == "user":
        rows = [r for r in rows if r.origin == SkillOrigin.external]

    return [
        _to_read(
            row,
            _root_for_row(row, ws_by_id),
            workspace_ids=assigned.get(row.id, []),
            env_var_ids=env_links.get(row.id, []),
        )
        for row in rows
    ]


@router.post("", response_model=SkillRead, status_code=status.HTTP_201_CREATED)
async def create_skill(payload: SkillCreate, session: AsyncSession = Depends(get_session)):
    # A local skill is pinned to its workspace folder and carries no assignment;
    # a managed one goes in the catalog and defaults to global unless workspaces
    # were named.
    is_local = payload.origin == SkillOrigin.local
    workspace_id = payload.workspace_id if is_local else None
    # Authoring has one destination per origin: the catalog, or the workspace's
    # own .agents/skills. Discovered roots are read, never written into.
    root_key = store.DEFAULT_LOCAL_SKILL_ROOT if is_local else ""
    root = await _root_for(session, payload.origin, payload.workspace_id)
    taken = await _taken_slugs(
        session, root, payload.origin, workspace_id, root_key=root_key
    )
    slug = store.slugify(payload.name, taken=taken)
    store.write_skill(
        slug,
        root,
        name=payload.name,
        description=payload.description,
        content=payload.content,
    )
    skill = Skill(
        slug=slug,
        name=payload.name,
        description=payload.description,
        content=payload.content,
        origin=payload.origin,
        workspace_id=workspace_id,
        root=root_key,
    )
    session.add(skill)
    if not is_local:
        is_global = (
            payload.is_global
            if payload.is_global is not None
            else not payload.workspace_ids
        )
        await _set_assignment(
            session, skill, is_global=is_global, workspace_ids=payload.workspace_ids
        )
    await session.commit()
    await session.refresh(skill)
    assigned = await _assignments(session)
    return _to_read(skill, root, workspace_ids=assigned.get(skill.id, []))


@router.put("/{skill_id}/assignment", response_model=SkillRead)
async def set_assignment(
    skill_id: str,
    payload: SkillAssignment,
    session: AsyncSession = Depends(get_session),
):
    """Re-point a managed skill: global, a set of workspaces, or nowhere."""
    skill = await _get_or_404(skill_id, session)
    if skill.origin != SkillOrigin.managed:
        verb = "Promote" if store.is_owned_root(skill.root) else "Copy"
        where = store.root_label(skill.root) or "another tool's directory"
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"This skill lives in {where}, so it has no assignment to change. "
            f"{verb} it into the catalog first to assign it elsewhere.",
        )
    await _set_assignment(
        session,
        skill,
        is_global=payload.is_global,
        workspace_ids=payload.workspace_ids,
    )
    await session.commit()
    await session.refresh(skill)
    assigned = await _assignments(session)
    env_links = await _env_links(session)
    return _to_read(
        skill,
        store.catalog_root(),
        workspace_ids=assigned.get(skill.id, []),
        env_var_ids=env_links.get(skill.id, []),
    )


@router.post("/{skill_id}/promote", response_model=SkillRead)
async def promote_skill(
    skill_id: str,
    payload: SkillPromote | None = None,
    session: AsyncSession = Depends(get_session),
):
    """Move a local skill's folder out of its repo and into the catalog.

    The one operation that moves files out of a user's workspace directory, so it
    is always explicit — and it is refused for a root Lursor doesn't own, where
    moving would mutate a git-tracked ``.claude/`` tree behind the user's back.
    Use ``POST /skills/{id}/copy`` there. With no body, the promoted skill stays
    assigned to the workspace it came from — its reach doesn't change, only its
    ability to be re-pointed.
    """
    skill = await _get_or_404(skill_id, session)
    if skill.origin == SkillOrigin.managed:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This skill is already in the catalog"
        )
    if not store.is_owned_root(skill.root):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{store.root_label(skill.root)} belongs to another tool, so its skills "
            "can't be moved out of it. Copy this one into the catalog instead.",
        )
    if not skill.workspace_id:  # pragma: no cover — reconcile drops orphans
        raise HTTPException(status.HTTP_409_CONFLICT, "Skill has no owning workspace")

    origin_workspace_id = skill.workspace_id
    ws = await _workspace_or_404(session, origin_workspace_id)
    src_root = store.local_root_path(ws.path, skill.root)
    catalog = store.catalog_root()
    taken = await _taken_slugs(session, catalog, SkillOrigin.managed, None, root_key="")

    try:
        skill.slug = store.move_skill(skill.slug, src_root, catalog, taken=taken)
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Could not move skill folder: {exc}"
        ) from exc
    skill.origin = SkillOrigin.managed
    skill.workspace_id = None
    skill.root = ""

    payload = payload or SkillPromote()
    workspace_ids = (
        payload.workspace_ids
        if payload.workspace_ids is not None
        else [origin_workspace_id]
    )
    is_global = payload.is_global if payload.is_global is not None else False
    await _set_assignment(
        session, skill, is_global=is_global, workspace_ids=workspace_ids
    )
    await session.commit()
    await session.refresh(skill)
    assigned = await _assignments(session)
    env_links = await _env_links(session)
    return _to_read(
        skill,
        catalog,
        workspace_ids=assigned.get(skill.id, []),
        env_var_ids=env_links.get(skill.id, []),
    )


@router.post("/{skill_id}/copy", response_model=SkillRead)
async def copy_skill(
    skill_id: str,
    payload: SkillPromote | None = None,
    session: AsyncSession = Depends(get_session),
):
    """Duplicate a discovered skill into the catalog, leaving the source alone.

    The non-destructive counterpart to ``promote``, and the only way into the
    catalog from a root another tool owns: taking the folder would mutate a repo
    or delete a skill from under Claude Code. The source row stays exactly as it
    was, still read in place; the copy is an ordinary managed skill that can be
    edited and reassigned freely.

    With no body the copy inherits the reach the source already had: the
    originating workspace for a ``local`` skill, global for an ``external`` one
    (which was in scope everywhere).
    """
    skill = await _get_or_404(skill_id, session)
    if skill.origin == SkillOrigin.managed:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This skill is already in the catalog"
        )
    src_root = await _row_root_or_404(session, skill)
    catalog = store.catalog_root()
    taken = await _taken_slugs(session, catalog, SkillOrigin.managed, None, root_key="")

    try:
        slug = store.copy_skill(skill.slug, src_root, catalog, taken=taken)
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Could not copy skill folder: {exc}"
        ) from exc

    parsed = store.read_skill(slug, catalog)
    copy = Skill(
        slug=slug,
        name=parsed.name if parsed else skill.name,
        description=parsed.description if parsed else skill.description,
        content=parsed.content if parsed else skill.content,
        origin=SkillOrigin.managed,
        workspace_id=None,
        root="",
    )
    session.add(copy)

    payload = payload or SkillPromote()
    if payload.is_global is None and payload.workspace_ids is None:
        is_global = skill.origin == SkillOrigin.external
        workspace_ids = [] if is_global else [skill.workspace_id or ""]
    else:
        is_global = bool(payload.is_global)
        workspace_ids = payload.workspace_ids or []
    await _set_assignment(
        session,
        copy,
        is_global=is_global,
        workspace_ids=[w for w in workspace_ids if w],
    )
    await session.commit()
    await session.refresh(copy)
    assigned = await _assignments(session)
    return _to_read(copy, catalog, workspace_ids=assigned.get(copy.id, []))


async def _import_zip(raw: bytes, root: Path, taken: set[str]) -> list[str]:
    with tempfile.TemporaryDirectory(prefix="lursor-skill-import-") as td:
        tmp = Path(td)
        try:
            store.extract_zip(raw, tmp)
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        folders = store.find_skill_folders(tmp)
        if not folders:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "No SKILL.md found in the archive"
            )
        return [store.import_folder(src, root, taken=taken) for src in folders]


async def _import_tree(
    entries: list[tuple[str, bytes]], root: Path, taken: set[str]
) -> list[str]:
    with tempfile.TemporaryDirectory(prefix="lursor-skill-import-") as td:
        tmp = Path(td)
        try:
            store.write_tree(tmp, entries)
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        folders = store.find_skill_folders(tmp)
        if not folders:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "No SKILL.md found in the folder"
            )
        return [store.import_folder(src, root, taken=taken) for src in folders]


async def _index_imported(
    session: AsyncSession,
    imported: list[str],
    root: Path,
    *,
    origin: SkillOrigin,
    row_workspace_id: str | None,
    root_key: str,
    is_global: bool,
    workspace_ids: list[str],
) -> list[SkillRead]:
    """Index folders just written into ``root`` and apply their assignment.

    Reconcile is what indexes them — one code path for "a folder appeared in a
    root", however it got there — and it indexes a fresh catalog folder
    *unassigned*, so the requested assignment is applied here or an import lands
    somewhere the user can't see it working. A workspace-local import carries no
    assignment at all: where it applies is where its files are.
    """
    await reconcile(session)
    rows = (
        (
            await session.execute(
                select(Skill).where(
                    Skill.slug.in_(imported),
                    Skill.origin == origin,
                    Skill.root == root_key,
                    Skill.workspace_id == row_workspace_id
                    if row_workspace_id
                    else Skill.workspace_id.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )

    if origin != SkillOrigin.local:
        for row in rows:
            await _set_assignment(
                session, row, is_global=is_global, workspace_ids=workspace_ids
            )
        await session.commit()

    assigned = await _assignments(session)
    return [
        _to_read(row, root, workspace_ids=assigned.get(row.id, [])) for row in rows
    ]


@router.post("/import", response_model=list[SkillRead], status_code=status.HTTP_201_CREATED)
async def import_skills(
    files: list[UploadFile] = File(...),
    origin: SkillOrigin = Query(SkillOrigin.managed),
    workspace_id: str | None = Query(None),
    is_global: bool | None = Query(None),
    session: AsyncSession = Depends(get_session),
):
    """Import one or more skills.

    Accepts any of:

    - a **folder** upload — many files whose names carry their relative path
      (e.g. ``pdf-tools/SKILL.md``, ``pdf-tools/scripts/fill.py``);
    - a ``.zip`` of a standard skill folder (or a bundle of them);
    - a single ``SKILL.md`` / ``.md`` document.

    ``origin=managed`` (the default) imports into the catalog, assigned global
    unless ``workspace_id`` names one to scope it to. ``origin=local`` writes the
    folder into ``<workspace>/.agents/skills`` instead, so it can be committed.
    Bundled resources and ``scripts/`` are preserved; imported slugs are
    de-duplicated against what the target root already holds.
    """
    is_local = origin == SkillOrigin.local
    row_workspace_id = workspace_id if is_local else None
    root_key = store.DEFAULT_LOCAL_SKILL_ROOT if is_local else ""
    root = await _root_for(session, origin, workspace_id)
    taken = await _taken_slugs(
        session, root, origin, row_workspace_id, root_key=root_key
    )
    imported: list[str] = []

    # A folder upload arrives as multiple parts, or a single part whose name
    # still carries a subpath. Reconstruct the tree, then import every skill in it.
    is_folder = len(files) > 1 or (files and "/" in (files[0].filename or "").replace("\\", "/"))

    if is_folder:
        entries = [((f.filename or "").strip(), await f.read()) for f in files]
        imported.extend(await _import_tree(entries, root, taken))
    else:
        file = files[0]
        raw = await file.read()
        filename = (file.filename or "skill").strip()
        if filename.lower().endswith(".zip"):
            imported.extend(await _import_zip(raw, root, taken))
        elif filename.lower().endswith((".md", ".markdown", ".txt")):
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, "File is not valid UTF-8 text"
                ) from exc
            fallback = Path(filename).stem
            if fallback.upper() == "SKILL":
                fallback = "Imported Skill"
            imported.append(
                store.import_markdown(text, root, fallback_name=fallback, taken=taken)
            )
        else:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Unsupported upload; provide a folder, a .zip archive, or a "
                "SKILL.md / .md file",
            )

    resolved_global = is_global if is_global is not None else workspace_id is None
    return await _index_imported(
        session,
        imported,
        root,
        origin=origin,
        row_workspace_id=row_workspace_id,
        root_key=root_key,
        is_global=resolved_global,
        workspace_ids=[workspace_id] if workspace_id and not resolved_global else [],
    )


# --- Ingest a folder already on disk in a workspace -----------------------------


async def _workspace_dir(session: AsyncSession, workspace_id: str, rel: str) -> tuple[Path, Path]:
    """``(workspace root, target directory)`` for a workspace-relative folder.

    The path comes from a client, so it is joined onto the resolved root and
    rejected if it escapes it — ``..`` traversal, an absolute path, or a symlink
    pointing outside the workspace. Same guard as the files API, which is where
    these paths come from.
    """
    ws = await _workspace_or_404(session, workspace_id)
    root = Path(ws.path).expanduser()
    if not root.is_dir():
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Workspace has no accessible directory"
        )
    root = root.resolve()
    target = (root / rel).resolve()
    if target != root and not target.is_relative_to(root):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Path escapes workspace root")
    if not target.is_dir():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Folder not found")
    return root, target


def _fingerprint(name: str, description: str, content: str) -> tuple[str, str, str]:
    """Identity of a skill by what it *says*, independent of where it lives."""
    return (name.strip(), description.strip(), content.strip())


class _Known:
    """What the index already holds, as the two ways a folder can already be in it.

    ``folders`` catches a folder that is itself indexed — anything in a discovered
    root like ``.claude/skills``, where ingesting would add a second copy of a
    skill that already works. ``fingerprints`` catches the one the *source* folder
    can't know about: ingest copies a folder and leaves the original in place, so
    the original stays unindexed forever and would otherwise offer to be ingested
    again, and again, each time landing as ``foo-2``, ``foo-3``.
    """

    def __init__(self) -> None:
        self.folders: set[Path] = set()
        self.fingerprints: set[tuple[str, str, str]] = set()

    def holds(self, folder: Path, parsed: store.ParsedSkill) -> bool:
        with contextlib.suppress(OSError):
            if folder.resolve() in self.folders:
                return True
        return (
            _fingerprint(parsed.name, parsed.description, parsed.content)
            in self.fingerprints
        )


async def _known_skills(session: AsyncSession) -> _Known:
    """Everything the index already knows, by folder and by content."""
    workspaces = (await session.execute(select(Workspace))).scalars().all()
    ws_by_id = {w.id: w for w in workspaces}
    known = _Known()
    for row in (await session.execute(select(Skill))).scalars().all():
        known.fingerprints.add(_fingerprint(row.name, row.description, row.content))
        root = _root_for_row(row, ws_by_id)
        if root is None or not row.slug:
            continue
        with contextlib.suppress(OSError, ValueError):
            known.folders.add((root / row.slug).resolve())
    return known


@router.get("/scan", response_model=SkillScanResult)
async def scan_folder(
    workspace_id: str = Query(..., description="Workspace whose tree to look in"),
    path: str = Query("", description="Workspace-relative folder to scan"),
    session: AsyncSession = Depends(get_session),
):
    """Skill folders sitting in a workspace directory, managed or not.

    Read-only, and the question the file explorer asks before offering to ingest
    a folder: a directory with no ``SKILL.md`` under it offers nothing, so the
    action only appears where it means something. ``indexed`` marks a folder the
    manager already holds — the folder itself is in a discovered root, or the same
    skill has been ingested from it before — which is not worth ingesting again.
    The walk is bounded; see ``store.scan_skill_folders``.
    """
    root, target = await _workspace_dir(session, workspace_id, path)
    # Discovery is what decides ``indexed``, so reconcile first — same as every
    # other read path here. Without it a folder cloned in a moment ago reads as
    # unmanaged right up until something else lists skills.
    await reconcile(session)
    known = await _known_skills(session)
    out: list[SkillScanEntry] = []
    for folder in store.scan_skill_folders(target):
        parsed = store.read_skill(folder.name, folder.parent)
        if parsed is None:  # pragma: no cover — scan only returns SKILL.md folders
            continue
        out.append(
            SkillScanEntry(
                path=folder.relative_to(root).as_posix(),
                slug=folder.name,
                name=parsed.name,
                description=parsed.description,
                indexed=known.holds(folder, parsed),
            )
        )
    return SkillScanResult(skills=out)


@router.post("/ingest", response_model=list[SkillRead], status_code=status.HTTP_201_CREATED)
async def ingest_folder(
    payload: SkillIngest, session: AsyncSession = Depends(get_session)
):
    """Ingest skill folders the server can already see, without an upload.

    The sibling of ``POST /skills/import`` for a folder that is *in* a workspace:
    a vendored ``skills/`` directory, a cloned collection, anything sitting
    somewhere no configured root would ever discover. Every skill folder under
    ``path`` is **copied** into the destination — the source is left exactly as
    the repo put it, so nothing in a git tree moves or disappears.

    Two kinds of folder under ``path`` are skipped rather than copied: one already
    inside the destination root (which would be a copy onto itself, and is what
    makes ingesting a whole tree safe when the destination lives inside it), and
    one the index already holds — by folder or by content, so ingesting the same
    folder twice can't quietly leave ``foo`` and ``foo-2`` behind. Both are what
    the file explorer's menu filters on, so hitting either means there was nothing
    left to do.
    """
    _, src = await _workspace_dir(session, payload.workspace_id, payload.path)
    is_local = payload.origin == SkillOrigin.local
    root_key = store.DEFAULT_LOCAL_SKILL_ROOT if is_local else ""
    row_workspace_id = payload.workspace_id if is_local else None
    root = await _root_for(session, payload.origin, payload.workspace_id)

    await reconcile(session)
    known = await _known_skills(session)
    dest = root.resolve() if root.exists() else root
    found = store.scan_skill_folders(src)
    fresh: list[Path] = []
    for folder in found:
        if folder.resolve().is_relative_to(dest):
            continue
        parsed = store.read_skill(folder.name, folder.parent)
        if parsed is None or known.holds(folder, parsed):
            continue
        fresh.append(folder)
    if not fresh:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Already in your skills" if found else "No SKILL.md found in this folder",
        )

    taken = await _taken_slugs(
        session, root, payload.origin, row_workspace_id, root_key=root_key
    )
    root.mkdir(parents=True, exist_ok=True)
    imported: list[str] = []
    try:
        for folder in fresh:
            imported.append(store.import_folder(folder, root, taken=taken))
    except OSError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Could not copy skill folder: {exc}"
        ) from exc

    # A skill found in a repo is about that repo, so a managed ingest defaults to
    # being assigned there rather than everywhere.
    resolved_global = bool(payload.is_global)
    return await _index_imported(
        session,
        imported,
        root,
        origin=payload.origin,
        row_workspace_id=row_workspace_id,
        root_key=root_key,
        is_global=resolved_global,
        workspace_ids=[] if resolved_global else [payload.workspace_id],
    )


@router.get("/{skill_id}", response_model=SkillRead)
async def get_skill(skill_id: str, session: AsyncSession = Depends(get_session)):
    row = await _get_or_404(skill_id, session)
    root = await _row_root(session, row)
    assigned = await _assignments(session)
    env_links = await _env_links(session)
    return _to_read(
        row,
        root,
        workspace_ids=assigned.get(row.id, []),
        env_var_ids=env_links.get(row.id, []),
    )


@router.patch("/{skill_id}", response_model=SkillRead)
async def update_skill(
    skill_id: str, payload: SkillUpdate, session: AsyncSession = Depends(get_session)
):
    skill = await _get_or_404(skill_id, session)
    data = payload.model_dump(exclude_unset=True)
    # ``enabled`` is ours, not the file's. A toggle must not rewrite SKILL.md:
    # for a discovered skill that would dirty a git tree (or bump the mtime of a
    # file in someone's home directory) to record something the file never holds.
    writes_file = bool({"name", "description", "content"} & data.keys())
    root = (
        await _row_root_or_404(session, skill)
        if writes_file
        else await _row_root(session, skill)
    )
    for key, value in data.items():
        setattr(skill, key, value)
    if writes_file:
        # Rewrite SKILL.md; the slug (folder) stays stable across renames so any
        # bundled resources are preserved.
        store.write_skill(
            skill.slug,
            root,
            name=skill.name,
            description=skill.description,
            content=skill.content,
        )
    session.add(skill)
    await session.commit()
    await session.refresh(skill)
    assigned = await _assignments(session)
    env_links = await _env_links(session)
    return _to_read(
        skill,
        root,
        workspace_ids=assigned.get(skill.id, []),
        env_var_ids=env_links.get(skill.id, []),
    )


@router.delete("/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_skill(skill_id: str, session: AsyncSession = Depends(get_session)):
    skill = await _get_or_404(skill_id, session)
    # Allowed on a foreign root: deleting a discovered skill has always meant
    # deleting the real folder, and the UI names the absolute path before the
    # click. A root that has already vanished just drops the row.
    root = await _row_root(session, skill)
    if root is not None:
        store.delete_skill(skill.slug, root)
    # Links don't cascade in SQLite; drop them with the row so a recycled id can
    # never inherit another skill's assignment or secrets.
    await session.execute(
        delete(SkillWorkspaceLink).where(SkillWorkspaceLink.skill_id == skill.id)
    )
    await session.execute(
        delete(EnvVarSkillLink).where(EnvVarSkillLink.skill_id == skill.id)
    )
    await session.delete(skill)
    await session.commit()


# --- Bundled resource / script files -------------------------------------------


@router.get("/{skill_id}/files/{path:path}", response_model=SkillResourceContent)
async def read_skill_file(
    skill_id: str, path: str, session: AsyncSession = Depends(get_session)
):
    skill = await _get_or_404(skill_id, session)
    root = await _row_root_or_404(session, skill)
    try:
        return SkillResourceContent(content=store.read_file(skill.slug, root, path))
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found") from exc


@router.put("/{skill_id}/files/{path:path}", response_model=SkillRead)
async def write_skill_file(
    skill_id: str,
    path: str,
    payload: SkillResourceContent,
    session: AsyncSession = Depends(get_session),
):
    skill = await _get_or_404(skill_id, session)
    root = await _row_root_or_404(session, skill)
    try:
        store.write_file(skill.slug, root, path, payload.content)
        wrote_skill_md = store.is_skill_file(skill.slug, root, path)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    # Editing SKILL.md rewrites the frontmatter the name/description come from,
    # so refresh the index rather than waiting for the next reconcile.
    if wrote_skill_md and (parsed := store.read_skill(skill.slug, root)):
        skill.name = parsed.name
        skill.description = parsed.description
        skill.content = parsed.content
        session.add(skill)
        await session.commit()
        await session.refresh(skill)
    assigned = await _assignments(session)
    env_links = await _env_links(session)
    return _to_read(
        skill,
        root,
        workspace_ids=assigned.get(skill.id, []),
        env_var_ids=env_links.get(skill.id, []),
    )


@router.delete("/{skill_id}/files/{path:path}", response_model=SkillRead)
async def delete_skill_file(
    skill_id: str, path: str, session: AsyncSession = Depends(get_session)
):
    skill = await _get_or_404(skill_id, session)
    root = await _row_root_or_404(session, skill)
    try:
        store.delete_file(skill.slug, root, path)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    assigned = await _assignments(session)
    return _to_read(skill, root, workspace_ids=assigned.get(skill.id, []))
