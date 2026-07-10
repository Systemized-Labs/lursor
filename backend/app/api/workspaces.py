from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

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

# Native "choose folder" dialog per platform. The backend runs on the user's own
# machine (local single-user app), so it can present the OS file explorer. Each
# command prints the selected POSIX path to stdout and exits non-zero on cancel.
_FOLDER_DIALOGS: dict[str, list[str]] = {
    "darwin": [
        "osascript",
        "-e",
        'POSIX path of (choose folder with prompt "Select a workspace folder")',
    ],
    "linux": ["zenity", "--file-selection", "--directory", "--title=Select a workspace folder"],
}


def _pick_folder_dialog() -> str | None:
    """Open the OS folder picker and return the chosen path, or None if cancelled.

    Blocking: call from a threadpool (a sync route) so the event loop is free.
    """
    if sys.platform.startswith("win"):
        # PowerShell's FolderBrowserDialog; empty output means the user cancelled.
        cmd = [
            "powershell",
            "-NoProfile",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms;"
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
            "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }",
        ]
    else:
        key = "darwin" if sys.platform == "darwin" else "linux"
        cmd = _FOLDER_DIALOGS[key]

    if shutil.which(cmd[0]) is None:
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED,
            f"No folder picker available on this system (missing '{cmd[0]}').",
        )

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except (subprocess.SubprocessError, OSError) as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, f"Folder picker failed: {exc}"
        ) from exc

    path = result.stdout.strip()
    if result.returncode != 0 or not path:
        return None  # user cancelled
    return path.rstrip("/") or "/"


def _materialize(path: str | None, workspace_id: str) -> str:
    """Resolve and create a workspace directory, returning its absolute path.

    A blank/omitted ``path`` defaults to ``<workspaces_dir>/<id>``; a custom
    path has ``~`` expanded and is made absolute.
    """
    if path and path.strip():
        directory = Path(path.strip()).expanduser()
        if not directory.is_absolute():
            directory = directory.resolve()
    else:
        directory = settings.workspaces_dir / workspace_id
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Could not create directory: {exc}"
        ) from exc
    return str(directory)


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
    ws.path = _materialize(payload.path, ws.id)

    session.add(ws)
    await session.commit()
    return WorkspaceRead.from_workspace(ws)


@router.post("/pick-folder")
def pick_folder() -> dict[str, str | None]:
    """Open the OS folder explorer and return the selected path (``None`` if
    cancelled). Defined as a sync route so the blocking dialog runs off the
    event loop."""
    return {"path": _pick_folder_dialog()}


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

    data = payload.model_dump(exclude_unset=True, exclude={"agent_ids", "path"})
    for key, value in data.items():
        setattr(ws, key, value)
    if payload.agent_ids is not None:
        ws.agents = await _resolve(session, Agent, payload.agent_ids)
    # Relocating: materialize the new directory. The old one is left in place to
    # avoid destroying user files.
    if payload.path is not None:
        ws.path = _materialize(payload.path, ws.id)

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
