"""The isolation boundary: which tool names are control-plane, and the guard.

This module is deliberately a **leaf**. It imports nothing from ``app.agents``,
``app.api`` or ``app.assistant.tools`` — only pydantic-ai. That is what lets
``agents/builder.py`` import the guard without a cycle, and it is why
:data:`ASSISTANT_TOOL_NAMES` is a hand-written literal rather than something
derived by importing :mod:`app.assistant.tools`.

A hand-written set can drift from the tools that actually exist, which is trap
15 (``_READONLY_TOOL_ALLOWLIST`` once allowlisted ``"web_search"``, a name no
tool ever had, and killed every ``/ask`` turn on local models). Two things stop
that here, and neither is a subset assertion — a subset passes a dead entry
silently:

- :func:`assert_registry_matches` is called at the bottom of ``tools.py``, so an
  import of the toolset fails loudly on any mismatch in either direction.
- ``tests/test_assistant_isolation.py`` compares this set against the names a
  real build registers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.tools import RunContext, ToolDefinition


class AssistantToolLeak(RuntimeError):
    """A control-plane tool reached an agent that must not have one.

    Raised rather than filtered on purpose. A filter would make a leak invisible:
    the agent would quietly lose a tool and the bug would surface months later as
    "why can't this agent do X". A leak here means the boundary is broken, and
    the only safe response to a broken boundary is to stop.
    """


# Every tool defined in ``tools.py``. The single source of truth for "this name
# is privileged"; keep it sorted within its group.
ASSISTANT_TOOL_NAMES: frozenset[str] = frozenset(
    {
        # Workspaces
        "lursor_list_workspaces",
        "lursor_create_workspace",
        "lursor_update_workspace",
        "lursor_delete_workspace",
        # Agents
        "lursor_list_agents",
        "lursor_create_agent",
        "lursor_update_agent",
        "lursor_delete_agent",
        # Schedules
        "lursor_list_schedules",
        "lursor_create_schedule",
        "lursor_update_schedule",
        "lursor_run_schedule_now",
        "lursor_delete_schedule",
        # Conversations and runs
        "lursor_list_threads",
        "lursor_read_thread",
        "lursor_delegate",
        "lursor_run_status",
        "lursor_stop_run",
        "lursor_delete_thread",
        # Configuration
        "lursor_get_settings",
        "lursor_update_settings",
        "lursor_list_models",
        "lursor_list_providers",
        # Inventory
        "lursor_list_skills",
        "lursor_list_subagents",
        "lursor_usage_report",
    }
)

# The ones that stay out of tool-search deferral. Chosen as "what the Assistant
# reaches for in the first turn of a typical request" — orientation and the two
# most-asked-for actions. Everything else is discovered via ``search_tools``,
# which is what keeps 26 new tools from being a ~5k-token regression on every
# turn (see ``docs/TOOL-SURFACE-AUDIT.md`` §3).
#
# All five names are also in ``ASSISTANT_TOOL_NAMES`` — asserted below, because a
# typo here would silently defer a tool we meant to keep hot.
ASSISTANT_CORE_TOOLS: frozenset[str] = frozenset(
    {
        "lursor_list_workspaces",
        "lursor_list_agents",
        "lursor_list_schedules",
        "lursor_create_workspace",
        "lursor_update_agent",
    }
)

assert ASSISTANT_CORE_TOOLS <= ASSISTANT_TOOL_NAMES, (
    "ASSISTANT_CORE_TOOLS names a tool that does not exist: "
    f"{sorted(ASSISTANT_CORE_TOOLS - ASSISTANT_TOOL_NAMES)}"
)

# Destructive: gated on an in-chat confirmation (``confirm.py``). Listed here
# rather than in ``tools.py`` so the boundary and the danger set are readable
# side by side.
ASSISTANT_DESTRUCTIVE_TOOLS: frozenset[str] = frozenset(
    {
        "lursor_delete_workspace",
        "lursor_delete_agent",
        "lursor_delete_schedule",
        "lursor_delete_thread",
    }
)

assert ASSISTANT_DESTRUCTIVE_TOOLS <= ASSISTANT_TOOL_NAMES, (
    "ASSISTANT_DESTRUCTIVE_TOOLS names a tool that does not exist: "
    f"{sorted(ASSISTANT_DESTRUCTIVE_TOOLS - ASSISTANT_TOOL_NAMES)}"
)


def assert_registry_matches(names: set[str]) -> None:
    """Fail unless ``names`` is exactly :data:`ASSISTANT_TOOL_NAMES`.

    Equality, not containment, in both directions: a *missing* name means the
    guard would not recognise a real tool as privileged, and an *extra* name
    means the guard is protecting something that does not exist and a genuine
    tool may be going unguarded under a slightly different spelling.
    """
    missing = ASSISTANT_TOOL_NAMES - names
    extra = names - ASSISTANT_TOOL_NAMES
    if missing or extra:
        raise AssistantToolLeak(
            "assistant tool registry is out of sync with app/assistant/tools.py — "
            f"declared but not defined: {sorted(missing)}; "
            f"defined but not declared: {sorted(extra)}"
        )


def assert_no_assistant_tools(tool_names: list[str], *, allowed: bool) -> None:
    """Build-time check that no control-plane tool is in a non-assistant build."""
    if allowed:
        return
    leaked = sorted(set(tool_names) & ASSISTANT_TOOL_NAMES)
    if leaked:
        raise AssistantToolLeak(
            f"control-plane tools reached a non-assistant agent build: {leaked}"
        )


@dataclass
class AssistantToolGuard(AbstractCapability[Any]):
    """Re-checks the boundary on every step, not just at build time.

    The build-time assert covers the tools we hand to ``create_deep_agent``. It
    cannot cover a tool that appears *later*: one revealed by tool search, or one
    arriving through a toolset we did not construct. Both are real — the
    read-only filter is re-run every step for exactly this reason
    (``agents/builder.py``) — so the boundary needs a per-step check too.

    ``allowed=True`` on the Assistant's own build turns this into a no-op; it is
    still installed there so the capability list is uniform and a test can assert
    every build has one.
    """

    allowed: bool = False

    async def prepare_tools(
        self, ctx: RunContext[Any], tool_defs: list[ToolDefinition]
    ) -> list[ToolDefinition]:
        if not self.allowed:
            leaked = sorted({t.name for t in tool_defs} & ASSISTANT_TOOL_NAMES)
            if leaked:
                raise AssistantToolLeak(
                    "control-plane tools reached a non-assistant agent at run time: "
                    f"{leaked}"
                )
        return tool_defs
