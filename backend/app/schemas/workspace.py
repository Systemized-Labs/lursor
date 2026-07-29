from __future__ import annotations

from pydantic import BaseModel

from app.db.models import Workspace, WorkspaceFolder
from app.schemas._types import UTCDatetime
from app.workspace_paths import is_skills_catalog


class WorkspaceCreate(BaseModel):
    name: str
    description: str = ""
    # Optional custom folder location. When omitted, the workspace defaults to
    # ``<workspaces_dir>/<id>``. ``~`` is expanded and the path is made absolute.
    path: str | None = None


class WorkspaceUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    path: str | None = None


class WorkspaceRead(BaseModel):
    id: str
    name: str
    description: str
    path: str
    # Computed, not stored: the app owns this workspace (currently only the
    # skills catalog). Systems workspaces can't be deleted or relocated.
    is_system: bool
    # Sidebar placement — the group this row is filed under (null = the root
    # level) and its slot among its siblings there.
    folder_id: str | None
    position: int
    created_at: UTCDatetime
    updated_at: UTCDatetime

    @classmethod
    def from_workspace(cls, ws: Workspace) -> WorkspaceRead:
        return cls(
            id=ws.id,
            name=ws.name,
            description=ws.description,
            path=ws.path,
            is_system=is_skills_catalog(ws.path),
            folder_id=ws.folder_id,
            position=ws.position,
            created_at=ws.created_at,
            updated_at=ws.updated_at,
        )


class WorkspaceFolderCreate(BaseModel):
    name: str


class WorkspaceFolderUpdate(BaseModel):
    name: str | None = None


class WorkspaceFolderRead(BaseModel):
    id: str
    name: str
    position: int
    created_at: UTCDatetime
    updated_at: UTCDatetime

    @classmethod
    def from_folder(cls, folder: WorkspaceFolder) -> WorkspaceFolderRead:
        return cls(
            id=folder.id,
            name=folder.name,
            position=folder.position,
            created_at=folder.created_at,
            updated_at=folder.updated_at,
        )


class FolderPlacement(BaseModel):
    id: str
    position: int


class WorkspacePlacement(BaseModel):
    id: str
    folder_id: str | None = None
    position: int


class SidebarLayout(BaseModel):
    """The sidebar's whole workspace tree, as the client wants it to look.

    Sent in full after every drag rather than as a delta: one drop can move a
    workspace between groups *and* renumber both of them, and a complete picture
    is idempotent — replaying it can't leave two rows fighting over one slot.
    """

    folders: list[FolderPlacement] = []
    workspaces: list[WorkspacePlacement] = []
