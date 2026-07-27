"""Skills API.

Skills are stored on disk as standard skill folders (``SKILL.md`` + optional
resources and ``scripts/``); see ``app/skills/store.py``. A skill folder lives in
one of two kinds of root, which is what :class:`SkillOrigin` records:

- **managed** — the catalog, ``settings.skills_dir`` (``~/.lursor/skills/``). One
  copy, wherever it applies: reach is an *assignment* in the database
  (``is_global``, or ``skill_workspaces`` rows), so re-pointing a skill at other
  workspaces is a DB write and never moves files.
- **local** — ``<workspace.path>/.agents/skills/``, committed into a repo. It
  applies only in that workspace and has no assignment to edit;
  ``POST /skills/{id}/promote`` moves the folder into the catalog and turns it
  into a managed skill (the only operation here that moves files out of a repo).

The ``skills`` DB table is a rebuildable index over those roots so listing stays
cheap and the UI has a stable id per skill — which is also what assignments and
env vars hang off. Skills are **not** linked to agents: an agent discovers
whatever is in scope for the workspace it runs in (``app/skills/resolve.py``).

``reconcile`` keeps the index and the on-disk folders in sync, per root: DB rows
whose folder is missing are materialized from their cached content (auto-migrating
pre-folder rows), skill folders on disk with no DB row get indexed, and rows with
an existing folder have their cache refreshed from disk (disk is authoritative).
Local rows whose workspace is gone are dropped, along with any assignment or
env-var link pointing at a workspace/skill that no longer exists.
"""

from __future__ import annotations

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
    SkillPromote,
    SkillRead,
    SkillResourceContent,
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
    """Resolve the on-disk root a skill of this origin belongs in."""
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
    """Root for an already-loaded row, or ``None`` if its workspace is gone."""
    if row.origin == SkillOrigin.local:
        ws = ws_by_id.get(row.workspace_id or "")
        return store.workspace_skills_root(ws.path) if ws else None
    return store.catalog_root()


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


def _reconcile_root(
    session: AsyncSession,
    root: Path,
    rows: list[Skill],
    *,
    origin: SkillOrigin,
    workspace_id: str | None,
) -> bool:
    """Sync one root's DB rows against its on-disk folders. Returns whether dirty."""
    taken = set(store.list_slugs(root)) | {r.slug for r in rows if r.slug}
    indexed: set[str] = set()
    dirty = False

    for row in rows:
        if not row.slug:
            row.slug = store.slugify(row.name, taken=taken)
            taken.add(row.slug)
            session.add(row)
            dirty = True
        indexed.add(row.slug)

        if not store.exists(row.slug, root):
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
            )
        )
        dirty = True

    return dirty


async def reconcile(session: AsyncSession) -> None:
    """Make the DB index and the on-disk skill folders consistent, per root."""
    workspaces = (await session.execute(select(Workspace))).scalars().all()
    ws_by_id = {w.id: w for w in workspaces}
    rows = (await session.execute(select(Skill))).scalars().all()
    dirty = False

    # The catalog.
    dirty |= _reconcile_root(
        session,
        store.catalog_root(),
        [r for r in rows if r.origin == SkillOrigin.managed],
        origin=SkillOrigin.managed,
        workspace_id=None,
    )

    # One root per existing workspace. Skip a workspace whose directory is gone so
    # we don't resurrect a deleted workspace folder by materializing skills into it.
    for ws in workspaces:
        if not Path(ws.path).is_dir():
            continue
        ws_rows = [
            r
            for r in rows
            if r.origin == SkillOrigin.local and r.workspace_id == ws.id
        ]
        dirty |= _reconcile_root(
            session,
            store.workspace_skills_root(ws.path),
            ws_rows,
            origin=SkillOrigin.local,
            workspace_id=ws.id,
        )

    # Drop local rows whose workspace no longer exists at all.
    live_ids = {r.id for r in rows}
    for row in rows:
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
    session: AsyncSession, root: Path, origin: SkillOrigin, workspace_id: str | None
) -> set[str]:
    """Slugs already used within one root (disk + DB)."""
    stmt = select(Skill.slug).where(Skill.origin == origin)
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
        pattern="^(all|global|unassigned|workspace|local)$",
        description=(
            "all — every skill; global — assigned everywhere; unassigned — in the "
            "catalog but applying nowhere; workspace — everything in scope for "
            "`workspace_id`, tagged with the layer it won at; local — skills living "
            "in a repo's .agents/skills (optionally filtered to `workspace_id`)."
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
    root = await _root_for(session, payload.origin, payload.workspace_id)
    taken = await _taken_slugs(session, root, payload.origin, workspace_id)
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
    if skill.origin == SkillOrigin.local:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This skill lives in its workspace's .agents/skills folder. Promote it "
            "into the catalog first to assign it elsewhere.",
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
    is always explicit. With no body, the promoted skill stays assigned to the
    workspace it came from — its reach doesn't change, only its ability to be
    re-pointed.
    """
    skill = await _get_or_404(skill_id, session)
    if skill.origin != SkillOrigin.local:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This skill is already in the catalog"
        )
    if not skill.workspace_id:  # pragma: no cover — reconcile drops orphans
        raise HTTPException(status.HTTP_409_CONFLICT, "Skill has no owning workspace")

    origin_workspace_id = skill.workspace_id
    ws = await _workspace_or_404(session, origin_workspace_id)
    src_root = store.workspace_skills_root(ws.path)
    catalog = store.catalog_root()
    taken = await _taken_slugs(session, catalog, SkillOrigin.managed, None)

    try:
        skill.slug = store.move_skill(skill.slug, src_root, catalog, taken=taken)
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Could not move skill folder: {exc}"
        ) from exc
    skill.origin = SkillOrigin.managed
    skill.workspace_id = None

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
    root = await _root_for(session, origin, workspace_id)
    taken = await _taken_slugs(session, root, origin, row_workspace_id)
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

    await reconcile(session)
    rows = (
        (
            await session.execute(
                select(Skill).where(
                    Skill.slug.in_(imported),
                    Skill.origin == origin,
                    Skill.workspace_id == row_workspace_id
                    if row_workspace_id
                    else Skill.workspace_id.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )

    # Reconcile indexes a fresh catalog folder unassigned; apply the requested
    # assignment so an import lands somewhere useful straight away.
    if not is_local:
        resolved_global = is_global if is_global is not None else workspace_id is None
        for row in rows:
            await _set_assignment(
                session,
                row,
                is_global=resolved_global,
                workspace_ids=[workspace_id] if workspace_id and not resolved_global else [],
            )
        await session.commit()

    assigned = await _assignments(session)
    return [
        _to_read(row, root, workspace_ids=assigned.get(row.id, [])) for row in rows
    ]


@router.get("/{skill_id}", response_model=SkillRead)
async def get_skill(skill_id: str, session: AsyncSession = Depends(get_session)):
    row = await _get_or_404(skill_id, session)
    root = await _root_for(session, row.origin, row.workspace_id)
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
    root = await _root_for(session, skill.origin, skill.workspace_id)
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(skill, key, value)
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
    root = await _root_for(session, skill.origin, skill.workspace_id)
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
    root = await _root_for(session, skill.origin, skill.workspace_id)
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
    root = await _root_for(session, skill.origin, skill.workspace_id)
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
    root = await _root_for(session, skill.origin, skill.workspace_id)
    try:
        store.delete_file(skill.slug, root, path)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    assigned = await _assignments(session)
    return _to_read(skill, root, workspace_ids=assigned.get(skill.id, []))
