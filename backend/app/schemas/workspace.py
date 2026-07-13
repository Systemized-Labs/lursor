from __future__ import annotations

from pydantic import BaseModel

from app.db.models import Workspace
from app.schemas._types import UTCDatetime


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
    created_at: UTCDatetime
    updated_at: UTCDatetime

    @classmethod
    def from_workspace(cls, ws: Workspace) -> WorkspaceRead:
        return cls(
            id=ws.id,
            name=ws.name,
            description=ws.description,
            path=ws.path,
            created_at=ws.created_at,
            updated_at=ws.updated_at,
        )
