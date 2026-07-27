from __future__ import annotations

import re

from pydantic import BaseModel, field_validator

from app.schemas._types import UTCDatetime

# POSIX-portable environment variable name. Enforced here rather than in the DB so
# the UI gets a clear 422 instead of an unusable var the shell silently ignores.
KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _validate_key(value: str) -> str:
    key = value.strip()
    if not KEY_PATTERN.match(key):
        raise ValueError(
            "Must start with a letter or underscore and contain only letters, "
            "digits, and underscores"
        )
    return key


class EnvVarAssignment(BaseModel):
    """Where a var applies: everywhere, in some workspaces, and/or on some skills."""

    is_global: bool = False
    workspace_ids: list[str] = []
    skill_ids: list[str] = []


class EnvVarCreate(BaseModel):
    key: str
    value: str = ""
    description: str = ""
    is_secret: bool = True
    is_global: bool = False
    workspace_ids: list[str] = []
    skill_ids: list[str] = []

    @field_validator("key")
    @classmethod
    def _key(cls, value: str) -> str:
        return _validate_key(value)


class EnvVarUpdate(BaseModel):
    key: str | None = None
    # Omitted keeps the stored value; "" clears it. Same convention as the
    # OpenRouter key in ``api/settings.py``, so a UI that never reads a secret
    # back can still save the rest of the row.
    value: str | None = None
    description: str | None = None
    is_secret: bool | None = None

    @field_validator("key")
    @classmethod
    def _key(cls, value: str | None) -> str | None:
        return None if value is None else _validate_key(value)


class EnvVarRead(BaseModel):
    id: str
    key: str
    description: str
    is_secret: bool
    is_global: bool
    workspace_ids: list[str] = []
    skill_ids: list[str] = []
    # Whether a value is stored. The value itself is returned only for a
    # non-secret var (``value`` is null for secrets, always).
    has_value: bool
    value: str | None = None
    created_at: UTCDatetime
    updated_at: UTCDatetime


class ResolvedEnvEntry(BaseModel):
    """One key in a workspace's effective environment. Never carries a value."""

    key: str
    description: str = ""
    # "global" | "workspace" | "skill:<slug>" — which layer won.
    source: str
    # Every layer that set this key, lowest precedence first. One entry means no
    # conflict; more than one means the later ones overrode the earlier.
    overridden: list[str] = []
    has_value: bool


class ResolvedEnvRead(BaseModel):
    workspace_id: str
    entries: list[ResolvedEnvEntry] = []
