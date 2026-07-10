from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel


class ThreadCreate(BaseModel):
    workspace_id: str
    agent_id: str
    title: str = "New conversation"


class ThreadRead(BaseModel):
    id: str
    title: str
    workspace_id: str
    agent_id: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class MessageRead(BaseModel):
    id: str
    thread_id: str
    role: str
    content: str
    tool_calls: dict[str, Any]
    created_at: datetime

    model_config = {"from_attributes": True}
