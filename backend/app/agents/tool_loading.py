"""On-demand tool loading — keep a small core in context, discover the rest.

A fully-enabled Lursor agent (subagents + skills + memory + web + browser QA)
offers the model **51 tools, ~10.6k tokens of definitions** — seven times the
prompt Lursor writes itself. That is over both thresholds Anthropic gives for
tool search (10+ tools, 10k+ tokens of definitions), and past the 30-50 tool band
where tool-selection accuracy starts to degrade:
https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool

So we adopt that structure: every tool outside a small always-loaded core is
marked ``defer_loading=True`` and stays out of the model's context until it is
discovered by search.

**How the transport is chosen.** pydantic-ai's :class:`ToolSearch` capability
resolves native-vs-local per model:

- *native* (Anthropic direct, OpenAI Responses) — deferred definitions ride the
  wire with ``defer_loading`` and the provider runs discovery server-side.
- *local* — deferred definitions are withheld from the wire and a ``search_tools``
  function tool does keyword discovery; a discovered tool stays visible for the
  rest of the run.

Lursor is on the local path today, always: every model resolves to
``OpenAIChatModel`` (OpenRouter) or ``TolerantOpenAIChatModel``
(``custom:``/laios), and neither advertises the tool-search native tool. That is
also the portable path, so local models behave the same as cloud ones. Adding a
direct ``anthropic:`` provider later flips it to the native path with no change
here.

**Why a threshold and not always-on.** Discovery costs a model round trip, so it
only pays when there is a real roster to hide. Below :data:`_MIN_DEFERRABLE`
nothing is deferred, and pydantic-ai then emits no ``search_tools`` tool at all —
zero overhead. This is what keeps ``/ask`` (16 tools, nearly all core) on a flat
roster without special-casing it.

**Where the guidance lives.** The failure mode of deferral is an agent that was
told to use a tool it cannot see and concludes it has no such capability —
exactly the class of bug that made ``/ask`` + web search fatal (see
``_READONLY_TOOL_ALLOWLIST`` in ``builder.py``). Two things guard against it:
everything Lursor's own directives name by hand is core, and the rest of the
guidance — the category map, and "a tool the instructions name but your list
lacks is deferred, not missing" — rides on :data:`_SEARCH_TOOL_DESCRIPTION`
rather than the system prompt. That placement is deliberate: pydantic-ai
registers ``search_tools`` only when something is actually deferred, so the
guidance cannot outlive the mechanism it describes. A system-prompt block could
not manage that — instructions are assembled *before* tools are prepared each
step, so any "did we defer?" flag read at instruction time is a step stale, and
on the opening step it would be wrong.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from pydantic_ai.capabilities import AbstractCapability, ToolSearch
from pydantic_ai.tools import RunContext, ToolDefinition

# Always loaded: used in most turns, or named by hand in an instruction block we
# inject (``DEV_SERVER_DIRECTIVE``, ``BROWSER_QA_INSTRUCTIONS``,
# ``HINDSIGHT_MEMORY_DIRECTIVE``, the library's todo/console prompts).
_CORE_TOOLS = frozenset(
    {
        # workspace read + navigation — the inner loop of every turn
        "ls",
        "read_file",
        "glob",
        "grep",
        # edit
        "write_file",
        "hashline_edit",
        # shell + dev servers. The background-shell trio is core because
        # ``DEV_SERVER_DIRECTIVE`` tells the model to run ``list_shells`` *before*
        # starting a server and to read its output afterwards.
        "execute",
        "run_in_background",
        "list_shells",
        "read_output",
        "kill_shell",
        # the todo board the library's task-management prompt drives. The granular
        # mutations (``add_todo``/``remove_todo``/``update_todo_status``) are
        # deferred: they are conveniences over these three.
        "read_todos",
        "write_todos",
        "update_todo_statuses",
        # skills: the entry points only. ``read_skill_resource``/``run_skill_script``
        # are deferred — they are reachable only once a skill has been loaded, and
        # ``load_skill``'s own output points at them.
        "list_skills",
        "load_skill",
        # long-term memory, both providers. Deferring these would silently stop an
        # agent retaining anything, which is invisible until someone notices memory
        # is empty.
        "read_memory",
        "write_memory",
        "update_memory",
        "hindsight_recall",
        "hindsight_reflect",
        "hindsight_retain",
        # web. Named by provider, never "web_search" (see ``agents/web_search.py``);
        # the native variants are not function tools and never reach this filter.
        "web_fetch",
        "duckduckgo_search",
        "tavily_search",
        "exa_search",
        # user-attached media — cheap, and needed the moment an image is attached
        "view_image",
        # discovery itself. It is emitted by the tool-search wrapper *outside* this
        # filter so it should never appear here, but deferring the tool that reveals
        # deferred tools would strand the whole roster.
        "search_tools",
    }
)

# Minimum number of tools that must be deferrable before deferral engages at all.
# Under this, hiding tools costs a discovery round trip and saves little.
_MIN_DEFERRABLE = 8

# Kinds that must never be deferred: ``output`` ends the run (deferring it would
# hide the agent's own output tool) and ``external`` is resolved outside the run.
_UNDEFERRABLE_KINDS = frozenset({"output", "external"})

# Description for the model-facing ``search_tools`` tool, replacing the library's
# generic one. Carries the whole contract, because this text is in context exactly
# when deferral is live:
#
# 1. the category map, so a first search has something to aim at (Anthropic's
#    "describe the available tool categories" guidance). The keywords named here
#    are ones that really occur in the deferred tools' names and descriptions —
#    local discovery scores by token overlap against those two fields, so a
#    category word that appears in neither would send the model looking for
#    nothing.
# 2. the rule for the failure mode that matters: an instruction block naming a
#    tool the model cannot currently see.
# 3. "nothing found means it does not exist", from the library default — without it
#    a model burns turns re-searching.
_SEARCH_TOOL_DESCRIPTION = (
    "Load tools that are not currently in your tool list. Pass keywords describing "
    "the capability you need; matching tools are activated for the rest of this "
    "turn. Your visible tools already cover files, search, editing, shell and "
    "background processes, the todo board, skills, memory and the web. Available "
    "here on demand:\n"
    "- subagent delegation, steering and cancellation — 'task', 'subagent'\n"
    "- the QA browser for the local app: open it, see it, read console and network "
    "errors, click and type — 'browser', 'app', 'console', 'network'\n"
    "- watching a long-running command's output as it appears — 'monitor'\n"
    "- single-item todo edits — 'todo'\n"
    "- searching earlier conversation, compacting context — 'conversation', "
    "'compact'\n"
    "- running a skill's scripts, reading its bundled resources — 'skill'\n"
    "If your instructions name a tool that is not in your tool list, it is "
    "deferred rather than missing: search for it here, then use it. Prefer one "
    "search covering the whole job over several narrow ones. Queries are tokenized "
    "and scored by overlap against tool names and descriptions; if a search "
    "returns nothing, those tools do not exist — do not retry."
)

_SEARCH_PARAMETER_DESCRIPTION = (
    "Keywords describing the capability you need (e.g. 'browser console errors', "
    "'delegate task to subagent'). Each query is tokenized and matched against "
    "tool names, descriptions and argument names; matches are unioned."
)


def _deferrable(tool_def: ToolDefinition, core: frozenset[str] = _CORE_TOOLS) -> bool:
    """Whether ``tool_def`` may be hidden until discovered."""
    return tool_def.name not in core and tool_def.kind not in _UNDEFERRABLE_KINDS


def defer_non_core_tools(
    _ctx: RunContext[Any],
    tool_defs: list[ToolDefinition],
    core: frozenset[str] = _CORE_TOOLS,
) -> list[ToolDefinition]:
    """A ``ToolsPrepareFunc`` that marks every non-core tool ``defer_loading``.

    Runs each step, on the definitions actually present — so the threshold reacts
    to the roster this agent really has (flags off, ``/ask`` filtering) rather than
    to what a maximal build would offer. Returns the list untouched when too few
    tools are deferrable, which leaves the tool-search wrapper with nothing to do
    and no ``search_tools`` tool to register.
    """
    if sum(1 for td in tool_defs if _deferrable(td, core)) < _MIN_DEFERRABLE:
        return tool_defs
    return [
        replace(td, defer_loading=True) if _deferrable(td, core) else td for td in tool_defs
    ]


@dataclass
class DeferNonCoreTools(AbstractCapability[Any]):
    """Marks every non-core tool ``defer_loading`` so tool search can hide it.

    A named capability rather than a bare ``PrepareTools(defer_non_core_tools)``:
    it reads as itself in a capability list, and the builder's other tool filters
    are identified structurally by tests (``builder.py``'s read-only and task-roster
    filters are both plain ``PrepareTools``), which an anonymous third one would
    make ambiguous.

    ``core`` is the always-loaded set for this build. It is a field rather than a
    module constant because one agent — the Assistant — has its own tools to keep
    hot (``app/assistant/registry.py``), and widening the shared ``_CORE_TOOLS``
    for its sake would un-defer them for every other agent too.
    """

    core: frozenset[str] = _CORE_TOOLS

    async def prepare_tools(
        self, ctx: RunContext[Any], tool_defs: list[ToolDefinition]
    ) -> list[ToolDefinition]:
        return defer_non_core_tools(ctx, tool_defs, self.core)


def build_tool_loading_capabilities(
    *, extra_core: frozenset[str] = frozenset()
) -> list[AbstractCapability[Any]]:
    """Capabilities that put non-core tools behind ``search_tools``.

    Order matters: the deferral marker must be visible *inside* the tool-search
    wrapper, which reads ``defer_loading`` off the toolset it wraps.
    :class:`ToolSearch` declares itself outermost, so appending both in this order
    is enough.

    ``extra_core`` widens the always-loaded set for this build only.
    """
    return [
        DeferNonCoreTools(core=_CORE_TOOLS | extra_core),
        ToolSearch(
            tool_description=_SEARCH_TOOL_DESCRIPTION,
            parameter_description=_SEARCH_PARAMETER_DESCRIPTION,
        ),
    ]
