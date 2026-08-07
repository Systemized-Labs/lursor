"""Render a database :class:`Agent` row into a runnable deep agent.

``create_deep_agent`` returns a plain ``pydantic_ai.Agent`` (typed over
``DeepAgentDeps``), which the AG-UI adapter can dispatch directly. The agent's
filesystem is rooted at the workspace directory via a ``LocalBackend``.
"""

from __future__ import annotations

import logging
import socket
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import httpx
from pydantic_ai import Agent as PydanticAgent
from pydantic_ai.capabilities import AbstractCapability, PrepareTools
from pydantic_ai.models import Model
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.providers.openrouter import OpenRouterProvider
from pydantic_ai.retries import (
    AsyncTenacityTransport,
    RetryConfig,
    wait_retry_after,
)
from pydantic_ai.settings import ModelSettings
from pydantic_ai.tools import RunContext, ToolDefinition
from pydantic_ai.usage import UsageLimits
from pydantic_ai_backends import LocalBackend
from pydantic_deep import DeepAgentDeps, create_deep_agent, create_default_deps
from pydantic_deep.features.skills import SkillsDirectory
from pydantic_deep.prompts import BASE_PROMPT
from tenacity import retry_if_exception_type, stop_after_attempt, wait_exponential

from app.agents.browser_qa import BrowserQACapability
from app.agents.context_budget import apply_compaction_settings
from app.agents.deduping_backend import DedupingLocalBackend, set_run_env
from app.agents.deep_defaults import (
    builtin_subagent_defaults,
    resolve_subagent_defaults,
)
from app.agents.edit_syntax import EditSyntaxCheck
from app.agents.file_editing import FileEditingGuards
from app.agents.hindsight import (
    HINDSIGHT_MEMORY_DIRECTIVE,
    HindsightConfig,
    build_hindsight_capability,
)
from app.agents.image_runtime import ImageRuntime
from app.agents.image_tools import make_image_tools
from app.agents.skill_runtime import SkillRuntime
from app.agents.tolerant_model import TolerantOpenAIChatModel
from app.agents.tool_errors import ToolErrorsAsText
from app.agents.tool_loading import build_tool_loading_capabilities
from app.agents.video_runtime import VideoRuntime
from app.agents.video_tools import make_video_tools
from app.agents.vision import make_view_image_tool
from app.agents.web_fetch import build_web_fetch_capability
from app.agents.web_search import (
    DEFAULT_WEB_SEARCH_PROVIDER,
    build_web_search_capability,
)

# The one import from ``app/assistant/`` allowed anywhere under ``app/agents/``.
# ``registry`` is a leaf (pydantic-ai only), so this cannot cycle back through the
# toolset, which imports the API layer, which imports this module.
from app.assistant.registry import (
    ASSISTANT_CORE_TOOLS,
    CONTROL_PLANE_PROMPT,
    AssistantToolGuard,
    assert_no_assistant_tools,
)
from app.config import get_settings
from app.db.models import Agent as AgentRow
from app.db.models import CustomProvider, ToolChoice
from app.db.models import Subagent as SubagentRow
from app.skills.script_exec import SkillEnvScriptExecutor

settings = get_settings()

logger = logging.getLogger(__name__)

# Appended to every agent's system instructions so models default to English
# rather than drifting into another language mid-conversation. Applied here (the
# lower level) so users never have to add it to their own agent instructions;
# the model still switches languages when the user writes in, or asks for, one.
DEFAULT_LANGUAGE_DIRECTIVE = "Always respond in English by default."

# Appended to executing agents so dev servers land in the Preview panel. Plain
# `execute` blocks until the command exits and reaps the process tree on its
# timeout, so a server started that way is killed before the user sees it; the
# `run_in_background` tool keeps it alive and Lursor's watcher then detects the
# port and surfaces it in Preview automatically. Only added when the agent can
# actually execute (read-only "ask" mode has no such tools).
DEV_SERVER_DIRECTIVE = (
    "# Dev servers & long-running processes\n"
    "- Before starting a dev server or watcher, run `list_shells` to see what is "
    "already running in this workspace (background shells persist across turns, "
    "so one you started earlier is still up). If a suitable server is already "
    "running, reuse it — do NOT start a second one. Only start a fresh server "
    "when none is running, or first stop the stale one with `kill_shell`.\n"
    "- Start dev servers, watchers, and any process that does not exit on its "
    "own (`npm run dev`, `vite`, `uvicorn`, etc.) with the `run_in_background` "
    "tool, never plain `execute` — `execute` blocks and its timeout kills the "
    "process, so the server never stays up.\n"
    "- After starting one, read its output to confirm it is listening and tell "
    "the user the URL it printed. Lursor detects the server automatically: the "
    "Preview panel opens to it once it responds, and any further servers appear "
    "as one-tap chips there."
)

# Appended to executing agents (when browser QA is enabled) so the model knows to
# actually verify its UI work in the browser rather than assume it renders. The
# per-run browser capability (see ``browser_qa.py``) also injects tool-specific
# guidance; this is the top-level nudge to QA at all.
BROWSER_QA_DIRECTIVE = (
    "# Verify your UI work in the browser\n"
    "- After building or changing anything visual, QA it: open the running app "
    "with `open_app`, then `view_app` to see it and `get_console_logs` / "
    "`get_network_errors` to catch runtime errors. Fix what's broken and re-check "
    "before telling the user it's done — don't assume the page renders correctly."
)

# Appended when a box that can generate images was resolved (see
# ``agents/image_runtime.py``). Necessary for the same reason as
# ``DEV_SERVER_DIRECTIVE``: having the tool is not enough when the model holds a
# strong prior about how the job is normally done. Observed in the wild — an agent
# asked for an image, with ``generate_image`` sitting in its tool list next to
# ``execute``, ran ``curl`` against a public image API instead. That is worse than
# a missed tool: the prompt leaves the machine for a third party, the user's own
# GPU stays idle, and nothing lands in the media store, the Image pane or
# Artifacts. So the preference is stated, and the wrong path named explicitly —
# "use X" is much weaker than "use X, never Y" against a habit.
IMAGE_GENERATION_DIRECTIVE = (
    "# Generating images\n"
    "- You can generate images locally with the `generate_image` tool, on "
    "hardware the user owns. Use it for every image you are asked to produce.\n"
    "- NEVER fetch a generated image from an external service — no `curl` to "
    "Pollinations, OpenAI, Replicate, Stability or any other image API, and no "
    "writing a script that does. Those send the user's prompt off their machine, "
    "cost them money or privacy, and produce a file Lursor cannot track. "
    "`generate_image` is the only correct route.\n"
    "- Do not draw a requested photo or illustration in code either (canvas, SVG, "
    "matplotlib, ASCII). Generating a diagram or chart from data is different and "
    "still fine.\n"
    "- The tool waits for the image and returns a real path in the workspace. "
    "Look at what you made with `view_image` before describing it or handing it "
    "over — and if `generate_image` is not in your tool list, search for it."
)


# One backend per workspace directory, reused across every chat run (and its
# subagents). The backend owns the registry of background processes the agent
# starts with `run_in_background` — dev servers, watchers — and those outlive the
# run that started them (see agents/preview_service.py). A fresh backend per run
# would start with an empty registry, so `list_shells` would show nothing and the
# agent, blind to the server already running from an earlier turn, would spin up a
# duplicate. Sharing one backend per workspace makes `list_shells`/`kill_shell`
# see and manage those processes across runs. Keyed by resolved absolute path;
# file operations are stateless per call, so the shared instance is safe.
#
# The backend is a DedupingLocalBackend, which additionally enforces reuse in
# code: an identical command already running is returned as-is rather than
# spawned twice. The advisory prompt guard (DEV_SERVER_DIRECTIVE) is unreliable
# across turns/compaction/subagents, so this is the real guard against the
# duplicate dev servers that produced multiple identical "terminals running".
_workspace_backends: dict[str, LocalBackend] = {}


def _workspace_backend(workspace_path: str | Path) -> LocalBackend:
    """Return the shared :class:`DedupingLocalBackend` for ``workspace_path``.

    Created on first use and cached, so background processes started in one chat
    run stay visible (and killable) from every later run of the same workspace.
    """
    key = str(Path(workspace_path).resolve())
    backend = _workspace_backends.get(key)
    if backend is None:
        backend = DedupingLocalBackend(root_dir=key)
        _workspace_backends[key] = backend
    return backend


def _skill_directories(runtime: SkillRuntime | None) -> list[Any]:
    """The ``skill_directories`` value for ``create_deep_agent``.

    One ``SkillsDirectory`` per in-scope folder, always constructed here rather
    than left to the library, for two reasons.

    ``validate=False`` is the load-bearing one: with the default (``True``),
    ``_discover_skills`` **re-raises** a malformed ``SKILL.md`` as
    ``SkillValidationError``, which propagates out of ``create_deep_agent`` and
    fails the whole build — no agent, no run, an HTTP 500 on every message —
    because of one file in a directory another tool owns. Off, the library warns
    and skips the offender. ``app.skills.resolve`` already filters those folders
    out, so this is the second line: the resolver can only judge what was on disk
    when the run started, and it is not the only caller pointing the library at a
    directory.

    The other is ``SkillEnvScriptExecutor``, wired in whenever any in-scope skill
    carries env vars, so ``run_skill_script`` spawns with the env of the skill
    that owns the script — the precision the shell path can't offer.

    pydantic-deep's ``skill_directories`` parameter is typed for strings, dicts, or
    ``BackendSkillsDirectory``, but its implementation forwards anything else
    untouched (``pydantic_deep/agent.py``, ``directories.append(sd)``) and
    ``SkillsToolset`` accepts a ``SkillsDirectory`` instance directly
    (``features/skills/toolset.py``, the ``isinstance`` branch in
    ``_load_directory_skills``). That is what makes both reachable from here; the
    type ignore at the call site is for the annotation, not the behaviour.
    """
    if runtime is None:
        return []
    executor = (
        SkillEnvScriptExecutor(runtime.env_by_folder, runtime.secrets)
        if runtime.env_by_folder
        else None
    )
    return [
        SkillsDirectory(path=folder, validate=False, script_executor=executor)  # type: ignore[arg-type]
        for folder in runtime.skill_dirs
    ]


def _env_var_instructions(runtime: SkillRuntime | None) -> list[str]:
    """Lines naming the env vars this run can use — **names only, never values**.

    Without this the agent has no reason to believe a credential is present: it
    would ask the user for a key that is already in its shell. Values are
    deliberately absent from the prompt (and redacted out of command output), so
    the model can reference ``$STRIPE_SECRET_KEY`` without ever seeing it.
    """
    if runtime is None or not runtime.run_env.values:
        return []
    lines = [
        "- Environment variables available to your shell and skill scripts:",
    ]
    for key in sorted(runtime.run_env.values):
        source = runtime.run_env.provenance.get(key, "")
        description = runtime.run_env.descriptions.get(key, "")
        detail = " ".join(
            part for part in (description, f"({source})" if source else "") if part
        )
        lines.append(f"  - {key}" + (f" — {detail}" if detail else ""))
    lines.append(
        "  Reference them as `$NAME` in commands; they are already set. Their "
        "values are secret: never print, echo, or copy one into a file, a message, "
        "or a commit."
    )
    return lines


def _environment_instructions(
    workspace_path: str | Path,
    workspace_name: str | None,
    workspace_description: str | None,
    skill_runtime: SkillRuntime | None = None,
) -> str:
    """A system-prompt section telling the agent where it is on disk.

    The agent's filesystem is rooted at the workspace directory (``LocalBackend``),
    but nothing in the base prompt or the tool output states that root — ``ls``
    prints only relative names and the model would otherwise have to run ``pwd``
    (blocked in read-only mode) to discover it. Without an anchor the agent
    guesses absolute paths, trips the sandbox boundary, and can't emit correct
    ``path:line`` references. Stating the root, name, and purpose up front fixes
    that. ``workspace_name`` falls back to the directory's basename when unset.

    ``skill_runtime`` adds the names of the environment variables injected into
    this run (see :func:`_env_var_instructions`).
    """
    root = str(workspace_path)
    name = workspace_name or Path(root).name
    header = f"- Workspace: {name}"
    if workspace_description:
        header += f" — {workspace_description}"
    return "\n".join(
        [
            "# Environment",
            header,
            f"- Working directory (your filesystem root): {root}",
            "- Every file tool is sandboxed to this directory and relative paths "
            "resolve against it. Reference files by their path under this root "
            "(e.g. `path/to/file.py:42`).",
            *_env_var_instructions(skill_runtime),
        ]
    )

# Model rounds a single agent turn may take, up from pydantic-ai's default of 50,
# which trips deep agents on tool-heavy turns before they can finish the work.
# ``api/chat.py`` applies it to the top-level turn; ``_SUBAGENT_USAGE_LIMITS``
# below applies the same figure to delegated runs.
TURN_REQUEST_LIMIT = 150

# Usage budget for a delegated subagent (``task``) run.
#
# pydantic-deep hands ``subagent_usage_limits`` straight to its subagent toolset,
# and leaving it unset means each subagent runs on a bare ``UsageLimits()`` —
# pydantic-ai's default ``request_limit=50`` — while the turn that delegated to it
# gets ``TURN_REQUEST_LIMIT``. Deep, tool-heavy delegation then dies with "Error
# executing task: The next request would exceed the request_limit of 50" while the
# parent still had budget to spare. A subagent is doing the same kind of work as
# its caller, so give it the same room. Per-agent overrides go through the
# ``extra_config`` escape hatch, which wins over this default.
_SUBAGENT_USAGE_LIMITS = UsageLimits(request_limit=TURN_REQUEST_LIMIT)

# Per-tool retry budget, up from the pydantic-deep default of 3.
#
# A "retry" here is a ``ModelRetry`` or an argument-validation failure fed back to
# the model; the count is per tool name and *consecutive* (pydantic-ai rebuilds it
# each step from the tools that failed in that step, so one success clears it).
# Exhausting it raises ``UnexpectedModelBehavior`` and aborts the turn.
#
# 5 rather than 3 because the models most likely to need the extra attempts are
# small local ones getting a tool schema slightly wrong, and the cost of being
# generous is trivial: at worst two more model rounds out of the
# ``TURN_REQUEST_LIMIT`` budget. Per-agent overrides go through the
# ``extra_config`` escape hatch, which wins over this default.
#
# Note this is deliberately not the answer to environmental failures dressed up as
# ``ModelRetry`` — see agents/web_fetch.py, which returns those to the model as
# text so they never consume this budget at all.
_TOOL_RETRIES = 5

# Prefix on a stored model string that marks a locally-hosted custom provider.
# Format: "custom:{provider_id}:{model_name}" (model_name may itself contain
# colons, e.g. Ollama's "llama3:8b", so we only split on the first colon).
CUSTOM_PREFIX = "custom:"

# Prefix marking a cloud model served through OpenRouter.
OPENROUTER_PREFIX = "openrouter:"

# OpenRouter routes to shared upstream provider pools that rate-limit (HTTP 429,
# "temporarily rate-limited upstream. Please retry shortly") and occasionally
# return transient 5xx. Left alone these surface as a fatal ``ModelHTTPError``
# that aborts the whole agent turn. Statuses we retry rather than propagate.
_OPENROUTER_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})

# Keep-alive probes on every model connection, so a peer that dies without
# sending a FIN (tunnel drop, NAT/idle reaping, host vanishing mid-stream) is
# detected at the socket layer instead of looking permanently healthy. This is
# the backstop *under* the read timeout below: it fails the socket outright,
# which also covers the case where the gateway keeps trickling bytes but the
# path to the real upstream is gone. Values are conservative — first probe after
# 60s idle, then every 15s, dead after 4 unanswered (~2min worst case).
#
# TCP_KEEPINTVL/TCP_KEEPCNT are Linux-only names in Python's socket module; macOS
# exposes TCP_KEEPALIVE for the idle time instead of TCP_KEEPIDLE. Each option is
# added only if this platform defines it, so the list degrades gracefully rather
# than raising on import.
def _keepalive_socket_options() -> list[tuple[int, int, int]]:
    """Portable TCP keep-alive socket options for the shared model clients."""
    options: list[tuple[int, int, int]] = [(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)]
    for name, value in (
        ("TCP_KEEPIDLE", 60),  # Linux: idle seconds before the first probe
        ("TCP_KEEPALIVE", 60),  # macOS: same knob, different name
        ("TCP_KEEPINTVL", 15),  # seconds between probes
        ("TCP_KEEPCNT", 4),  # unanswered probes before the socket is dead
    ):
        option = getattr(socket, name, None)
        if option is not None:
            options.append((socket.IPPROTO_TCP, option, value))
    return options


# Process-shared HTTP clients for every local (custom) provider, one per
# timeout regime (see `_model_http_timeout`).
#
# `read` is deliberately finite but generous. On a *streaming* call httpx
# applies it per socket read, so it *resets on every chunk*: a long local
# generation (big reasoning output, slow prefill) streams for as long as it
# wants without tripping it — only a stream that stops producing bytes entirely
# does. It was previously `read=None` on the theory that the LiteLLM gateway's
# own `request_timeout` was a sufficient backstop; it isn't. When the connection
# to the gateway dies mid-stream the gateway never learns a request is in
# flight, so nothing anywhere holds a stopwatch and the run hangs forever
# (observed: a 90-minute-dead turn on an ESTABLISHED socket with an empty
# receive queue). Connect/write/pool stay finite so setup faults still surface.
#
# Shared (not per-request): OpenAIProvider does NOT own/close a passed-in client,
# and the agent is rebuilt per turn, so a fresh client each time would leak
# connections. Lazily created to stay off the import path — and so the timeout
# reflects settings at first use rather than import time. Keyed by `streaming`
# because the two regimes must not share a client: the timeout is baked in at
# construction.
_local_http_clients: dict[bool, httpx.AsyncClient] = {}


def _model_http_timeout(*, streaming: bool) -> httpx.Timeout:
    """Timeout policy for a model client, by response mode.

    The `read` timeout means two different things depending on whether the
    caller streams, and one number cannot serve both:

    * streaming — a per-chunk stall detector; it resets on every token, so it
      only fires on a genuinely dead stream.
    * non-streaming — nothing arrives until generation completes, so there is
      no chunk to reset on and `read` becomes the total request budget.

    Sharing the streaming value with one-shot calls capped whole-response
    latency at ``model_stream_stall_timeout``, silently aborting slow
    compactions at exactly that mark. See ``Settings.one_shot_request_timeout``.
    """
    settings = get_settings()
    return httpx.Timeout(
        timeout=30.0,
        connect=15.0,
        read=(
            settings.model_stream_stall_timeout
            if streaming
            else settings.one_shot_request_timeout
        ),
    )


def _shared_local_http_client(*, streaming: bool = True) -> httpx.AsyncClient:
    """Return the process-wide client used for local OpenAI-compatible providers."""
    client = _local_http_clients.get(streaming)
    if client is None or client.is_closed:
        client = httpx.AsyncClient(
            transport=httpx.AsyncHTTPTransport(socket_options=_keepalive_socket_options()),
            timeout=_model_http_timeout(streaming=streaming),
        )
        _local_http_clients[streaming] = client
    return client


# Process-shared retrying clients for OpenRouter, one per timeout regime. Same
# lazy/shared rationale as the local clients, and the same keep-alive probes — a
# cloud gateway's connection can drop mid-stream just as a tunnelled local one
# can, and `read=None` stranded the run identically. The streaming/one-shot
# split applies here too: `default_compaction_model` is an ``openrouter:``
# model, so the non-streaming path is not local-only.
_openrouter_http_clients: dict[bool, httpx.AsyncClient] = {}


def _shared_openrouter_http_client(*, streaming: bool = True) -> httpx.AsyncClient:
    """Return the process-wide retrying client for OpenRouter requests.

    Wraps the default transport in an :class:`AsyncTenacityTransport` that, on a
    retryable status (:data:`_OPENROUTER_RETRY_STATUSES`), waits out the server's
    ``Retry-After`` header (falling back to capped exponential backoff) and
    retries. After the attempts are exhausted the final response raises as usual,
    so a persistent outage still surfaces as ``ModelHTTPError``.
    """
    client = _openrouter_http_clients.get(streaming)
    if client is None or client.is_closed:

        def _raise_on_retryable(response: httpx.Response) -> None:
            if response.status_code in _OPENROUTER_RETRY_STATUSES:
                response.raise_for_status()

        transport = AsyncTenacityTransport(
            config=RetryConfig(
                retry=retry_if_exception_type(httpx.HTTPStatusError),
                wait=wait_retry_after(
                    fallback_strategy=wait_exponential(multiplier=1, max=30),
                    max_wait=60,
                ),
                stop=stop_after_attempt(5),
                reraise=True,
            ),
            validate_response=_raise_on_retryable,
            # Retry on top of a keep-alive-probing transport rather than the
            # default one, so the retry layer and the socket-level dead-peer
            # detection compose instead of the latter being lost.
            wrapped=httpx.AsyncHTTPTransport(socket_options=_keepalive_socket_options()),
        )
        client = httpx.AsyncClient(
            transport=transport, timeout=_model_http_timeout(streaming=streaming)
        )
        _openrouter_http_clients[streaming] = client
    return client

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
        # web (read-only). The search tool's *name* is the provider's, never
        # "web_search": the local fallbacks are ``duckduckgo_search`` /
        # ``tavily_search`` / ``exa_search`` (``agents/web_search.py``), and
        # ``web_search`` only ever names the provider-*native* tool, which is not
        # a function tool and so never reaches this filter at all. Listing all
        # three is load-bearing, not defensive: dropping the local fallback leaves
        # the unsupported native tool with nothing to fall back to, and pydantic-ai
        # raises ``UserError`` before the request — killing an /ask turn outright
        # on every model without native web search (all ``custom:``/laios models).
        "web_fetch",
        "duckduckgo_search",
        "tavily_search",
        "exa_search",
        # tool-search discovery (see ``agents/tool_loading.py``). Deferred tools
        # are unreachable without it, and it only ever *reveals* definitions — the
        # revealed tools come back through this same filter on the next step, so a
        # write tool cannot enter the read-only surface by being discovered.
        "search_tools",
        # skills: inspect only — `run_skill_script` executes and is excluded
        "list_skills",
        "load_skill",
        "read_skill_resource",
        # conversation utilities (touch history/state, not the workspace)
        "search_conversation_history",
        "compact_conversation",
        # long-term memory: read paths only. ``hindsight_retain`` writes, so it
        # is absent here *and* never built in read-only mode (see
        # ``build_hindsight_capability(read_only=...)``). ``read_memory`` (the
        # file provider) is likewise absent — it was never in this allowlist.
        "hindsight_recall",
        "hindsight_reflect",
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


# The exact bullet pydantic-deep hardcodes into the ``task`` tool description
# (``subagents_pydantic_ai/prompts.py``, ``TASK_TOOL_DESCRIPTION``). It is shipped
# to every agent verbatim and never rewritten from the live roster, so an install
# with the ``general-purpose`` built-in disabled is still told to fall back to it.
_TASK_GENERAL_PURPOSE_BULLET = (
    "- **Choose the right subagent**: Match the subagent_type to the task. "
    'Use "general-purpose" when no specialized subagent fits.'
)


def _task_roster_bullet(names: list[str]) -> str:
    """The replacement bullet: only names that are actually dispatchable."""
    if not names:
        # The library registers ``task`` whenever ``include_subagents`` is on, even
        # with an empty roster. Say there is nothing to delegate to rather than
        # naming a subagent that cannot be dispatched.
        return (
            "- **Choose the right subagent**: no subagents are configured, so "
            "there is nothing to delegate to — do the work yourself."
        )
    return (
        "- **Choose the right subagent**: Match the subagent_type to the task. "
        f"Use one of: {', '.join(names)}. Do not invent a subagent type."
    )


def _task_description_from_roster(description: str | None, bullet: str) -> str | None:
    if not description:
        return description
    if _TASK_GENERAL_PURPOSE_BULLET in description:
        return description.replace(_TASK_GENERAL_PURPOSE_BULLET, bullet)
    # Upstream reworded the bullet (we pin a SHA, but a bump could). Append ours
    # rather than silently leaving the stale advice as the only guidance.
    return f"{description.rstrip()}\n{bullet}"


def _schema_with_subagent_enum(schema: Any, names: list[str]) -> Any:
    """Copy ``schema`` with ``subagent_type`` constrained to ``names``.

    Returns a fresh dict — the toolset owns the original and shares it across every
    run, so in-place mutation would leak one agent's roster into another's.
    """
    if not names or not isinstance(schema, dict):
        return schema
    props = schema.get("properties")
    if not isinstance(props, dict):
        return schema
    prop = props.get("subagent_type")
    if not isinstance(prop, dict):
        return schema
    return {
        **schema,
        "properties": {**props, "subagent_type": {**prop, "enum": list(names)}},
    }


def _task_tool_roster_filter(
    names: list[str],
) -> Callable[[RunContext[Any], list[ToolDefinition]], list[ToolDefinition]]:
    """A ``ToolsPrepareFunc`` that pins ``task`` to the roster we assembled.

    Two things in pydantic-deep conspire to make an agent delegate to a subagent
    that does not exist:

    1. ``TASK_TOOL_DESCRIPTION`` tells it to use ``general-purpose`` when nothing
       else fits — unconditionally, even when that built-in is disabled.
    2. ``subagent_type`` is a bare ``str`` with no enum, so the provider cannot
       reject an invalid name; the library validates *after* dispatch and returns
       ``Error: Unknown subagent '...'`` as the tool result — a wasted turn and a
       card the chat marks "Failed".

    Claude models also carry a strong prior for ``general-purpose`` (it is the
    canonical type in Claude Code's Task tool), so the three together reproduce
    reliably. ``create_deep_agent`` exposes no passthrough to
    ``create_subagent_toolset(descriptions=...)``, so we rewrite the prepared
    definition here instead: swap the bullet for the live roster and inject the
    enum for providers that honour it (Anthropic, OpenAI). The library's post-hoc
    validation stays as the backstop for local models that ignore enums.

    Runs every step, like the read-only filter, so tools surfaced later (tool-search
    deferral) are rewritten too. Read-only mode drops ``task`` outright, so with
    both capabilities active this one simply finds nothing — either order is safe.
    """
    bullet = _task_roster_bullet(names)

    def prepare(
        _ctx: RunContext[Any], tool_defs: list[ToolDefinition]
    ) -> list[ToolDefinition]:
        return [
            (
                td
                if td.name != "task"
                else replace(
                    td,
                    description=_task_description_from_roster(td.description, bullet),
                    parameters_json_schema=_schema_with_subagent_enum(
                        td.parameters_json_schema, names
                    ),
                )
            )
            for td in tool_defs
        ]

    return prepare


# Plan mode has no tool allowlist on purpose. It used to run a plan-specific
# filter (the read-only surface plus ``write_file``), but gating the toolset
# starved the planning loop itself: without the todo board and delegation, local
# reasoning models (GLM/DeepSeek) fell back to answering in prose and never wrote
# the plan doc at all, and a filtered-out local web-search tool made a plan turn
# with web search fail outright on ``OpenAIChatModel``. A plan turn now sees the
# full toolset and is held to planning by the planning prompt alone (see
# ``planning_instruction`` in ``goal_loop.py``, which says not to start the work).
# ``/ask`` read-only mode keeps its allowlist — there the guarantee is the point.


@dataclass
class ForceToolChoice(AbstractCapability[Any]):
    """Constrain the model's ``tool_choice`` for an agent.

    - ``none``: disable function tools every step; the model replies with text
      only (output tools remain, so structured output still works). Safe to set
      statically, so it merges as a plain :class:`ModelSettings`.
    - ``required``: force a tool call on the **opening step only**, then release
      to ``auto``. pydantic-ai forbids setting ``tool_choice='required'``
      statically because it excludes output tools and would prevent the agent
      from ever producing a final response (an endless force-a-tool loop); the
      supported escape is a per-step callable returned from
      ``get_model_settings``, which is what we do — force on ``run_step == 1``
      and step back afterwards so the run can still finish.

    On local reasoning models routed through :class:`TolerantOpenAIChatModel`,
    ``required`` is downgraded to ``auto`` at the model layer (their chat
    templates 500 on forced tool choice); this capability stays correct there
    because the downgrade happens after the setting is resolved.
    """

    mode: ToolChoice

    def get_model_settings(
        self,
    ) -> ModelSettings | Callable[[RunContext[Any]], ModelSettings] | None:
        if self.mode == ToolChoice.none:
            return ModelSettings(tool_choice="none")

        def resolve(ctx: RunContext[Any]) -> ModelSettings:
            # run_step is 1 on the first model request; force a tool there, then
            # leave tool_choice untouched so the agent can produce a final answer.
            if ctx.run_step <= 1:
                return ModelSettings(tool_choice="required")
            return ModelSettings()

        return resolve


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
    model_str: str,
    providers: dict[str, CustomProvider],
    *,
    streaming: bool = True,
) -> str | Model:
    """Turn a stored model string into a value ``create_deep_agent`` accepts.

    Cloud (``openrouter:``) strings are built into an explicit model wired to a
    retrying HTTP client (see :func:`_shared_openrouter_http_client`) so upstream
    rate-limits (429) and transient 5xx are retried rather than aborting the turn
    — matching what pydantic-ai's plain-string inference builds, minus the retry.
    A ``custom:`` string is resolved against ``providers`` (keyed by id) into an
    OpenAI-compatible model object pointed at that provider's base URL. An
    unknown provider falls back to the default model. Any other string
    (e.g. ``anthropic:``) is passed through untouched.

    ``streaming`` selects the timeout regime of the HTTP client the model is
    wired to (see :func:`_model_http_timeout`). Pass ``False`` for callers that
    ``await agent.run(...)`` rather than streaming, or the per-chunk stall
    timeout silently becomes their total budget. It is keyword-only and defaults
    to ``True`` because the streaming turn is the hot path; a plain string
    (``anthropic:`` et al.) is returned untouched and ignores it, since
    pydantic-ai builds that client itself.
    """
    if model_str.startswith(OPENROUTER_PREFIX):
        model_name = model_str[len(OPENROUTER_PREFIX) :]
        return OpenAIChatModel(
            model_name,
            provider=OpenRouterProvider(
                api_key=settings.openrouter_api_key,
                http_client=_shared_openrouter_http_client(streaming=streaming),
            ),
        )

    if not model_str.startswith(CUSTOM_PREFIX):
        return model_str

    provider_id, _, model_name = model_str[len(CUSTOM_PREFIX) :].partition(":")
    provider = providers.get(provider_id)
    if provider is None or not model_name:
        # Fall back to the default model (an ``openrouter:`` string) via the same
        # path so it, too, gets the retrying client rather than a raw string.
        return resolve_model(settings.default_model, providers, streaming=streaming)

    # Route through the tolerant model: local OpenAI-compatible servers
    # (vLLM/llama.cpp/LM Studio, often behind a LiteLLM proxy) run strict chat
    # templates that reject request shapes cloud providers accept. It normalizes
    # the outgoing messages (merges the leading system-message run, coerces
    # tool-call arguments to JSON, guarantees a user turn) and — keyed on the
    # model name — restores the reasoning-family profile a generic OpenAIProvider
    # would otherwise drop (see ``tolerant_model._local_family_profile``), so
    # ``supports_thinking`` / ``reasoning_content`` are honored for non-OpenAI
    # local reasoning models.
    model = TolerantOpenAIChatModel(
        model_name,
        provider=OpenAIProvider(
            base_url=provider.base_url,
            # Local servers usually need no key; OpenAIProvider requires a
            # non-null value, so send a placeholder when none is configured.
            api_key=provider.api_key or "api-key-not-set",
            # Read cap depends on how the caller consumes the response: a
            # per-chunk stall timeout when streaming, a total budget when not
            # (see _model_http_timeout). The gateway's own request_timeout is
            # *not* a sufficient backstop — it never learns a request is in
            # flight once the connection dies.
            http_client=_shared_local_http_client(streaming=streaming),
        ),
    )
    # Strict local templates reject a request with no user turn; guarantee one.
    model._ensure_user_message = True
    return model


def _summarizer_model(
    compaction_model: str | None,
    providers: dict[str, CustomProvider],
    fallback: str | Model,
    fallback_model_str: str | None = None,
) -> str | Model:
    """The model that writes in-run summaries, resolved through Lursor's stack.

    ``fallback`` is the run's own (already resolved) model, used when the
    compaction model can't be built — the case for a local-only install with no
    OpenRouter key, where resolving the ``openrouter:`` default raises. Summarizing
    on the run's own model costs more than the small default but always works;
    what we must not do is let the library keep its ``anthropic:`` default, which
    fails at the moment compaction fires and silently drops the compaction.

    ``fallback_model_str`` is the string ``fallback`` was built from. The
    resolved ``fallback`` is wired to the *streaming* client (it is the run's own
    turn model), but summarizing is a one-shot ``.run()``, so taking it verbatim
    would reinstate the stall timeout as compaction's total budget — on exactly
    the local-only installs this fallback exists to serve. Re-resolve instead;
    the string already resolved once, so only the client differs.
    """
    model_str = compaction_model or settings.default_compaction_model
    try:
        # In-run summarization is a one-shot `.run()`, not a stream.
        return resolve_model(model_str, providers, streaming=False)
    except Exception as exc:  # noqa: BLE001 — any provider construction failure
        logger.warning(
            "compaction: summarizer model %r is unusable (%s) — summarizing on the "
            "run's own model instead",
            model_str,
            exc,
        )

    if fallback_model_str is None:
        return fallback
    try:
        return resolve_model(fallback_model_str, providers, streaming=False)
    except Exception as exc:  # noqa: BLE001 — any provider construction failure
        logger.warning(
            "compaction: could not rebuild %r on the one-shot client (%s) — "
            "summarizing on the run's streaming-wired model, which caps the "
            "summary at model_stream_stall_timeout",
            fallback_model_str,
            exc,
        )
        return fallback


def _subagent_config(
    sa: SubagentRow,
    *,
    workspace_path: str | Path,
    workspace_name: str | None,
    workspace_description: str | None,
    custom_providers: dict[str, CustomProvider],
    subagents: list[SubagentRow],
    deep_defaults: dict | None,
    parent_model: str,
    web_search_provider: str | None,
    tavily_api_key: str | None,
    exa_api_key: str | None,
    child_depth: int,
    skill_runtime: SkillRuntime | None,
    video_runtime: VideoRuntime | None = None,
    image_runtime: ImageRuntime | None = None,
    hindsight: HindsightConfig | None = None,
    compaction_model: str | None = None,
) -> dict:
    """Turn a stored subagent row into a pydantic-deep ``SubAgentConfig`` dict.

    Unlike the library's default subagent factory — which builds a stripped-down
    agent (no skills/memory/plan/nesting, thinking off) to save tokens — we attach
    our own ``agent_factory`` so the subagent is a *full* deep agent honoring the
    row's own toggles, exactly like a top-level :class:`Agent`. The factory is
    invoked lazily when the parent delegates, so no work happens here beyond
    building the closure.

    ``name``/``description``/``instructions`` stay on the config: the parent's
    task tool shows the description when choosing a specialist, and
    ``_compile_subagent`` reads ``name``/``description`` off the config even when
    an ``agent_factory`` owns the build. A subagent with no pinned ``model``
    inherits the parent's (``parent_model``). ``child_depth`` is this subagent's
    position in the nesting chain, threaded down so the depth guard in
    ``build_deep_agent`` can stop runaway self-delegation.
    """

    def factory(_cfg: dict) -> PydanticAgent:
        sub_agent, _deps = build_deep_agent(
            sa,
            workspace_path,
            workspace_name=workspace_name,
            workspace_description=workspace_description,
            custom_providers=custom_providers,
            subagents=subagents,
            deep_defaults=deep_defaults,
            model_override=sa.model or parent_model,
            web_search_provider=web_search_provider,
            tavily_api_key=tavily_api_key,
            exa_api_key=exa_api_key,
            # The parent already resolved which skills are in scope and what env
            # they carry; a subagent works in the same workspace, so it inherits
            # both rather than re-resolving (it has no session anyway).
            skill_runtime=skill_runtime,
            # Video is inherited but opt-in *twice*: the parent resolved the box
            # (a subagent has no session to resolve one with), and this row's own
            # ``include_video`` decides whether this specialist may spend it. Off
            # by default, so a video-enabled parent does not silently hand every
            # subagent minutes of GPU time.
            video_runtime=video_runtime if getattr(sa, "include_video", False) else None,
            # Image generation, inherited on the same double opt-in.
            image_runtime=image_runtime if getattr(sa, "include_image", False) else None,
            # Same reasoning for memory: a subagent works in the parent's
            # workspace, so it shares the parent's bank, connection, and scope
            # tags rather than resolving its own.
            hindsight=hindsight,
            # App-wide setting, not a per-row one: a subagent summarizes on the
            # same model as its parent (its own threshold/ratio still apply).
            compaction_model=compaction_model,
            _subagent_depth=child_depth,
        )
        return sub_agent

    return {
        "name": sa.name,
        "description": sa.description,
        "instructions": sa.instructions,
        "agent_factory": factory,
    }


def build_deep_agent(
    row: AgentRow | SubagentRow,
    workspace_path: str | Path,
    custom_providers: dict[str, CustomProvider] | None = None,
    subagents: list[SubagentRow] | None = None,
    deep_defaults: dict | None = None,
    read_only: bool = False,
    plan_mode: bool = False,
    model_override: str | None = None,
    web_search_provider: str | None = None,
    tavily_api_key: str | None = None,
    exa_api_key: str | None = None,
    workspace_name: str | None = None,
    workspace_description: str | None = None,
    workspace_id: str | None = None,
    skill_runtime: SkillRuntime | None = None,
    video_runtime: VideoRuntime | None = None,
    image_runtime: ImageRuntime | None = None,
    hindsight: HindsightConfig | None = None,
    compaction_model: str | None = None,
    extra_tools: list | None = None,
    _subagent_depth: int = 0,
) -> tuple[PydanticAgent, DeepAgentDeps]:
    """Build a deep agent + deps for ``row`` scoped to ``workspace_path``.

    ``read_only`` gates the agent to "ask" mode: the file-mutating and shell
    tools (``write_file``/``edit_file``/``hashline_edit``/``execute``) are
    filtered out via a ``PrepareTools`` capability, so the agent can read and
    search the workspace but never modify it.

    ``plan_mode`` marks a planning turn. It does **not** filter the toolset (see
    the note where ``_readonly_tool_filter`` is applied): the agent keeps its full
    tools and is held to planning by the planning prompt. It only turns off
    browser QA and the dev-server directive, neither of which a plan turn needs.

    ``skill_runtime`` carries the skills in scope for this workspace and the
    environment variables that go with them, resolved by the caller because both
    need a database session (``agents/skill_runtime.py``). ``None`` means "build
    without skills or injected env" — the case for the handful of callers that have
    no session. ``row.include_skills`` still gates the skills entirely, and the
    env-var listing in the prompt names keys only, never values.
    Tool rows are catalogued in the DB but not yet wired into execution (see
    AGENTS.md — deliberately deferred); the deep agent ships its own builtin
    toolset.

    ``workspace_name`` / ``workspace_description`` orient the agent on disk: they
    feed an ``# Environment`` section prepended to the instructions that names the
    workspace and states its absolute filesystem root (see
    :func:`_environment_instructions`). Both flow down to subagents unchanged so
    every level knows where it is working. When ``workspace_name`` is omitted the
    root directory's basename is used.

    ``model_override`` wins over ``row.model`` when set, letting a caller (e.g. a
    per-thread choice) run this agent with a different model than its stored
    default. Any model string ``resolve_model`` accepts is valid.

    ``custom_providers`` maps provider id → row and is used to route runs that
    target a locally-hosted model; callers that never use custom models can omit
    it.

    ``web_search_provider`` (with ``tavily_api_key`` / ``exa_api_key``) is the
    app-wide web-search backend (see ``AppConfig.web_search_provider`` and
    ``agents/web_search.py``). It only matters when ``row.web_search`` is on. The
    default (DuckDuckGo) is handled by the library's own ``web_search=`` flag; any
    other provider is built here as an explicit ``WebSearch`` capability and the
    library flag is suppressed so there is no duplicate ``web_search`` tool.

    ``video_runtime`` is the box and model this run's video tools would submit to
    (see ``agents/video_runtime.py``), resolved by the caller because it needs a
    session *and* the network. ``None`` — the default, and what the agent's
    ``include_video`` flag being off resolves to — means no video tools at all,
    rather than tools that fail at call time.

    ``image_runtime`` is the same arrangement for images (see
    ``agents/image_runtime.py``), and differs only in carrying every serving model
    rather than one: which to use is a cost/quality choice the agent makes per call.

    ``hindsight`` is the resolved app-wide memory configuration (see
    ``AppConfig.memory_provider`` and ``agents/hindsight.py``), passed as one
    dataclass rather than four more keyword arguments. It only matters when
    ``row.include_memory`` is on. ``None`` — the default, and what a
    misconfigured or unselected provider resolves to — means the file provider:
    pydantic-deep's per-workspace ``MEMORY.md``, unchanged from before.

    ``compaction_model`` is the ``AppConfig.compaction_model`` override for the
    model that writes *in-run* summaries, so mid-run compaction and the manual
    ``/compact`` run on the same one. ``None`` means
    ``settings.default_compaction_model``; the library's own default is an
    ``anthropic:`` model we have no key for (see ``agents/context_budget.py``).

    ``subagents`` is the global roster of specialists (see ``db.models.Subagent``).
    They are only handed to the agent when ``row.include_subagents`` is on, and a
    row with ``enabled=False`` is left out.

    ``deep_defaults`` is the ``AppConfig.deep_defaults`` override blob (subagent
    defaults — max nesting depth, disabled built-ins). We take explicit control of
    the built-in subagent roster here (``include_builtin_subagents=False``) rather
    than letting the library inject them, so built-ins can be switched off from the
    UI. This is behaviour-preserving: the library treats built-ins as ordinary
    ``SubAgentConfig`` dicts and applies the same default deep-agent factory to
    every config.

    ``extra_tools`` is the **only** way a control-plane tool can reach an agent.
    Exactly one caller passes it — ``_build_agent_and_context`` in ``api/chat.py``,
    for a run in the Assistant workspace — and passing it is also what tells
    :class:`AssistantToolGuard` this build is allowed to hold one, and what
    appends :data:`CONTROL_PLANE_PROMPT` to the instructions. Every other build
    gets ``None``, and both a build-time assert and a per-step guard raise
    :class:`AssistantToolLeak` if a privileged tool turns up in one anyway.

    Note that entitlement is a property of the *workspace*, not of ``row``: the
    same agent gets the control plane in the Assistant workspace and nothing extra
    in one of the user's projects.

    Note that ``_subagent_config`` recurses into this function *without* threading
    ``extra_tools``, deliberately: a subagent the Assistant delegates to is an
    ordinary agent, and must not inherit the control plane.
    """
    backend = _workspace_backend(workspace_path)

    # thinking is stored as an enum: "off" disables, otherwise pass the level string.
    thinking: bool | str = False if row.thinking.value == "off" else row.thinking.value

    # Skills are on-disk folders (SKILL.md + resources + scripts), not per-agent
    # links: whatever is in scope for this workspace (global assignment → assigned
    # → the repo's own ``.agents/skills``, closest layer winning) was resolved by
    # the caller into ``skill_runtime``. Hand the deep agent each folder so it
    # discovers the full standard — bundled resources (`read_skill_resource`) and
    # scripts (`run_skill_script`), not just the markdown body. ``include_skills``
    # is the master switch: when off, no skills are injected at all.
    runtime = skill_runtime if row.include_skills else None
    skill_dirs = _skill_directories(runtime)

    # Environment variables (see ``app/envvars/resolve.py``). ``set_run_env``
    # installs them for this run's context so every shell call in the run — and in
    # its subagents — spawns with them; ``set_default_env`` covers processes started
    # outside a run (an auto-restarted preview server).
    #
    # The env is a property of the *run*, not of this row's skills toggle: the
    # caller already excluded skill vars when the top-level agent has skills off
    # (``load_skill_runtime``), and a subagent shares its parent's shell environment
    # even if it can't see the skills those vars came from. So this reads the
    # runtime's env unconditionally, while ``runtime`` above gates the skill folders.
    run_env = skill_runtime.run_env if skill_runtime else None
    if run_env is not None and run_env.values:
        secrets = run_env.secret_values
        set_run_env(run_env.values, secrets)
        if isinstance(backend, DedupingLocalBackend):
            backend.set_default_env(run_env.values, secrets)

    # Global subagents apply only when the agent opts into subagents. We assemble
    # the full roster ourselves — user subagents plus the pydantic-deep built-ins
    # (general-purpose, research) — so built-ins can be overridden or disabled from
    # the UI. See ``agents/deep_defaults.py`` for the resolution rules.
    resolved_defaults = resolve_subagent_defaults(deep_defaults)
    # Nesting guard: subagents are now full deep agents, so one that opts into
    # ``include_subagents`` builds its own subagent toolset — which the library
    # does NOT re-bound by the runtime depth counter (each level gets a fresh
    # toolset with the full ``max_nesting_depth``). We bound it at construction
    # instead: a subagent at depth ``d`` may itself delegate only while
    # ``d < max_nesting_depth``. The top-level agent is depth 0.
    max_depth = resolved_defaults["max_nesting_depth"]
    allow_subagents = _subagent_depth < max_depth
    include_subagents = row.include_subagents and allow_subagents

    # Stored model string handed to nested subagents so an unpinned subagent
    # inherits this (parent) model rather than falling back to the global default.
    parent_model = model_override or row.model or settings.default_model

    subagent_configs: list[dict] = []
    if include_subagents:
        providers = custom_providers or {}
        rows = subagents or []
        child_depth = _subagent_depth + 1

        def _config(sa: SubagentRow) -> dict:
            return _subagent_config(
                sa,
                workspace_path=workspace_path,
                workspace_name=workspace_name,
                workspace_description=workspace_description,
                custom_providers=providers,
                subagents=rows,
                deep_defaults=deep_defaults,
                parent_model=parent_model,
                web_search_provider=web_search_provider,
                tavily_api_key=tavily_api_key,
                exa_api_key=exa_api_key,
                child_depth=child_depth,
                skill_runtime=skill_runtime,
                video_runtime=video_runtime,
                image_runtime=image_runtime,
                hindsight=hindsight,
                compaction_model=compaction_model,
            )

        # Disabled user subagents stay in the roster/UI but are excluded from the
        # specialist set here.
        subagent_configs = [_config(sa) for sa in rows if sa.enabled]

        # Built-ins are a plain on/off toggle: an enabled one is handed to the
        # library as a bare config dict, so it gets pydantic-deep's own lean
        # subagent factory. To get a built-in *with* skills, web search, or a pinned
        # model, switch it off and create an ordinary subagent instead.
        #
        # A user subagent of the same name wins outright. The library keys its
        # compiled roster by name, so without this the built-in would silently
        # shadow the row the user actually authored.
        disabled = set(resolved_defaults["disabled_builtins"])
        taken = {cfg["name"] for cfg in subagent_configs}
        subagent_configs.extend(
            dict(builtin)
            for builtin in builtin_subagent_defaults()
            if builtin["name"] not in disabled and builtin["name"] not in taken
        )

    # Every library knob we set a non-default value for may also be supplied via
    # the extra_config escape hatch; where it is, let it win rather than passing
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
    if "retries" not in extra_config:
        managed_kwargs["retries"] = _TOOL_RETRIES
    if "subagent_usage_limits" not in extra_config:
        managed_kwargs["subagent_usage_limits"] = _SUBAGENT_USAGE_LIMITS

    # view_image is always available so any agent can inspect user-attached
    # media (and workspace images) via the dedicated vision model, regardless of
    # whether its own chat model supports image input.
    tools = list(extra_config.pop("tools", []) or [])
    tools.append(make_view_image_tool(workspace_path))

    # Video generation, when the caller resolved a box that can do it. Both gates
    # (the agent's ``include_video`` flag and a connection serving a video-capable
    # model) are already spent by the time this is not None — see
    # ``load_video_runtime``. All four tools are deferred like every other non-core
    # tool, so an agent that never generates a clip pays nothing for having them
    # (``agents/tool_loading.py``); the skill's opening line tells the model to
    # ``search_tools("video")`` if they are not in its list.
    if video_runtime is not None:
        tools.extend(make_video_tools(video_runtime, workspace_path))

    # Image generation, on the same two gates. ``video_available`` only decides
    # whether the tool's docstring may mention ``generate_video`` — advertising a
    # tool the agent does not have is its own kind of wrong answer.
    if image_runtime is not None:
        tools.extend(
            make_image_tools(
                image_runtime,
                workspace_path,
                video_available=video_runtime is not None,
            )
        )

    # The control plane, for the one agent entitled to it (see ``app/assistant/``).
    # The assert covers what we hand to ``create_deep_agent``; ``AssistantToolGuard``
    # below covers everything that can appear later.
    tools.extend(extra_tools or [])
    assert_no_assistant_tools(
        [getattr(t, "__name__", "") for t in tools], allowed=extra_tools is not None
    )

    # Read-only ("ask") mode filters the mutating tools via a PrepareTools
    # capability. Merge with any capabilities supplied through the escape hatch
    # so we never pass the keyword twice.
    capabilities = list(extra_config.pop("capabilities", []) or [])

    # First in the list on purpose — it is a fallback, and the combined capability
    # consults error hooks in reverse order (see ``ToolErrorsAsText``). Without it
    # a single unhandled tool exception (a `web_search` rate-limit, say) kills the
    # turn outright, with no retry and no way for the model to react.
    capabilities.insert(0, ToolErrorsAsText())

    if read_only:
        capabilities.append(PrepareTools(_readonly_tool_filter))

    # Honest roster: the library's ``task`` description hardcodes a
    # "use general-purpose" fallback and its ``subagent_type`` takes any string, so
    # rewrite both from the roster this agent actually got (see
    # ``_task_tool_roster_filter``). The names must be the ones the library will
    # compile: whatever we pass as ``subagents`` — or the escape hatch's own list,
    # which wins — plus the ``planner`` built-in the library appends itself when
    # plan mode is on (``pydantic_deep/agent.py``, same ``include_plan`` condition).
    if include_subagents:
        passed_configs = (
            extra_config.get("subagents")
            if "subagents" in extra_config
            else subagent_configs
        )
        roster_names = [
            str(cfg["name"])
            for cfg in (passed_configs or [])
            if isinstance(cfg, dict) and cfg.get("name")
        ]
        if row.include_plan and "planner" not in roster_names:
            roster_names.append("planner")
        capabilities.append(PrepareTools(_task_tool_roster_filter(roster_names)))

    # Plan mode deliberately adds no filter here — a plan turn keeps the full
    # toolset and is held to planning by the planning prompt alone (see the note
    # above the ``ForceToolChoice`` class for why the plan allowlist was dropped).

    # Forced tool choice: an agent can require the model to call a tool (on the
    # opening step) or forbid tool calls entirely. "auto" is the model default,
    # so only add the capability when the agent actually constrains the choice.
    if row.tool_choice != ToolChoice.auto:
        capabilities.append(ForceToolChoice(row.tool_choice))

    # Web search: the per-agent flag decides whether the agent can search; the
    # app-wide provider decides which backend. The library's ``web_search=`` flag
    # only wires DuckDuckGo, so for any non-default provider we build the
    # capability ourselves and suppress the library's (``library_web_search`` →
    # False) to avoid registering the ``web_search`` tool twice. The default
    # provider stays on the library path, unchanged from before.
    provider = web_search_provider or DEFAULT_WEB_SEARCH_PROVIDER
    use_custom_web_search = row.web_search and provider != DEFAULT_WEB_SEARCH_PROVIDER
    if use_custom_web_search:
        capabilities.append(
            build_web_search_capability(
                provider,
                tavily_api_key=tavily_api_key,
                exa_api_key=exa_api_key,
            )
        )
    library_web_search = row.web_search and not use_custom_web_search

    # Web fetch: same shape as the custom web-search path — build the capability
    # ourselves and suppress the library's (``web_fetch=False``) so the tool isn't
    # registered twice. Ours differs from ``WebFetch(local=True)`` only in that a
    # failed fetch returns text instead of burning retry budget and eventually
    # killing the turn; see agents/web_fetch.py.
    if "web_fetch" not in extra_config:
        capabilities.append(build_web_fetch_capability())
        managed_kwargs["web_fetch"] = False

    # Browser QA: give executing agents a headless browser to see and test the app
    # they build (see ``browser_qa.py``). A fresh capability per build keeps its
    # single page/telemetry from colliding across concurrent runs. Gated to the
    # per-agent ``browser_qa`` flag, to non-read-only agents (it can drive/execute
    # JS), to callers that pass a ``workspace_id`` (needed to resolve the dev-server
    # URL — top-level runs, not subagents), and to the app-wide toggle. Chromium
    # installs itself on first use.
    # ``build_deep_agent`` also renders Subagent rows, which have no ``browser_qa``
    # field (and never get browser QA — they pass no workspace_id); default on so
    # top-level agents predating the flag keep their tools.
    browser_qa_on = (
        getattr(row, "browser_qa", True)
        and not read_only
        and not plan_mode
        and workspace_id is not None
        and settings.browser_qa_enabled
    )
    if browser_qa_on:
        capabilities.append(
            BrowserQACapability(
                workspace_id=workspace_id,
                media_dir=settings.media_dir,
                headless=settings.browser_qa_headless,
            )
        )

    # Memory: the per-agent ``include_memory`` flag is the master switch; the
    # app-wide provider decides where memory lives. On the "hindsight" provider we
    # suppress the library's MEMORY.md toolset (``include_memory=False``) and
    # attach our own capability instead, so the model is never offered two
    # overlapping sets of memory tools. A fresh capability per build keeps its
    # per-turn recall cache from being shared across concurrent runs. Existing
    # MEMORY.md files are left on disk untouched, so flipping back is lossless.
    use_hindsight = row.include_memory and hindsight is not None
    if use_hindsight:
        assert hindsight is not None  # narrowed by use_hindsight
        capabilities.append(
            build_hindsight_capability(
                hindsight,
                workspace_id=workspace_id,
                workspace_name=workspace_name,
                workspace_path=workspace_path,
                agent_name=row.name,
                read_only=read_only,
            )
        )
    library_memory = row.include_memory and not use_hindsight

    # File-editing guards: make the hashline anchors load-bearing (a range edit
    # must validate both ends), stop ``write_file`` overwriting a file this agent
    # never read, and hand the model fresh anchors when one misses instead of
    # costing it a full re-read. Unconditional — every agent that can edit files
    # gets them, and on a read-only agent the guarded tools are filtered out above
    # so the capability simply never fires. See ``agents/file_editing.py`` and
    # ``docs/FILE-EDITING-AUDIT.md``.
    capabilities.append(FileEditingGuards())

    # Post-edit syntax check, immediately after the guards so it sees the same
    # writes: report only breakage an edit *introduced*, in the languages we can
    # parse without installing anything. See ``agents/edit_syntax.py``.
    capabilities.append(EditSyntaxCheck())

    # On-demand tool loading, last so the tool-search wrapper sits outside every
    # capability above and sees the roster they produced (see
    # ``agents/tool_loading.py``). Non-core tools are marked ``defer_loading`` and
    # revealed by a ``search_tools`` call instead of riding in the prompt from the
    # start. Composes with the filters above rather than fighting them: both of
    # them run per step, so the read-only allowlist still vets a tool the model
    # discovers mid-turn, and ``task`` is still rewritten to the live roster once
    # revealed.
    if settings.tool_search_enabled:
        capabilities.extend(
            build_tool_loading_capabilities(
                # The Assistant keeps a handful of control-plane tools hot; the
                # other ~21 are discovered like everything else, so 26 extra
                # tools cost nothing on a turn that does not use them.
                extra_core=ASSISTANT_CORE_TOOLS if extra_tools is not None else frozenset()
            )
        )

    # Last, so it sits outside every filter above and sees the final roster each
    # step — including anything tool search reveals mid-turn. A no-op on the
    # Assistant's own build; installed there anyway so every agent has one and a
    # test can assert as much.
    capabilities.append(AssistantToolGuard(allowed=extra_tools is not None))

    run_model_str = model_override or row.model or settings.default_model
    model = resolve_model(run_model_str, custom_providers or {})

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

    # Append the English-by-default directive to the agent's instructions. When
    # the agent has no custom instructions we fall back to the library's base
    # prompt (what ``create_deep_agent`` would have used) so we extend it rather
    # than replace it — passing a non-None value swaps out the default entirely.
    base_instructions = row.instructions or BASE_PROMPT
    # The control-plane rules travel with the control-plane tools, always. The row
    # is an ordinary user-editable agent, so its prompt is its own — but the rules
    # around destructive actions are not editable, because there is no build that
    # hands over ``extra_tools`` without also appending this.
    if extra_tools is not None:
        base_instructions = f"{base_instructions}\n\n{CONTROL_PLANE_PROMPT}"
    environment = _environment_instructions(
        workspace_path, workspace_name, workspace_description, skill_runtime
    )
    instructions = (
        f"{base_instructions}\n\n{environment}\n\n{DEFAULT_LANGUAGE_DIRECTIVE}"
    )
    if not read_only and not plan_mode:
        instructions = f"{instructions}\n\n{DEV_SERVER_DIRECTIVE}"
    if browser_qa_on:
        instructions = f"{instructions}\n\n{BROWSER_QA_DIRECTIVE}"
    # Gated on the resolved runtime rather than on ``row.include_image``: with the
    # flag on but nothing serving there is no tool, and telling an agent to use one
    # it does not have is the failure this directive exists to prevent.
    if image_runtime is not None:
        instructions = f"{instructions}\n\n{IMAGE_GENERATION_DIRECTIVE}"
    if use_hindsight:
        instructions = f"{instructions}\n\n{HINDSIGHT_MEMORY_DIRECTIVE}"

    agent = create_deep_agent(
        model=model,
        instructions=instructions,
        backend=backend,
        tools=tools,
        skill_directories=skill_dirs or None,
        include_todo=row.include_todo,
        include_subagents=include_subagents,
        include_skills=row.include_skills,
        include_memory=library_memory,
        include_plan=row.include_plan,
        web_search=library_web_search,
        thinking=thinking,
        capabilities=capabilities or None,
        **managed_kwargs,
        **subagents_kwarg,
        **extra_config,
    )
    # Retune the context manager the library just built to this row's compaction
    # settings (when the window fills up, how much of it gets summarized, and which
    # model writes the summary — the library's default is an ``anthropic:`` one we
    # have no key for). Applies to subagents too: each one comes back through here
    # via its own factory, so a specialist compacts on its own budget, not its
    # parent's.
    apply_compaction_settings(
        agent,
        row,
        _summarizer_model(
            compaction_model,
            custom_providers or {},
            fallback=model,
            fallback_model_str=run_model_str,
        ),
    )
    deps = create_default_deps(backend)
    return agent, deps
