from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


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


# App-wide memory backend for every agent with ``include_memory`` on: "file" is
# pydantic-deep's per-workspace MEMORY.md (the default), "hindsight" is a
# tag-scoped Hindsight memory bank. See ``agents/hindsight.py``.
MemoryProvider = Literal["file", "hindsight"]
# "workspace" partitions the bank by workspace tag; "shared" puts the whole bank
# in scope for every workspace (the bring-your-own-bank mode).
MemoryIsolation = Literal["workspace", "shared"]
RecallBudget = Literal["low", "mid", "high"]


class MemorySettingsRead(BaseModel):
    """Current memory configuration. The raw Hindsight key is never returned."""

    provider: MemoryProvider
    # False when the optional ``hindsight`` extra isn't installed in the backend
    # process — the provider can be selected but silently degrades to file
    # memory, so the UI needs to say so.
    hindsight_installed: bool = True
    hindsight_base_url: str | None = None
    # Key status, mirroring the OpenRouter/Tavily shape: a UI-saved key
    # ("database"), the environment/.env ("env"), or nothing ("none"). Only a
    # "database" key can be edited or cleared from the UI. A key is optional —
    # a self-hosted instance usually needs none.
    hindsight_configured: bool = False
    hindsight_key_hint: str | None = None
    hindsight_source: Literal["database", "env", "none"] = "none"
    bank_id: str
    isolation: MemoryIsolation
    budget: RecallBudget
    max_tokens: int
    inject_memories: bool
    include_reflect: bool
    extra_recall_tags: list[str] = []
    recall_query: str = ""


class MemorySettingsUpdate(BaseModel):
    # Partial, like ``WebSearchSettingsUpdate``: only fields present in the
    # request body are applied, so the provider, the connection, and each tuning
    # knob save independently. A present-but-blank ``hindsight_api_key`` clears
    # the stored key and reverts to the environment value (if any).
    provider: MemoryProvider | None = None
    hindsight_base_url: str | None = None
    hindsight_api_key: str | None = None
    bank_id: str | None = None
    isolation: MemoryIsolation | None = None
    budget: RecallBudget | None = None
    max_tokens: int | None = Field(default=None, gt=0)
    inject_memories: bool | None = None
    include_reflect: bool | None = None
    extra_recall_tags: list[str] | None = None
    recall_query: str | None = None


class MemoryTestResult(BaseModel):
    """Result of probing a Hindsight instance with unsaved values."""

    status: Literal["ok", "error"]
    version: str | None = None  # api_version reported by the instance
    bank_exists: bool | None = None
    memory_count: int | None = None  # facts in the bank, when the instance reports it
    error: str | None = None


class CompactionDefaultsRead(BaseModel):
    """The app-wide compaction defaults every agent falls back to.

    Read by the Settings page (where they are edited) *and* by the agent/subagent
    forms, so a row with no override of its own can show the value it actually
    resolves to. Per-agent overrides live on the agent/subagent rows.
    """

    # The effective values: fraction of the context window at which compaction
    # fires, and fraction of the history it folds into the summary (1.0 = all).
    threshold: float
    ratio: float
    # Where each effective value comes from — a value saved here ("database") or
    # the process environment / .env ("env"), mirroring the OpenRouter and memory
    # sections. Only a "database" value can be reset.
    threshold_source: Literal["database", "env"] = "env"
    ratio_source: Literal["database", "env"] = "env"
    # What resetting reverts to, so the UI can name it before the user commits.
    env_threshold: float
    env_ratio: float


class CompactionDefaultsUpdate(BaseModel):
    # Partial, like ``WebSearchSettingsUpdate``: only fields present in the request
    # body are applied (tracked via ``model_fields_set``), so each knob saves
    # independently. A present-but-null value clears the saved value and reverts
    # that knob to the environment default.
    threshold: float | None = Field(default=None, gt=0, le=1)
    ratio: float | None = Field(default=None, gt=0, le=1)


# Per-command default agent is an open ``dict[str, str]`` map (command name ->
# agent id), handled directly in ``api/settings.py`` — no fixed schema, so a new
# slash command needs no backend change (the frontend registry defines commands).
