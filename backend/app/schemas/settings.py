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


class OpenRouterKeyReveal(BaseModel):
    """The effective key in full — returned only from the explicit reveal route.

    Kept separate from :class:`OpenRouterSettingsRead` so the secret is handed
    over exactly when the user asks to copy it, never on a routine status poll.
    """

    api_key: str
    source: Literal["database", "env"]


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


#: The web-search providers that hold an API key worth revealing.
KeyedSearchProvider = Literal["tavily", "exa"]


class WebSearchKeyReveal(BaseModel):
    """One provider's effective key in full — only from the reveal route.

    Same shape and reasoning as :class:`OpenRouterKeyReveal`: the status route
    hands back a hint, this one hands back the secret on explicit request.
    """

    provider: KeyedSearchProvider
    api_key: str
    source: Literal["database", "env"]


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
    # The model that writes the summary, as a stored routing string
    # ("openrouter:…" / "custom:{provider}:{model}"). Deliberately not the thread
    # agent's model: summarizing is a cheap, throwaway task, and the run's own
    # model may be heavy or offline.
    model: str
    # Where each effective value comes from — a value saved here ("database") or
    # the process environment / .env ("env"), mirroring the OpenRouter and memory
    # sections. Only a "database" value can be reset.
    threshold_source: Literal["database", "env"] = "env"
    ratio_source: Literal["database", "env"] = "env"
    model_source: Literal["database", "env"] = "env"
    # What resetting reverts to, so the UI can name it before the user commits.
    env_threshold: float
    env_ratio: float
    env_model: str


class CompactionDefaultsUpdate(BaseModel):
    # Partial, like ``WebSearchSettingsUpdate``: only fields present in the request
    # body are applied (tracked via ``model_fields_set``), so each knob saves
    # independently. A present-but-null value clears the saved value and reverts
    # that knob to the environment default.
    threshold: float | None = Field(default=None, gt=0, le=1)
    ratio: float | None = Field(default=None, gt=0, le=1)
    # Free-form like every other stored model field (an agent row's ``model``): the
    # picker sends a routing string, and an unreachable one surfaces as a compaction
    # warning rather than a save-time error. Blank is normalized to null (= revert
    # to the environment default) in the endpoint.
    model: str | None = None


# Where images and clips are generated: a **source ref**, not an enum. "laios"
# resolves across the connected boxes (or "laios:{connection}" for one of them),
# "openrouter" uses OpenRouter's media APIs, and "custom:{provider}" uses a
# user-added OpenAI-compatible endpoint. See ``app/media/refs.py`` for the grammar,
# which also names a specific model within a source.
#
# A plain ``str`` rather than a Literal because the custom form carries an id that
# no enum can enumerate. Validation is not lost, only moved: ``set_media`` runs
# every value through ``refs.parse_source`` and returns a 400 with the parser's own
# sentence, which is a better message than Pydantic's "unexpected value" anyway.
MediaSource = str


class MediaModalityRead(BaseModel):
    """The configured source and model for one modality, and what it resolves to.

    ``available`` / ``reason`` / ``effective_model`` come from the same resolver
    the capability probe and the agent build use
    (``agents/image_runtime.resolve_image_target``), so this card and the agent
    editor's hint can never disagree about whether generation works.
    """

    source: MediaSource
    # The pinned model ref, or null for "auto — the cheapest the source offers".
    model: str | None = None
    model_source: Literal["database", "auto"] = "auto"
    # Whether a generation would succeed right now, and the one sentence saying
    # why not. The source never falls back to the other one, so the reason has to
    # carry that — otherwise an empty picker reads as a bug.
    available: bool = False
    reason: str = ""
    # What a run would actually reach, as a display name.
    effective_model: str | None = None


class MediaSourceOption(BaseModel):
    """One custom provider, as the source picker lists it."""

    # The source ref to save — ``custom:{id}``, already formatted, so the picker
    # never assembles a ref itself.
    ref: str
    name: str
    base_url: str


class MediaSettingsRead(BaseModel):
    """Both modalities plus the context the UI needs to explain a dead option."""

    image: MediaModalityRead
    video: MediaModalityRead
    # So the section can say "add a key" rather than just "unavailable".
    openrouter_configured: bool = False
    laios_connected: bool = False
    # Every user-added endpoint that could be a source. Listed whether or not it
    # currently serves media — the same argument the card makes for not disabling
    # OpenRouter without a key: being told what to do next beats a greyed-out row
    # with no explanation. Deliberately *not* probed here, so opening Settings
    # costs no round trip per provider; selecting one is what resolves it.
    custom_providers: list[MediaSourceOption] = []


class MediaSettingsUpdate(BaseModel):
    # Partial, like ``WebSearchSettingsUpdate``: only fields present in the request
    # body are applied (tracked via ``model_fields_set``), so the image and video
    # choices save independently. A present-but-null model clears the pin back to
    # "auto"; a present-but-null source reverts to the default ("laios").
    image_source: MediaSource | None = None
    image_model: str | None = None
    video_source: MediaSource | None = None
    video_model: str | None = None


# Per-command default agent is an open ``dict[str, str]`` map (command name ->
# agent id), handled directly in ``api/settings.py`` — no fixed schema, so a new
# slash command needs no backend change (the frontend registry defines commands).
