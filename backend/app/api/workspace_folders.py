"""Sidebar groups for workspaces.

A folder is a label with a place in the list — see
:class:`~app.db.models.WorkspaceFolder`. Nothing here touches the filesystem:
filing a workspace into a group moves its sidebar row and leaves the checkout
where it is, and deleting a group turns its members loose at the root rather
than taking them with it.

Mounted at its own prefix rather than under ``/workspaces`` so the collection
routes can't be swallowed by ``/workspaces/{workspace_id}``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import Workspace, WorkspaceFolder
from app.db.session import get_session
from app.schemas.workspace import (
    SidebarLayout,
    WorkspaceFolderCreate,
    WorkspaceFolderRead,
    WorkspaceFolderUpdate,
)

router = APIRouter(prefix="/workspace-folders", tags=["workspaces"])


async def _folders(session: AsyncSession) -> list[WorkspaceFolder]:
    result = await session.execute(
        select(WorkspaceFolder).order_by(
            WorkspaceFolder.position, WorkspaceFolder.created_at
        )
    )
    return list(result.scalars().all())


async def next_root_position(session: AsyncSession) -> int:
    """One past the last row at the root, groups and loose workspaces alike."""
    folders = await _folders(session)
    loose = await session.execute(select(Workspace).where(Workspace.folder_id.is_(None)))
    positions = [f.position for f in folders] + [
        w.position for w in loose.scalars().all()
    ]
    return max(positions, default=-1) + 1


@router.get("", response_model=list[WorkspaceFolderRead])
async def list_folders(session: AsyncSession = Depends(get_session)):
    return [WorkspaceFolderRead.from_folder(f) for f in await _folders(session)]


@router.post("", response_model=WorkspaceFolderRead, status_code=status.HTTP_201_CREATED)
async def create_folder(
    payload: WorkspaceFolderCreate, session: AsyncSession = Depends(get_session)
):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A folder needs a name")
    folder = WorkspaceFolder(name=name, position=await next_root_position(session))
    session.add(folder)
    await session.commit()
    return WorkspaceFolderRead.from_folder(folder)


@router.put("/layout", response_model=list[WorkspaceFolderRead])
async def replace_layout(
    payload: SidebarLayout, session: AsyncSession = Depends(get_session)
):
    """Apply a whole new sidebar arrangement in one transaction.

    Rows the client didn't mention are left alone, and rows it mentions that no
    longer exist are skipped: a layout computed against a list that has since
    changed underneath still lands, instead of failing outright.
    """
    folders = {f.id: f for f in await _folders(session)}
    for placement in payload.folders:
        folder = folders.get(placement.id)
        if folder is None:
            continue
        folder.position = placement.position
        session.add(folder)

    for placement in payload.workspaces:
        ws = await session.get(Workspace, placement.id)
        if ws is None:
            continue
        if placement.folder_id is not None and placement.folder_id not in folders:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                f"Folder {placement.folder_id} not found",
            )
        ws.folder_id = placement.folder_id
        ws.position = placement.position
        session.add(ws)

    await session.commit()
    return [WorkspaceFolderRead.from_folder(f) for f in await _folders(session)]


@router.patch("/{folder_id}", response_model=WorkspaceFolderRead)
async def update_folder(
    folder_id: str,
    payload: WorkspaceFolderUpdate,
    session: AsyncSession = Depends(get_session),
):
    folder = await session.get(WorkspaceFolder, folder_id)
    if folder is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Folder not found")
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "A folder needs a name")
        folder.name = name
    session.add(folder)
    await session.commit()
    return WorkspaceFolderRead.from_folder(folder)


@router.delete("/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(folder_id: str, session: AsyncSession = Depends(get_session)):
    """Drop the group, keep the workspaces.

    A folder is a label, so deleting it can't be allowed to look like deleting
    the projects inside it. Members surface at the root, appended after
    everything already there in the order they had within the group.
    """
    folder = await session.get(WorkspaceFolder, folder_id)
    if folder is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Folder not found")

    members = await session.execute(
        select(Workspace)
        .where(Workspace.folder_id == folder_id)
        .order_by(Workspace.position, Workspace.created_at)
    )
    position = await next_root_position(session)
    for ws in members.scalars().all():
        ws.folder_id = None
        ws.position = position
        position += 1
        session.add(ws)

    await session.delete(folder)
    await session.commit()
