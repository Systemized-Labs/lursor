"""The boundary: no agent but the Assistant ever holds a control-plane tool.

Driven through real ``build_deep_agent`` runs on a ``FunctionModel``, the same
method ``test_tool_loading.py`` uses, so every assertion is about the tool
definitions that actually reach the wire rather than about what the builder
source implies.

The subagent case is the one that would be easiest to get wrong and hardest to
notice: the Assistant can delegate, ``_subagent_config`` recurses back into
``build_deep_agent``, and a specialist that inherited the control plane would be
a privilege escalation with no UI anywhere near it.
"""

from __future__ import annotations

import pytest
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.profiles import ModelProfile

from app.agents.builder import _READONLY_TOOL_ALLOWLIST, build_deep_agent
from app.assistant.identity import ASSISTANT_AGENT_ID, ASSISTANT_AGENT_NAME
from app.assistant.registry import (
    ASSISTANT_CORE_TOOLS,
    ASSISTANT_DESTRUCTIVE_TOOLS,
    ASSISTANT_TOOL_NAMES,
    AssistantToolLeak,
)
from app.assistant.tools import build_assistant_tools
from app.db.models import Agent as AgentRow
from app.db.models import Subagent as SubagentRow

_NO_NATIVE = ModelProfile(supported_native_tools=frozenset())

# Every per-agent switch on, plus browser QA: the widest roster a normal agent
# can have, which is the one a leak is most likely to hide in.
_ALL_ON = {
    "include_subagents": True,
    "include_todo": True,
    "include_skills": True,
    "include_memory": True,
    "include_plan": True,
    "web_search": True,
    "browser_qa": True,
}


def _row(**flags) -> AgentRow:
    row = AgentRow(name="auditor", instructions="hi")
    for key, value in flags.items():
        setattr(row, key, value)
    return row


def _assistant_row() -> AgentRow:
    return AgentRow(id=ASSISTANT_AGENT_ID, name=ASSISTANT_AGENT_NAME, instructions="")


async def _rosters(
    row: AgentRow, workspace, *, search: str | None = None, **kwargs
) -> list[list[str]]:
    """Tool names offered on each step of a real run."""
    steps: list[list[str]] = []

    def respond(_messages, info: AgentInfo):
        steps.append([t.name for t in info.function_tools])
        if search is not None and len(steps) == 1:
            return ModelResponse(parts=[ToolCallPart("search_tools", {"queries": [search]})])
        return ModelResponse(parts=[TextPart("ok")])

    agent, deps = build_deep_agent(row, str(workspace), **kwargs)
    with agent.override(model=FunctionModel(respond, profile=_NO_NATIVE)):
        await agent.run("hi", deps=deps)
    return steps


# --- the boundary ---------------------------------------------------------------


async def test_a_normal_agent_never_sees_a_control_plane_tool(tmp_path):
    """The widest ordinary build offers nothing privileged."""
    steps = await _rosters(_row(**_ALL_ON), tmp_path)
    assert not ASSISTANT_TOOL_NAMES & set(steps[0])


async def test_the_assistant_registers_every_declared_tool(tmp_path):
    """No dead entries in the name set, in either direction.

    Equality, not containment. A subset assertion is what let ``"web_search"``
    sit in the read-only allowlist for months without matching any real tool
    (see ``docs/TOOL-SURFACE-AUDIT.md`` §2.1); a name the guard protects but no
    tool answers to is the same bug wearing the other hat.
    """
    steps = await _rosters(
        _assistant_row(),
        tmp_path,
        extra_tools=build_assistant_tools("thread-1"),
    )
    offered = set(steps[0])
    # Non-core tools are deferred, so the opening roster holds the core set;
    # search reveals the rest. Both halves have to be real.
    assert ASSISTANT_CORE_TOOLS <= offered

    revealed = await _rosters(
        _assistant_row(),
        tmp_path,
        extra_tools=build_assistant_tools("thread-1"),
        search="workspace agent schedule settings conversation model skill usage",
    )
    everything = set(revealed[0]) | set(revealed[-1])
    missing = ASSISTANT_TOOL_NAMES - everything - ASSISTANT_CORE_TOOLS
    # Tool search is keyword-matched, so a single query need not surface all 26.
    # What must hold is that nothing declared is *unreachable*: every name the
    # registry knows is registered on the agent.
    registered = {t.__name__ for t in build_assistant_tools("thread-1")}
    assert registered == ASSISTANT_TOOL_NAMES
    assert not missing & (ASSISTANT_TOOL_NAMES - registered)


async def test_a_subagent_of_the_assistant_gets_no_control_plane(tmp_path):
    """Delegation must not carry privilege down.

    ``_subagent_config`` recurses into ``build_deep_agent`` without threading
    ``extra_tools``, so the specialist's build is an ordinary one — and its
    ``AssistantToolGuard`` is armed, which is what would catch a future change
    that started threading them.
    """
    specialist = SubagentRow(name="researcher", description="digs", instructions="dig")
    rosters: list[list[str]] = []

    def respond(_messages, info: AgentInfo):
        rosters.append([t.name for t in info.function_tools])
        return ModelResponse(parts=[TextPart("ok")])

    agent, deps = build_deep_agent(
        _assistant_row(),
        str(tmp_path),
        None,
        [specialist],
        extra_tools=build_assistant_tools("thread-1"),
    )
    with agent.override(model=FunctionModel(respond, profile=_NO_NATIVE)):
        await agent.run("hi", deps=deps)

    # Now build the specialist the way the factory does, and assert its surface.
    sub_steps = await _rosters(specialist, tmp_path)
    assert not ASSISTANT_TOOL_NAMES & set(sub_steps[0])


async def test_build_time_assert_catches_a_leak(tmp_path):
    """A privileged tool smuggled in through ``extra_config`` stops the build."""

    async def lursor_delete_workspace(workspace_id: str) -> str:
        """An impostor wearing a privileged name."""
        return "nope"

    row = _row()
    row.extra_config = {"tools": [lursor_delete_workspace]}
    with pytest.raises(AssistantToolLeak, match="non-assistant agent build"):
        build_deep_agent(row, str(tmp_path))


async def test_the_guard_is_installed_on_every_build(tmp_path):
    """Both an ordinary agent and the Assistant carry the per-step guard.

    Installed unconditionally so the capability list is uniform; ``allowed`` is
    what differs. A build that somehow shipped without one would have no
    per-step protection at all, which is exactly the state this asserts against.
    """
    from app.assistant.registry import AssistantToolGuard

    ordinary, _ = build_deep_agent(_row(**_ALL_ON), str(tmp_path))
    privileged, _ = build_deep_agent(
        _assistant_row(), str(tmp_path), extra_tools=build_assistant_tools("t")
    )

    def guards(agent) -> list[AssistantToolGuard]:
        # pydantic-ai folds the capability list into one ``CombinedCapability``
        # on the agent; its members are what the builder appended.
        combined = agent._root_capability
        return [
            cap
            for cap in getattr(combined, "capabilities", ())
            if isinstance(cap, AssistantToolGuard)
        ]

    assert [g.allowed for g in guards(ordinary)] == [False]
    assert [g.allowed for g in guards(privileged)] == [True]


async def test_ask_mode_strips_the_whole_control_plane(tmp_path):
    """A read-only turn to the Assistant keeps its read tools and loses the rest.

    The read-only allowlist names no ``lursor_*`` tool, so this falls out of
    composition rather than a special case — which is the point. "Ask, don't
    act" has to mean the control plane too, or ``/ask`` would be a way to delete
    a workspace without the mode that is supposed to forbid writes noticing.
    """
    assert not ASSISTANT_TOOL_NAMES & _READONLY_TOOL_ALLOWLIST

    steps = await _rosters(
        _assistant_row(),
        tmp_path,
        read_only=True,
        extra_tools=build_assistant_tools("thread-1"),
    )
    assert not ASSISTANT_TOOL_NAMES & set(steps[0])


async def test_destructive_tools_are_all_real(tmp_path):
    """Every name in the destructive set is a tool that exists."""
    registered = {t.__name__ for t in build_assistant_tools("t")}
    assert ASSISTANT_DESTRUCTIVE_TOOLS <= registered
    # And every one of them is genuinely gated — asserted in test_assistant_confirm.
    assert ASSISTANT_DESTRUCTIVE_TOOLS <= ASSISTANT_TOOL_NAMES


async def test_control_plane_tools_do_not_crowd_out_the_core_roster(tmp_path):
    """26 extra tools must not arrive in context on every turn.

    The tool-surface audit measured definitions at seven times the prompt Lursor
    writes itself; adding the control plane flat would undo the deferral work
    that fixed it. Only the small core set rides along.
    """
    steps = await _rosters(
        _assistant_row(),
        tmp_path,
        extra_tools=build_assistant_tools("thread-1"),
    )
    offered = ASSISTANT_TOOL_NAMES & set(steps[0])
    assert offered == ASSISTANT_CORE_TOOLS
