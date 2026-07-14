from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from app.db.models import GoalStatus, ThreadMode
from app.schemas._types import UTCDatetime


class ThreadCreate(BaseModel):
    workspace_id: str
    agent_id: str
    title: str = "New conversation"
    # Goal mode (optional; a plain chat thread omits these).
    mode: ThreadMode = ThreadMode.chat
    goal: str = ""
    success_criteria: str = ""
    max_iterations: int = 25
    require_plan_approval: bool = True


class ThreadUpdate(BaseModel):
    """Partial update: rename a thread, swap its agent, or edit its goal config.

    ``goal_status`` is server-managed and intentionally not settable here.
    """

    title: str | None = None
    agent_id: str | None = None
    mode: ThreadMode | None = None
    goal: str | None = None
    success_criteria: str | None = None
    max_iterations: int | None = None
    require_plan_approval: bool | None = None


class ThreadRead(BaseModel):
    id: str
    title: str
    workspace_id: str
    agent_id: str
    mode: ThreadMode
    goal: str
    success_criteria: str
    goal_status: GoalStatus
    iteration: int
    max_iterations: int
    require_plan_approval: bool
    last_reason: str
    todos_snapshot: list[Any] = []
    created_at: UTCDatetime
    updated_at: UTCDatetime

    model_config = {"from_attributes": True}


class MessageAttachment(BaseModel):
    """A reference to media stored on disk (see app.media_store)."""

    media_id: str
    mime_type: str
    filename: str | None = None


class MessageRead(BaseModel):
    id: str
    thread_id: str
    role: str
    content: str
    tool_calls: dict[str, Any]
    attachments: list[MessageAttachment] = []
    created_at: UTCDatetime

    model_config = {"from_attributes": True}
