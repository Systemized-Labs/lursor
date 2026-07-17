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


WebSearchProvider = Literal["native", "duckduckgo", "tavily", "exa"]


class WebSearchSettingsRead(BaseModel):
    """Current web-search configuration. Raw API keys are never returned."""

    provider: WebSearchProvider
    # Per-provider key status. ``*_source`` mirrors OpenRouter's: a UI-saved key
    # ("database"), the environment/.env ("env"), or nothing ("none"). Only a
    # "database" key can be edited or cleared from the UI.
    tavily_configured: bool = False
    tavily_key_hint: str | None = None
    tavily_source: Literal["database", "env", "none"] = "none"
    exa_configured: bool = False
    exa_key_hint: str | None = None
    exa_source: Literal["database", "env", "none"] = "none"


class WebSearchSettingsUpdate(BaseModel):
    # Only fields present in the request body are applied (tracked via
    # ``model_fields_set``), so the provider and each key can be updated
    # independently. A present-but-blank key clears the stored key and reverts to
    # the environment value (if any).
    provider: WebSearchProvider | None = None
    tavily_api_key: str | None = None
    exa_api_key: str | None = None


# A slash command that can carry a default agent. ``chat`` is the plain,
# no-command turn. Grows as new commands are added (see the frontend registry).
CommandName = Literal["chat", "ask", "plan", "goal"]


class DefaultAgentsRead(BaseModel):
    """Per-command default agent id ("" when a command has no default agent)."""

    chat: str = ""
    ask: str = ""
    plan: str = ""
    goal: str = ""


class DefaultAgentsUpdate(BaseModel):
    # Only fields present in the request body are applied (tracked via
    # ``model_fields_set``), so each command can be set independently. A
    # present-but-blank value clears that command's default agent.
    chat: str | None = None
    ask: str | None = None
    plan: str | None = None
    goal: str | None = None
