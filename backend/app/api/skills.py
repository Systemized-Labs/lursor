"""Skills API.

Skills are stored on disk as standard skill folders (``SKILL.md`` + optional
resources and ``scripts/``); see ``app/skills/store.py``. The ``skills`` DB table
is a rebuildable index over those folders so agents can link to a skill by id and
listing stays cheap.

``reconcile`` keeps the two in sync: DB rows whose folder is missing are
materialized from their cached content (auto-migrating pre-folder rows), skill
folders dropped on disk with no DB row get indexed, and rows with an existing
folder have their cache refreshed from disk (disk is authoritative).
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import Skill
from app.db.session import get_session
from app.schemas.skill import (
    SkillCreate,
    SkillRead,
    SkillResourceContent,
    SkillUpdate,
)
from app.skills import store

router = APIRouter(prefix="/skills", tags=["skills"])


def _to_read(row: Skill) -> SkillRead:
    """Compose a `SkillRead`, sourcing content/resources/scripts from disk."""
    parsed = store.read_skill(row.slug) if row.slug else None
    return SkillRead(
        id=row.id,
        slug=row.slug,
        name=parsed.name if parsed else row.name,
        description=parsed.description if parsed else row.description,
        content=parsed.content if parsed else row.content,
        resources=parsed.resources if parsed else [],
        scripts=parsed.scripts if parsed else [],
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def reconcile(session: AsyncSession) -> None:
    """Make the DB index and the on-disk skill folders consistent."""
    rows = (await session.execute(select(Skill))).scalars().all()
    taken = set(store.list_slugs()) | {r.slug for r in rows if r.slug}
    indexed: set[str] = set()
    dirty = False

    for row in rows:
        if not row.slug:
            row.slug = store.slugify(row.name, taken=taken)
            taken.add(row.slug)
            session.add(row)
            dirty = True
        indexed.add(row.slug)

        if not store.exists(row.slug):
            # Pre-folder row (or a deleted folder): materialize from the cache.
            store.write_skill(
                row.slug,
                name=row.name,
                description=row.description,
                content=row.content,
            )
        else:
            # Folder is authoritative: refresh the cache from disk.
            parsed = store.read_skill(row.slug)
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

    # Skill folders dropped on disk with no index row yet.
    for slug in store.list_slugs():
        if slug in indexed:
            continue
        parsed = store.read_skill(slug)
        if parsed is None:
            continue
        session.add(
            Skill(
                slug=slug,
                name=parsed.name,
                description=parsed.description,
                content=parsed.content,
            )
        )
        dirty = True

    if dirty:
        await session.commit()


async def _get_or_404(skill_id: str, session: AsyncSession) -> Skill:
    skill = await session.get(Skill, skill_id)
    if skill is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")
    return skill


@router.get("", response_model=list[SkillRead])
async def list_skills(session: AsyncSession = Depends(get_session)):
    await reconcile(session)
    result = await session.execute(select(Skill).order_by(Skill.created_at))
    return [_to_read(row) for row in result.scalars().all()]


@router.post("", response_model=SkillRead, status_code=status.HTTP_201_CREATED)
async def create_skill(payload: SkillCreate, session: AsyncSession = Depends(get_session)):
    taken = await _taken_slugs(session)
    slug = store.slugify(payload.name, taken=taken)
    store.write_skill(
        slug,
        name=payload.name,
        description=payload.description,
        content=payload.content,
    )
    skill = Skill(slug=slug, **payload.model_dump())
    session.add(skill)
    await session.commit()
    await session.refresh(skill)
    return _to_read(skill)


async def _taken_slugs(session: AsyncSession) -> set[str]:
    existing = (await session.execute(select(Skill.slug))).scalars().all()
    return set(store.list_slugs()) | {s for s in existing if s}


async def _import_zip(raw: bytes, taken: set[str]) -> list[str]:
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
        return [store.import_folder(src, taken=taken) for src in folders]


async def _import_tree(entries: list[tuple[str, bytes]], taken: set[str]) -> list[str]:
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
        return [store.import_folder(src, taken=taken) for src in folders]


@router.post("/import", response_model=list[SkillRead], status_code=status.HTTP_201_CREATED)
async def import_skills(
    files: list[UploadFile] = File(...), session: AsyncSession = Depends(get_session)
):
    """Import one or more skills.

    Accepts any of:

    - a **folder** upload — many files whose names carry their relative path
      (e.g. ``pdf-tools/SKILL.md``, ``pdf-tools/scripts/fill.py``);
    - a ``.zip`` of a standard skill folder (or a bundle of them);
    - a single ``SKILL.md`` / ``.md`` document.

    Bundled resources and ``scripts/`` are preserved. Imported slugs are
    de-duplicated against existing skills.
    """
    taken = await _taken_slugs(session)
    imported: list[str] = []

    # A folder upload arrives as multiple parts, or a single part whose name
    # still carries a subpath. Reconstruct the tree, then import every skill in it.
    is_folder = len(files) > 1 or (files and "/" in (files[0].filename or "").replace("\\", "/"))

    if is_folder:
        entries = [((f.filename or "").strip(), await f.read()) for f in files]
        imported.extend(await _import_tree(entries, taken))
    else:
        file = files[0]
        raw = await file.read()
        filename = (file.filename or "skill").strip()
        if filename.lower().endswith(".zip"):
            imported.extend(await _import_zip(raw, taken))
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
                store.import_markdown(text, fallback_name=fallback, taken=taken)
            )
        else:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Unsupported upload; provide a folder, a .zip archive, or a "
                "SKILL.md / .md file",
            )

    await reconcile(session)
    rows = (
        (await session.execute(select(Skill).where(Skill.slug.in_(imported))))
        .scalars()
        .all()
    )
    return [_to_read(row) for row in rows]


@router.get("/{skill_id}", response_model=SkillRead)
async def get_skill(skill_id: str, session: AsyncSession = Depends(get_session)):
    return _to_read(await _get_or_404(skill_id, session))


@router.patch("/{skill_id}", response_model=SkillRead)
async def update_skill(
    skill_id: str, payload: SkillUpdate, session: AsyncSession = Depends(get_session)
):
    skill = await _get_or_404(skill_id, session)
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(skill, key, value)
    # Rewrite SKILL.md; the slug (folder) stays stable across renames so agent
    # links and any bundled resources are preserved.
    store.write_skill(
        skill.slug,
        name=skill.name,
        description=skill.description,
        content=skill.content,
    )
    session.add(skill)
    await session.commit()
    await session.refresh(skill)
    return _to_read(skill)


@router.delete("/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_skill(skill_id: str, session: AsyncSession = Depends(get_session)):
    skill = await _get_or_404(skill_id, session)
    store.delete_skill(skill.slug)
    await session.delete(skill)
    await session.commit()


# --- Bundled resource / script files -------------------------------------------


@router.get("/{skill_id}/files/{path:path}", response_model=SkillResourceContent)
async def read_skill_file(
    skill_id: str, path: str, session: AsyncSession = Depends(get_session)
):
    skill = await _get_or_404(skill_id, session)
    try:
        return SkillResourceContent(content=store.read_file(skill.slug, path))
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
    try:
        store.write_file(skill.slug, path, payload.content)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _to_read(skill)


@router.delete("/{skill_id}/files/{path:path}", response_model=SkillRead)
async def delete_skill_file(
    skill_id: str, path: str, session: AsyncSession = Depends(get_session)
):
    skill = await _get_or_404(skill_id, session)
    try:
        store.delete_file(skill.slug, path)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _to_read(skill)
