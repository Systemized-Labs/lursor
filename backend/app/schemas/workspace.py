from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from app.db.models import Workspace


class WorkspaceCreate(BaseModel):
    name: str
    description: str = ""
    agent_ids: list[str] = []


class WorkspaceUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    agent_ids: list[str] | None = None


class WorkspaceRead(BaseModel):
    id: str
    name: str
    description: str
    path: str
    agent_ids: list[str]
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_workspace(cls, ws: Workspace) -> WorkspaceRead:
        return cls(
            id=ws.id,
            name=ws.name,
            description=ws.description,
            path=ws.path,
            agent_ids=[a.id for a in ws.agents],
            created_at=ws.created_at,
            updated_at=ws.updated_at,
        )
