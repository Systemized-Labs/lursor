"""Render a database :class:`Agent` row into a runnable deep agent.

``create_deep_agent`` returns a plain ``pydantic_ai.Agent`` (typed over
``DeepAgentDeps``), which the AG-UI adapter can dispatch directly. The agent's
filesystem is rooted at the workspace directory via a ``LocalBackend``.
"""

from __future__ import annotations

from pathlib import Path

import httpx
from pydantic_ai import Agent as PydanticAgent
from pydantic_ai.capabilities import PrepareTools
from pydantic_ai.models import Model
from pydantic_ai.profiles import ModelProfileSpec
from pydantic_ai.providers.deepseek import DeepSeekProvider
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.tools import ToolDefinition
from pydantic_ai_backends import LocalBackend
from pydantic_deep import DeepAgentDeps, create_deep_agent, create_default_deps

from app.agents.deep_defaults import (
    builtin_subagent_defaults,
    resolve_subagent_defaults,
)
from app.agents.tolerant_model import TolerantOpenAIChatModel
from app.agents.vision import make_view_image_tool
from app.config import get_settings
from app.db.models import Agent as AgentRow
from app.db.models import CustomProvider
from app.db.models import Subagent as SubagentRow
from app.skills import store as skill_store

settings = get_settings()

# Prefix on a stored model string that marks a locally-hosted custom provider.
# Format: "custom:{provider_id}:{model_name}" (model_name may itself contain
# colons, e.g. Ollama's "llama3:8b", so we only split on the first colon).
CUSTOM_PREFIX = "custom:"

# Process-shared HTTP client for every local (custom) provider. pydantic-ai's
# default client caps read/write/pool at 600s, which aborts a single long local
# generation (big reasoning outputs, slow prefill) mid-stream. We disable the
# read timeout (`read=None`) so streaming has no wall-clock ceiling here — the
# LiteLLM gateway's own `request_timeout` is the authoritative backstop against a
# genuinely stuck upstream. Connect/write/pool stay finite so setup faults still
# surface. Shared (not per-request): OpenAIProvider does NOT own/close a
# passed-in client, and the agent is rebuilt per turn, so a fresh client each
# time would leak connections. Lazily created to stay off the import path.
_LOCAL_HTTP_TIMEOUT = httpx.Timeout(timeout=30.0, connect=15.0, read=None)
_local_http_client: httpx.AsyncClient | None = None


def _shared_local_http_client() -> httpx.AsyncClient:
    """Return the process-wide client used for local OpenAI-compatible providers."""
    global _local_http_client
    if _local_http_client is None or _local_http_client.is_closed:
        _local_http_client = httpx.AsyncClient(timeout=_LOCAL_HTTP_TIMEOUT)
    return _local_http_client

# Tools the agent may keep in read-only ("ask") mode. This is an ALLOWLIST, not
# a blocklist: the deep-agent toolset exposes many mutation/execution paths
# beyond the obvious write/edit — `task` (spawns a full-write subagent),
# `run_in_background`/`run_skill_script` (shell/script execution), monitors, etc.
# Allowlisting keeps the read surface and fails safe when new tools appear.
#
# Allowed: workspace reads + search, web reads, skill *inspection* (not
# `run_skill_script`), conversation utilities, and the internal todo list (which
# lives in agent state, not the workspace filesystem, so it can't edit files).
_READONLY_TOOL_ALLOWLIST = frozenset(
    {
        # workspace read + navigation
        "ls",
        "read_file",
        "glob",
        "grep",
        "view_image",
        # web (read-only)
        "web_fetch",
        "web_search",
        # skills: inspect only — `run_skill_script` executes and is excluded
        "list_skills",
        "load_skill",
        "read_skill_resource",
        # conversation utilities (touch history/state, not the workspace)
        "search_conversation_history",
        "compact_conversation",
        # todo planning is internal agent state, not files
        "read_todos",
        "write_todos",
        "add_todo",
        "remove_todo",
        "update_todo_status",
        "update_todo_statuses",
    }
)


def _readonly_tool_filter(_ctx, tool_defs: list[ToolDefinition]) -> list[ToolDefinition]:
    """A ``ToolsPrepareFunc`` that keeps only read-safe tools each step.

    Enforces read-only ("ask") mode at the tool layer: everything that can
    mutate the workspace or execute code — including subagent delegation
    (``task``) and shell/script tools — is removed before the model sees it, so
    there is no write path (direct or delegated). Runs every step, so tools
    loaded on demand (tool-search deferral) are filtered too.
    """
    return [t for t in tool_defs if t.name in _READONLY_TOOL_ALLOWLIST]


def _local_model_profile(model_name: str) -> ModelProfileSpec | None:
    """Pick a capability profile for a locally-hosted model by name.

    Local models are served through a generic ``OpenAIProvider`` pointed at a
    LiteLLM/vLLM base URL, so pydantic-ai falls back to ``openai_model_profile``
    — an allowlist of *OpenAI's own* model names. Any non-OpenAI reasoning model
    (DeepSeek, …) is therefore treated as non-reasoning: ``supports_thinking`` is
    False, so its unified ``thinking`` setting is stripped before the request
    (the UI thinking level never reaches the server, which then falls back to its
    own default) and its ``reasoning_content`` output is not mapped.

    We reuse the vendor profiles pydantic-ai already ships, keyed by model-name
    prefix. Each provider's ``model_profile`` is a ``@staticmethod``, so we get
    the profile (supports_thinking, reasoning field, tool_choice caveats) without
    constructing the provider or needing its cloud API key/base URL. Returns
    ``None`` for unrecognized models, which preserves the provider-default
    behavior for everything else.
    """
    if model_name.startswith("deepseek-"):
        return DeepSeekProvider.model_profile(model_name)
    return None


def _reasoning_chat_template_kwargs(
    model: str | Model, thinking: bool | str
) -> dict | None:
    """Translate the UI thinking level into vLLM ``chat_template_kwargs``.

    Some local vLLM builds ignore the top-level OpenAI ``reasoning_effort`` field
    and read reasoning **only** from chat-template kwargs (verified against
    DeepSeek-V4 on this cluster: a top-level ``reasoning_effort`` produced output
    identical to the recipe default, while ``chat_template_kwargs`` changed it).
    For those models the ``Thinking`` capability alone (which sends the top-level
    field) has no effect, and ``thinking=off`` cannot be expressed top-level at
    all. So we also inject the level as ``chat_template_kwargs`` in ``extra_body``,
    which vLLM merges over the recipe's ``--default-chat-template-kwargs`` and
    which passes cleanly through the LiteLLM gateway.

    Scoped to ``deepseek-*`` (whose chat template reads ``thinking`` /
    ``reasoning_effort``). Cloud strings resolve to a plain model name (no
    ``model_name`` attribute) and honor the standard field, so they return None.
    """
    name = getattr(model, "model_name", None)
    if not isinstance(name, str) or not name.startswith("deepseek-"):
        return None
    if thinking is False:
        return {"thinking": False}
    return {"thinking": True, "reasoning_effort": thinking}


def resolve_model(
    model_str: str, providers: dict[str, CustomProvider]
) -> str | Model:
    """Turn a stored model string into a value ``create_deep_agent`` accepts.

    Cloud (``openrouter:``) strings are passed through untouched. A ``custom:``
    string is resolved against ``providers`` (keyed by id) into an
    OpenAI-compatible model object pointed at that provider's base URL. An
    unknown provider falls back to the default model.
    """
    if not model_str.startswith(CUSTOM_PREFIX):
        return model_str

    provider_id, _, model_name = model_str[len(CUSTOM_PREFIX) :].partition(":")
    provider = providers.get(provider_id)
    if provider is None or not model_name:
        return settings.default_model

    # Route through the tolerant model: local OpenAI-compatible servers
    # (vLLM/llama.cpp/LM Studio, often behind a LiteLLM proxy) run strict chat
    # templates that reject request shapes cloud providers accept. It normalizes
    # the outgoing messages (merges the leading system-message run, coerces
    # tool-call arguments to JSON, guarantees a user turn).
    model = TolerantOpenAIChatModel(
        model_name,
        provider=OpenAIProvider(
            base_url=provider.base_url,
            # Local servers usually need no key; OpenAIProvider requires a
            # non-null value, so send a placeholder when none is configured.
            api_key=provider.api_key or "api-key-not-set",
            # Long-lived streaming: no client-side read cap (see
            # _shared_local_http_client); the gateway's request_timeout bounds it.
            http_client=_shared_local_http_client(),
        ),
        # A generic OpenAIProvider would profile local models via OpenAI's
        # name allowlist, silently disabling reasoning for non-OpenAI models.
        # Supply the correct vendor profile so thinking/reasoning is honored.
        profile=_local_model_profile(model_name),
    )
    # Strict local templates reject a request with no user turn; guarantee one.
    model._ensure_user_message = True
    return model


def _subagent_config(
    sa: SubagentRow, custom_providers: dict[str, CustomProvider]
) -> dict:
    """Turn a stored subagent row into a pydantic-deep ``SubAgentConfig`` dict.

    ``model`` is only set when the row pins one; omitting it lets the subagent
    inherit the parent agent's model.
    """
    config: dict = {
        "name": sa.name,
        "description": sa.description,
        "instructions": sa.instructions,
    }
    if sa.model:
        config["model"] = resolve_model(sa.model, custom_providers)
    return config


def build_deep_agent(
    row: AgentRow,
    workspace_path: str | Path,
    custom_providers: dict[str, CustomProvider] | None = None,
    subagents: list[SubagentRow] | None = None,
    deep_defaults: dict | None = None,
    read_only: bool = False,
) -> tuple[PydanticAgent, DeepAgentDeps]:
    """Build a deep agent + deps for ``row`` scoped to ``workspace_path``.

    ``read_only`` gates the agent to "ask" mode: the file-mutating and shell
    tools (``write_file``/``edit_file``/``hashline_edit``/``execute``) are
    filtered out via a ``PrepareTools`` capability, so the agent can read and
    search the workspace but never modify it.

    Skills attached to the agent are handed to the deep agent as skill
    directories (on-disk SKILL.md folders with bundled resources/scripts). Tool
    rows are catalogued in the DB but not yet wired into execution (see
    docs/PLAN.md — deferred); the deep agent ships its own builtin toolset.

    ``custom_providers`` maps provider id → row and is used to route runs that
    target a locally-hosted model; callers that never use custom models can omit
    it.

    ``subagents`` is the global roster of specialists (see ``db.models.Subagent``).
    They are only handed to the agent when ``row.include_subagents`` is on. Rows
    with ``builtin_name`` set are overrides of a pydantic-deep built-in and win
    over the library default.

    ``deep_defaults`` is the ``AppConfig.deep_defaults`` override blob (subagent
    defaults — max nesting depth, disabled built-ins). We take explicit control of
    the built-in subagent roster here (``include_builtin_subagents=False``) rather
    than letting the library inject them, so built-ins can be viewed, overridden,
    or disabled from the UI. This is behaviour-preserving: the library treats
    built-ins as ordinary ``SubAgentConfig`` dicts and applies the same default
    deep-agent factory to every config.
    """
    backend = LocalBackend(root_dir=str(workspace_path))

    # thinking is stored as an enum: "off" disables, otherwise pass the level string.
    thinking: bool | str = False if row.thinking.value == "off" else row.thinking.value

    # Skills are on-disk folders (SKILL.md + resources + scripts). Hand the deep
    # agent each attached skill's directory so it discovers the full standard —
    # bundled resources (`read_skill_resource`) and scripts (`run_skill_script`) —
    # not just the markdown body. See app/skills/store.py. Folders are guaranteed
    # to exist by reconcile (startup + on every skills API call); skip any that
    # are somehow missing rather than failing the whole run.
    skill_dirs = [
        str(skill_store.path_for(s.slug))
        for s in row.skills
        if s.slug and skill_store.exists(s.slug)
    ]

    # Global subagents apply only when the agent opts into subagents. We assemble
    # the full roster ourselves — user subagents plus the pydantic-deep built-ins
    # (general-purpose, research) — so built-ins can be overridden or disabled from
    # the UI. See ``agents/deep_defaults.py`` for the resolution rules.
    resolved_defaults = resolve_subagent_defaults(deep_defaults)
    subagent_configs: list[dict] = []
    if row.include_subagents:
        providers = custom_providers or {}
        rows = subagents or []
        # Built-in override rows (builtin_name set) win over the library default;
        # everything else is an ordinary user subagent.
        overrides = {sa.builtin_name: sa for sa in rows if sa.builtin_name}
        subagent_configs = [
            _subagent_config(sa, providers) for sa in rows if not sa.builtin_name
        ]

        disabled = set(resolved_defaults["disabled_builtins"])
        for builtin in builtin_subagent_defaults():
            name = builtin["name"]
            if name in disabled:
                continue
            override = overrides.get(name)
            subagent_configs.append(
                _subagent_config(override, providers) if override else dict(builtin)
            )

    # `subagents` and the managed subagent-default knobs may also be supplied via
    # the extra_config escape hatch; where they are, let it win rather than passing
    # the keyword twice.
    extra_config = dict(row.extra_config)
    subagents_kwarg = (
        {} if "subagents" in extra_config else {"subagents": subagent_configs or None}
    )
    managed_kwargs: dict = {}
    if "include_builtin_subagents" not in extra_config:
        # We build the built-in roster ourselves (above) so it can be viewed,
        # overridden, or disabled from the UI; don't let the library re-add it.
        managed_kwargs["include_builtin_subagents"] = False
    if "max_nesting_depth" not in extra_config:
        managed_kwargs["max_nesting_depth"] = resolved_defaults["max_nesting_depth"]

    # view_image is always available so any agent can inspect user-attached
    # media (and workspace images) via the dedicated vision model, regardless of
    # whether its own chat model supports image input.
    tools = list(extra_config.pop("tools", []) or [])
    tools.append(make_view_image_tool(workspace_path))

    # Read-only ("ask") mode filters the mutating tools via a PrepareTools
    # capability. Merge with any capabilities supplied through the escape hatch
    # so we never pass the keyword twice.
    capabilities = list(extra_config.pop("capabilities", []) or [])
    if read_only:
        capabilities.append(PrepareTools(_readonly_tool_filter))

    model = resolve_model(row.model or settings.default_model, custom_providers or {})

    # For local models whose chat template (not a top-level API field) controls
    # reasoning, translate the UI thinking level into extra_body.chat_template_kwargs.
    # Caller-supplied model_settings / chat_template_kwargs win over ours.
    ctk = _reasoning_chat_template_kwargs(model, thinking)
    if ctk is not None:
        model_settings = dict(extra_config.pop("model_settings", None) or {})
        extra_body = dict(model_settings.get("extra_body") or {})
        extra_body["chat_template_kwargs"] = {
            **ctk,
            **(extra_body.get("chat_template_kwargs") or {}),
        }
        model_settings["extra_body"] = extra_body
        extra_config["model_settings"] = model_settings

    agent = create_deep_agent(
        model=model,
        instructions=row.instructions or None,
        backend=backend,
        tools=tools,
        skill_directories=skill_dirs or None,
        include_todo=row.include_todo,
        include_subagents=row.include_subagents,
        include_skills=row.include_skills,
        include_memory=row.include_memory,
        include_plan=row.include_plan,
        web_search=row.web_search,
        thinking=thinking,
        capabilities=capabilities or None,
        **managed_kwargs,
        **subagents_kwarg,
        **extra_config,
    )
    deps = create_default_deps(backend)
    return agent, deps
