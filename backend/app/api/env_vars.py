"""Environment variables API.

A var is a row plus assignments: ``is_global``, links to workspaces, and links to
skills (see :class:`app.db.models.EnvVar`). What a run actually gets is resolved
at build time in ``app/envvars/resolve.py`` and injected into the agent's shell
and its skill scripts (``agents/builder.py``, ``agents/deduping_backend.py``).

Two rules this module enforces so the runtime never has to guess:

- **Per-layer key uniqueness.** The same key may exist at different layers (a
  per-workspace ``DATABASE_URL`` over a global fallback) but not twice within one
  layer, so precedence is always well defined.
- **Write-only secrets.** A secret var's value is never returned — reads expose
  ``has_value``. Non-secret vars (a region, a flag) do return their value, which
  is the point of the flag.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import delete, select

from app.db.models import (
    EnvVar,
    EnvVarSkillLink,
    EnvVarWorkspaceLink,
    Skill,
    Workspace,
)
from app.db.session import get_session
from app.envvars.resolve import resolve_env
from app.schemas.env_var import (
    EnvVarAssignment,
    EnvVarCreate,
    EnvVarRead,
    EnvVarUpdate,
    ResolvedEnvEntry,
    ResolvedEnvRead,
)
from app.skills.resolve import skills_in_scope

router = APIRouter(prefix="/env-vars", tags=["env-vars"])


async def _get_or_404(env_var_id: str, session: AsyncSession) -> EnvVar:
    row = await session.get(EnvVar, env_var_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Environment variable not found")
    return row


async def _links(
    session: AsyncSession,
) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """(env_var_id -> workspace ids, env_var_id -> skill ids)."""
    workspaces: dict[str, list[str]] = {}
    skills: dict[str, list[str]] = {}
    for link in (await session.execute(select(EnvVarWorkspaceLink))).scalars().all():
        workspaces.setdefault(link.env_var_id, []).append(link.workspace_id)
    for link in (await session.execute(select(EnvVarSkillLink))).scalars().all():
        skills.setdefault(link.env_var_id, []).append(link.skill_id)
    return workspaces, skills


def _to_read(
    row: EnvVar, workspace_ids: list[str], skill_ids: list[str]
) -> EnvVarRead:
    return EnvVarRead(
        id=row.id,
        key=row.key,
        description=row.description,
        is_secret=row.is_secret,
        is_global=row.is_global,
        workspace_ids=workspace_ids,
        skill_ids=skill_ids,
        has_value=bool(row.value),
        value=None if row.is_secret else row.value,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _read_one(session: AsyncSession, row: EnvVar) -> EnvVarRead:
    workspaces, skills = await _links(session)
    return _to_read(row, workspaces.get(row.id, []), skills.get(row.id, []))


async def _assert_layer_unique(
    session: AsyncSession,
    *,
    key: str,
    exclude_id: str | None,
    is_global: bool,
    workspace_ids: list[str],
    skill_ids: list[str],
) -> None:
    """Reject a key that would collide with an existing var in the same layer.

    Without this, two global ``API_KEY`` rows would make the injected value depend
    on row order — a bug that only shows up as an agent using the wrong
    credentials, which is exactly the kind of thing that must fail loudly at save
    time instead.
    """
    candidates = (
        (await session.execute(select(EnvVar).where(EnvVar.key == key)))
        .scalars()
        .all()
    )
    candidates = [c for c in candidates if c.id != exclude_id]
    if not candidates:
        return

    ws_links, skill_links = await _links(session)
    if is_global and any(c.is_global for c in candidates):
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"A global variable named {key} already exists"
        )
    for workspace_id in workspace_ids:
        if any(workspace_id in ws_links.get(c.id, []) for c in candidates):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"{key} is already assigned to that workspace",
            )
    for skill_id in skill_ids:
        if any(skill_id in skill_links.get(c.id, []) for c in candidates):
            raise HTTPException(
                status.HTTP_409_CONFLICT, f"{key} is already assigned to that skill"
            )


async def _apply_assignment(
    session: AsyncSession,
    row: EnvVar,
    *,
    is_global: bool,
    workspace_ids: list[str],
    skill_ids: list[str],
) -> None:
    """Replace a var's assignment wholesale, validating every target exists."""
    for workspace_id in workspace_ids:
        if await session.get(Workspace, workspace_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    for skill_id in skill_ids:
        if await session.get(Skill, skill_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")

    await session.execute(
        delete(EnvVarWorkspaceLink).where(EnvVarWorkspaceLink.env_var_id == row.id)
    )
    await session.execute(
        delete(EnvVarSkillLink).where(EnvVarSkillLink.env_var_id == row.id)
    )
    row.is_global = is_global
    for workspace_id in dict.fromkeys(workspace_ids):
        session.add(EnvVarWorkspaceLink(env_var_id=row.id, workspace_id=workspace_id))
    for skill_id in dict.fromkeys(skill_ids):
        session.add(EnvVarSkillLink(env_var_id=row.id, skill_id=skill_id))
    session.add(row)


@router.get("", response_model=list[EnvVarRead])
async def list_env_vars(
    workspace_id: str | None = Query(
        None, description="Only vars assigned to this workspace (or global)."
    ),
    skill_id: str | None = Query(None, description="Only vars assigned to this skill."),
    session: AsyncSession = Depends(get_session),
):
    rows = (
        (await session.execute(select(EnvVar).order_by(EnvVar.key))).scalars().all()
    )
    workspaces, skills = await _links(session)
    if workspace_id is not None:
        rows = [
            r for r in rows if r.is_global or workspace_id in workspaces.get(r.id, [])
        ]
    if skill_id is not None:
        rows = [r for r in rows if skill_id in skills.get(r.id, [])]
    return [
        _to_read(row, workspaces.get(row.id, []), skills.get(row.id, []))
        for row in rows
    ]


@router.post("", response_model=EnvVarRead, status_code=status.HTTP_201_CREATED)
async def create_env_var(
    payload: EnvVarCreate, session: AsyncSession = Depends(get_session)
):
    await _assert_layer_unique(
        session,
        key=payload.key,
        exclude_id=None,
        is_global=payload.is_global,
        workspace_ids=payload.workspace_ids,
        skill_ids=payload.skill_ids,
    )
    row = EnvVar(
        key=payload.key,
        value=payload.value,
        description=payload.description,
        is_secret=payload.is_secret,
    )
    session.add(row)
    await session.flush()  # need row.id for the link rows
    await _apply_assignment(
        session,
        row,
        is_global=payload.is_global,
        workspace_ids=payload.workspace_ids,
        skill_ids=payload.skill_ids,
    )
    await session.commit()
    await session.refresh(row)
    return await _read_one(session, row)


@router.patch("/{env_var_id}", response_model=EnvVarRead)
async def update_env_var(
    env_var_id: str,
    payload: EnvVarUpdate,
    session: AsyncSession = Depends(get_session),
):
    row = await _get_or_404(env_var_id, session)
    data = payload.model_dump(exclude_unset=True)
    if "key" in data and data["key"] != row.key:
        workspaces, skills = await _links(session)
        await _assert_layer_unique(
            session,
            key=data["key"],
            exclude_id=row.id,
            is_global=row.is_global,
            workspace_ids=workspaces.get(row.id, []),
            skill_ids=skills.get(row.id, []),
        )
    for field, value in data.items():
        setattr(row, field, value)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return await _read_one(session, row)


@router.put("/{env_var_id}/assignment", response_model=EnvVarRead)
async def set_env_var_assignment(
    env_var_id: str,
    payload: EnvVarAssignment,
    session: AsyncSession = Depends(get_session),
):
    row = await _get_or_404(env_var_id, session)
    await _assert_layer_unique(
        session,
        key=row.key,
        exclude_id=row.id,
        is_global=payload.is_global,
        workspace_ids=payload.workspace_ids,
        skill_ids=payload.skill_ids,
    )
    await _apply_assignment(
        session,
        row,
        is_global=payload.is_global,
        workspace_ids=payload.workspace_ids,
        skill_ids=payload.skill_ids,
    )
    await session.commit()
    await session.refresh(row)
    return await _read_one(session, row)


@router.get("/resolved", response_model=ResolvedEnvRead)
async def resolved_env(
    workspace_id: str = Query(...),
    session: AsyncSession = Depends(get_session),
):
    """The effective environment for a workspace — keys and provenance, no values.

    This is the debugging tool when a skill reports missing credentials: it shows
    exactly what a run there would receive, which layer each key came from, and
    which keys are shadowing another layer.
    """
    ws = await session.get(Workspace, workspace_id)
    if ws is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    scoped = await skills_in_scope(
        session, workspace_path=ws.path, workspace_id=workspace_id
    )
    resolved = await resolve_env(
        session, workspace_id=workspace_id, skill_ids=[s.skill_id for s in scoped]
    )
    entries = [
        ResolvedEnvEntry(
            key=key,
            description=resolved.descriptions.get(key, ""),
            source=resolved.provenance[key],
            overridden=resolved.conflicts.get(key, []),
            has_value=bool(value),
        )
        for key, value in sorted(resolved.values.items())
    ]
    return ResolvedEnvRead(workspace_id=workspace_id, entries=entries)


@router.get("/{env_var_id}", response_model=EnvVarRead)
async def get_env_var(env_var_id: str, session: AsyncSession = Depends(get_session)):
    row = await _get_or_404(env_var_id, session)
    return await _read_one(session, row)


@router.delete("/{env_var_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_env_var(env_var_id: str, session: AsyncSession = Depends(get_session)):
    row = await _get_or_404(env_var_id, session)
    await session.execute(
        delete(EnvVarWorkspaceLink).where(EnvVarWorkspaceLink.env_var_id == row.id)
    )
    await session.execute(
        delete(EnvVarSkillLink).where(EnvVarSkillLink.env_var_id == row.id)
    )
    await session.delete(row)
    await session.commit()
