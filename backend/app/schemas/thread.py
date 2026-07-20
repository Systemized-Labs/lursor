from __future__ import annotations

from typing import Any

from pydantic import BaseModel, field_validator

from app.db.models import ThreadMode, ThreadStatus
from app.schemas._types import UTCDatetime


class ThreadCreate(BaseModel):
    workspace_id: str
    agent_id: str
    title: str = "New conversation"
    # Plan/goal mode (optional; a plain chat thread omits these).
    mode: ThreadMode = ThreadMode.chat
    goal: str = ""
    success_criteria: str = ""
    max_iterations: int = 25


class ThreadUpdate(BaseModel):
    """Partial update: rename a thread, swap its agent, or edit its plan/goal config.

    ``status`` is server-managed and intentionally not settable here.
    """

    title: str | None = None
    agent_id: str | None = None
    mode: ThreadMode | None = None
    goal: str | None = None
    success_criteria: str | None = None
    max_iterations: int | None = None


class ThreadRead(BaseModel):
    id: str
    title: str
    workspace_id: str
    agent_id: str
    mode: ThreadMode
    goal: str
    success_criteria: str
    status: ThreadStatus
    plan_path: str = ""
    iteration: int
    max_iterations: int
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
    kind: str = "chat"
    tool_calls: list[dict[str, Any]] = []
    attachments: list[MessageAttachment] = []
    created_at: UTCDatetime

    model_config = {"from_attributes": True}

    @field_validator("tool_calls", mode="before")
    @classmethod
    def _coerce_tool_calls(cls, v: Any) -> list[dict[str, Any]]:
        # Legacy rows stored an empty dict before tool calls were persisted as a
        # list; only a list carries real tool blocks, so anything else is empty.
        return v if isinstance(v, list) else []
