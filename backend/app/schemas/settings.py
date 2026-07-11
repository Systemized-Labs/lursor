from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class OpenRouterSettingsRead(BaseModel):
    """Current OpenRouter key status. The raw key is never returned."""

    configured: bool
    key_hint: str | None = None  # last 4 chars, e.g. "…a1b2"
    # Where the effective key comes from: a UI-saved key ("database"), the
    # process environment / .env ("env"), or nothing ("none"). Only a
    # "database" key can be edited or cleared here.
    source: Literal["database", "env", "none"] = "none"


class OpenRouterSettingsUpdate(BaseModel):
    # A blank/omitted key clears the stored key and reverts to the environment
    # value (if any).
    api_key: str | None = None


class OpenRouterTestResult(BaseModel):
    """Result of probing a key against OpenRouter."""

    status: Literal["ok", "error"]
    label: str | None = None  # human-readable key label from OpenRouter, if any
    error: str | None = None
