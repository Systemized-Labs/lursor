from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.api.agents import _resolve
from app.config import get_settings
from app.db.models import Agent, Workspace
from app.db.session import get_session
from app.schemas.workspace import WorkspaceCreate, WorkspaceRead, WorkspaceUpdate

router = APIRouter(prefix="/workspaces", tags=["workspaces"])
settings = get_settings()


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "workspace"


@router.get("", response_model=list[WorkspaceRead])
async def list_workspaces(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Workspace).order_by(Workspace.created_at))
    return [WorkspaceRead.from_workspace(w) for w in result.scalars().all()]


@router.post("", response_model=WorkspaceRead, status_code=status.HTTP_201_CREATED)
async def create_workspace(
    payload: WorkspaceCreate, session: AsyncSession = Depends(get_session)
):
    agents = await _resolve(session, Agent, payload.agent_ids)
    ws = Workspace(name=payload.name, description=payload.description, agents=agents)
    # Materialize the workspace directory (agent filesystem root).
    directory = settings.workspaces_dir / f"{_slugify(ws.name)}-{ws.id[:8]}"
    directory.mkdir(parents=True, exist_ok=True)
    ws.path = str(directory)

    session.add(ws)
    await session.commit()
    return WorkspaceRead.from_workspace(ws)


@router.get("/{workspace_id}", response_model=WorkspaceRead)
async def get_workspace(workspace_id: str, session: AsyncSession = Depends(get_session)):
    ws = await session.get(Workspace, workspace_id)
    if ws is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    return WorkspaceRead.from_workspace(ws)


@router.patch("/{workspace_id}", response_model=WorkspaceRead)
async def update_workspace(
    workspace_id: str,
    payload: WorkspaceUpdate,
    session: AsyncSession = Depends(get_session),
):
    ws = await session.get(Workspace, workspace_id)
    if ws is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")

    data = payload.model_dump(exclude_unset=True, exclude={"agent_ids"})
    for key, value in data.items():
        setattr(ws, key, value)
    if payload.agent_ids is not None:
        ws.agents = await _resolve(session, Agent, payload.agent_ids)

    session.add(ws)
    await session.commit()
    return WorkspaceRead.from_workspace(ws)


@router.delete("/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workspace(workspace_id: str, session: AsyncSession = Depends(get_session)):
    ws = await session.get(Workspace, workspace_id)
    if ws is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    # Intentionally leave the on-disk directory in place to avoid destroying user
    # files; only the database record is removed.
    await session.delete(ws)
    await session.commit()
