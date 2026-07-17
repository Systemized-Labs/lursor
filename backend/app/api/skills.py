"""Skills API.

Skills are stored on disk as standard skill folders (``SKILL.md`` + optional
resources and ``scripts/``); see ``app/skills/store.py``. They come from two
**scopes** (like Claude Code):

- **global** — ``settings.skills_dir`` (``~/.lursor/skills/``): every agent, every
  workspace.
- **workspace** — ``<workspace.path>/.agents/skills/``: only while an agent runs
  in that workspace.

The ``skills`` DB table is a rebuildable index over both roots so listing stays
cheap and the UI has a stable id per skill. Skills are **not** linked to agents —
an agent discovers whatever exists in the global scope plus its current
workspace's scope at build time (see ``agents/builder.py``).

``reconcile`` keeps the index and the on-disk folders in sync, per root: DB rows
whose folder is missing are materialized from their cached content (auto-migrating
pre-folder rows), skill folders on disk with no DB row get indexed, and rows with
an existing folder have their cache refreshed from disk (disk is authoritative).
Workspace rows whose workspace no longer exists are dropped.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import Skill, SkillScope, Workspace
from app.db.session import get_session
from app.schemas.skill import (
    SkillCreate,
    SkillRead,
    SkillResourceContent,
    SkillUpdate,
)
from app.skills import store

router = APIRouter(prefix="/skills", tags=["skills"])


# --- Scope → on-disk root resolution -------------------------------------------


async def _root_for(
    session: AsyncSession, scope: SkillScope, workspace_id: str | None
) -> Path:
    """Resolve the on-disk skills root for a (scope, workspace) pair."""
    if scope == SkillScope.workspace:
        if not workspace_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "workspace_id is required for a workspace-scoped skill",
            )
        ws = await session.get(Workspace, workspace_id)
        if ws is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
        return store.workspace_skills_root(ws.path)
    return store.global_skills_root()


def _root_for_row(row: Skill, ws_by_id: dict[str, Workspace]) -> Path | None:
    """Root for an already-loaded row, or ``None`` if its workspace is gone."""
    if row.scope == SkillScope.workspace:
        ws = ws_by_id.get(row.workspace_id or "")
        return store.workspace_skills_root(ws.path) if ws else None
    return store.global_skills_root()


def _to_read(row: Skill, root: Path | None) -> SkillRead:
    """Compose a `SkillRead`, sourcing content/resources/scripts from disk."""
    parsed = store.read_skill(row.slug, root) if (root and row.slug) else None
    return SkillRead(
        id=row.id,
        slug=row.slug,
        name=parsed.name if parsed else row.name,
        description=parsed.description if parsed else row.description,
        content=parsed.content if parsed else row.content,
        scope=row.scope,
        workspace_id=row.workspace_id,
        resources=parsed.resources if parsed else [],
        scripts=parsed.scripts if parsed else [],
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# --- Reconcile -----------------------------------------------------------------


def _reconcile_root(
    session: AsyncSession,
    root: Path,
    rows: list[Skill],
    *,
    scope: SkillScope,
    workspace_id: str | None,
) -> bool:
    """Sync one scope's DB rows against its on-disk folder. Returns whether dirty."""
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

    # Skill folders on disk with no index row yet.
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
                scope=scope,
                workspace_id=workspace_id,
            )
        )
        dirty = True

    return dirty


async def reconcile(session: AsyncSession) -> None:
    """Make the DB index and the on-disk skill folders consistent, per scope."""
    workspaces = (await session.execute(select(Workspace))).scalars().all()
    ws_by_id = {w.id: w for w in workspaces}
    rows = (await session.execute(select(Skill))).scalars().all()
    dirty = False

    # Global scope.
    global_rows = [r for r in rows if r.scope == SkillScope.global_]
    dirty |= _reconcile_root(
        session,
        store.global_skills_root(),
        global_rows,
        scope=SkillScope.global_,
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
            if r.scope == SkillScope.workspace and r.workspace_id == ws.id
        ]
        dirty |= _reconcile_root(
            session,
            store.workspace_skills_root(ws.path),
            ws_rows,
            scope=SkillScope.workspace,
            workspace_id=ws.id,
        )

    # Drop workspace rows whose workspace no longer exists at all.
    for row in rows:
        if row.scope == SkillScope.workspace and row.workspace_id not in ws_by_id:
            await session.delete(row)
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
    session: AsyncSession, root: Path, scope: SkillScope, workspace_id: str | None
) -> set[str]:
    """Slugs already used within one scope's root (disk + DB)."""
    stmt = select(Skill.slug).where(Skill.scope == scope)
    stmt = (
        stmt.where(Skill.workspace_id == workspace_id)
        if workspace_id
        else stmt.where(Skill.workspace_id.is_(None))
    )
    existing = (await session.execute(stmt)).scalars().all()
    return set(store.list_slugs(root)) | {s for s in existing if s}


@router.get("", response_model=list[SkillRead])
async def list_skills(
    scope: SkillScope | None = Query(None),
    workspace_id: str | None = Query(None),
    session: AsyncSession = Depends(get_session),
):
    """List skills, optionally filtered to one scope / workspace."""
    await reconcile(session)
    workspaces = (await session.execute(select(Workspace))).scalars().all()
    ws_by_id = {w.id: w for w in workspaces}

    stmt = select(Skill)
    if scope is not None:
        stmt = stmt.where(Skill.scope == scope)
    if workspace_id is not None:
        stmt = stmt.where(Skill.workspace_id == workspace_id)
    stmt = stmt.order_by(Skill.created_at)

    rows = (await session.execute(stmt)).scalars().all()
    return [_to_read(row, _root_for_row(row, ws_by_id)) for row in rows]


@router.post("", response_model=SkillRead, status_code=status.HTTP_201_CREATED)
async def create_skill(payload: SkillCreate, session: AsyncSession = Depends(get_session)):
    # Global skills never carry a workspace; normalize so the row is consistent.
    workspace_id = payload.workspace_id if payload.scope == SkillScope.workspace else None
    root = await _root_for(session, payload.scope, workspace_id)
    taken = await _taken_slugs(session, root, payload.scope, workspace_id)
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
        scope=payload.scope,
        workspace_id=workspace_id,
    )
    session.add(skill)
    await session.commit()
    await session.refresh(skill)
    return _to_read(skill, root)


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
    scope: SkillScope = Query(SkillScope.global_),
    workspace_id: str | None = Query(None),
    session: AsyncSession = Depends(get_session),
):
    """Import one or more skills into a scope (default global).

    Accepts any of:

    - a **folder** upload — many files whose names carry their relative path
      (e.g. ``pdf-tools/SKILL.md``, ``pdf-tools/scripts/fill.py``);
    - a ``.zip`` of a standard skill folder (or a bundle of them);
    - a single ``SKILL.md`` / ``.md`` document.

    Bundled resources and ``scripts/`` are preserved. Imported slugs are
    de-duplicated against existing skills in the target scope.
    """
    workspace_id = workspace_id if scope == SkillScope.workspace else None
    root = await _root_for(session, scope, workspace_id)
    taken = await _taken_slugs(session, root, scope, workspace_id)
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
                    Skill.scope == scope,
                    Skill.workspace_id == workspace_id
                    if workspace_id
                    else Skill.workspace_id.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    return [_to_read(row, root) for row in rows]


@router.get("/{skill_id}", response_model=SkillRead)
async def get_skill(skill_id: str, session: AsyncSession = Depends(get_session)):
    row = await _get_or_404(skill_id, session)
    root = await _root_for(session, row.scope, row.workspace_id)
    return _to_read(row, root)


@router.patch("/{skill_id}", response_model=SkillRead)
async def update_skill(
    skill_id: str, payload: SkillUpdate, session: AsyncSession = Depends(get_session)
):
    skill = await _get_or_404(skill_id, session)
    root = await _root_for(session, skill.scope, skill.workspace_id)
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
    return _to_read(skill, root)


@router.delete("/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_skill(skill_id: str, session: AsyncSession = Depends(get_session)):
    skill = await _get_or_404(skill_id, session)
    root = await _root_for(session, skill.scope, skill.workspace_id)
    store.delete_skill(skill.slug, root)
    await session.delete(skill)
    await session.commit()


# --- Bundled resource / script files -------------------------------------------


@router.get("/{skill_id}/files/{path:path}", response_model=SkillResourceContent)
async def read_skill_file(
    skill_id: str, path: str, session: AsyncSession = Depends(get_session)
):
    skill = await _get_or_404(skill_id, session)
    root = await _root_for(session, skill.scope, skill.workspace_id)
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
    root = await _root_for(session, skill.scope, skill.workspace_id)
    try:
        store.write_file(skill.slug, root, path, payload.content)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _to_read(skill, root)


@router.delete("/{skill_id}/files/{path:path}", response_model=SkillRead)
async def delete_skill_file(
    skill_id: str, path: str, session: AsyncSession = Depends(get_session)
):
    skill = await _get_or_404(skill_id, session)
    root = await _root_for(session, skill.scope, skill.workspace_id)
    try:
        store.delete_file(skill.slug, root, path)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _to_read(skill, root)
