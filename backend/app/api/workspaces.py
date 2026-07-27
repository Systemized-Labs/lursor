from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.config import get_settings
from app.db.models import Workspace
from app.db.session import get_session
from app.schemas.workspace import WorkspaceCreate, WorkspaceRead, WorkspaceUpdate
from app.workspace_paths import is_skills_catalog, unique_workspace_dir

router = APIRouter(prefix="/workspaces", tags=["workspaces"])
settings = get_settings()

# The skills catalog, registered as a workspace so the chat + dock surface works
# over it: an agent that can read, write and run scripts in ~/.lursor/skills is
# the whole of "author a skill with help".
#
# Deliberately *not* called "Skills" — that name already belongs to the manager
# (Customization → Skills), and two sidebar destinations with one name is a
# guessing game. The studio is where skills get written; the manager is where
# their reach gets decided.
SKILLS_WORKSPACE_NAME = "Skill Studio"
SKILLS_WORKSPACE_DESCRIPTION = (
    "Your skills catalog. Every folder here is a skill — ask for one and it gets "
    "written. Assign it from Customization → Skills."
)
# Names this workspace shipped with before. An adopted row keeps whatever the
# user called it (decision 4: rename is theirs), but a row still carrying a
# superseded *default* was never named by anyone — refresh it.
_SUPERSEDED_DEFAULT_NAMES = frozenset({"Skills"})

# Native "choose folder" dialogs. The backend runs on the user's own machine
# (local single-user app), so it can present the OS file explorer. Each command
# prints the selected path to stdout and exits non-zero on cancel.
#
# macOS and Windows ship their tool with the OS, but Linux/other Unix has no
# single guaranteed picker: GNOME provides ``zenity``, KDE provides ``kdialog``,
# and ``qarma`` is a common Qt-based ``zenity`` clone. We try each in turn and
# use the first one whose binary is actually installed.
_HOME = os.path.expanduser("~")
_FOLDER_DIALOGS: dict[str, list[list[str]]] = {
    "darwin": [
        [
            "osascript",
            "-e",
            'POSIX path of (choose folder with prompt "Select a workspace folder")',
        ]
    ],
    "linux": [
        ["zenity", "--file-selection", "--directory", "--title=Select a workspace folder"],
        ["kdialog", "--getexistingdirectory", _HOME, "--title", "Select a workspace folder"],
        ["qarma", "--file-selection", "--directory", "--title=Select a workspace folder"],
    ],
}


def _pick_folder_dialog() -> str | None:
    """Open the OS folder picker and return the chosen path, or None if cancelled.

    Blocking: call from a threadpool (a sync route) so the event loop is free.
    """
    if sys.platform.startswith("win"):
        # PowerShell's FolderBrowserDialog; empty output means the user cancelled.
        candidates = [
            [
                "powershell",
                "-NoProfile",
                "-STA",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms;"
                "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
                "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }",
            ]
        ]
    else:
        key = "darwin" if sys.platform == "darwin" else "linux"
        candidates = _FOLDER_DIALOGS[key]

    cmd = next((c for c in candidates if shutil.which(c[0]) is not None), None)
    if cmd is None:
        tools = ", ".join(dict.fromkeys(c[0] for c in candidates))
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED,
            f"No folder picker is available on this system. Install one of: {tools} "
            "(or type the workspace path manually).",
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


def _materialize(path: str | None, name: str) -> str:
    """Resolve and create a workspace directory, returning its absolute path.

    A blank/omitted ``path`` defaults to a slug of ``name`` under the workspaces
    root (e.g. ``<workspaces_dir>/swarmcore``), deduped on collision; a custom
    path has ``~`` expanded and is made absolute.
    """
    if path and path.strip():
        directory = Path(path.strip()).expanduser()
        if not directory.is_absolute():
            directory = directory.resolve()
    else:
        directory = unique_workspace_dir(settings.workspaces_dir, name)
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Could not create directory: {exc}"
        ) from exc
    return str(directory)


def is_system_workspace(ws: Workspace) -> bool:
    """True for the skills catalog workspace (``path == settings.skills_dir``)."""
    return is_skills_catalog(ws.path)


async def ensure_skills_workspace(session: AsyncSession) -> Workspace:
    """Register the skills catalog as a workspace, once.

    Idempotent, and adopts a workspace that already points at the catalog rather
    than adding a second one — so re-running on every boot is a no-op and a
    hand-made row keeps its id (and therefore its conversations).
    """
    result = await session.execute(select(Workspace).order_by(Workspace.created_at))
    for existing in result.scalars().all():
        if not is_system_workspace(existing):
            continue
        if existing.name in _SUPERSEDED_DEFAULT_NAMES:
            existing.name = SKILLS_WORKSPACE_NAME
            session.add(existing)
            await session.commit()
        return existing

    # ``settings.ensure_dirs()`` runs first in the lifespan, so the directory is
    # already there; ``mkdir`` here only covers direct callers (tests).
    directory = settings.skills_dir.expanduser()
    directory.mkdir(parents=True, exist_ok=True)
    ws = Workspace(
        name=SKILLS_WORKSPACE_NAME,
        description=SKILLS_WORKSPACE_DESCRIPTION,
        path=str(directory.resolve()),
    )
    session.add(ws)
    await session.commit()
    return ws


@router.get("", response_model=list[WorkspaceRead])
async def list_workspaces(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Workspace).order_by(Workspace.created_at))
    return [WorkspaceRead.from_workspace(w) for w in result.scalars().all()]


@router.post("", response_model=WorkspaceRead, status_code=status.HTTP_201_CREATED)
async def create_workspace(
    payload: WorkspaceCreate, session: AsyncSession = Depends(get_session)
):
    ws = Workspace(name=payload.name, description=payload.description)
    # Materialize the workspace directory (agent filesystem root).
    ws.path = _materialize(payload.path, ws.name)

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

    data = payload.model_dump(exclude_unset=True, exclude={"path"})
    for key, value in data.items():
        setattr(ws, key, value)
    # Relocating: materialize the new directory. The old one is left in place to
    # avoid destroying user files.
    if payload.path is not None:
        # The skills workspace *is* the catalog directory — moving it would point
        # the surface somewhere that isn't the skills the app reads. Renaming is
        # fine (a label, not a location). Checked before ``_materialize`` so a
        # refused move doesn't leave a stray directory behind; the edit dialog
        # echoes the current path back unchanged, which stays a no-op.
        if is_system_workspace(ws) and not is_skills_catalog(payload.path):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "The Skills workspace can't be moved — it points at your skills "
                "catalog. You can rename it.",
            )
        ws.path = _materialize(payload.path, ws.name)

    session.add(ws)
    await session.commit()
    return WorkspaceRead.from_workspace(ws)


@router.delete("/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workspace(workspace_id: str, session: AsyncSession = Depends(get_session)):
    ws = await session.get(Workspace, workspace_id)
    if ws is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    if is_system_workspace(ws):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "The Skills workspace can't be deleted — it's your skills catalog. "
            "Delete individual skills from Customization → Skills.",
        )
    # Intentionally leave the on-disk directory in place to avoid destroying user
    # files; only the database record is removed.
    await session.delete(ws)
    await session.commit()
