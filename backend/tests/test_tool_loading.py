"""What the model is actually offered: the read-only surface and on-demand loading.

Two halves, both driven by real ``build_deep_agent`` runs through a
``FunctionModel`` so they assert on the tool definitions that reach the wire
rather than on what the builder source implies.

The model profile matters here and is deliberately pinned per test. Every Lursor
model resolves to ``OpenAIChatModel`` / ``TolerantOpenAIChatModel``, and whether a
*local* ``web_fetch`` / ``duckduckgo_search`` function tool exists at all depends on
whether that model's profile advertises the matching native tool: on the cloud path
the native tool wins and the local one is dropped from the wire, on a ``custom:``
(laios) model there is no native support and the local tool is what the model sees.
``_NO_NATIVE`` stands in for the latter — the case the read-only allowlist governs.
"""

from __future__ import annotations

import pytest
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.profiles import ModelProfile

from app.agents import hindsight as hs
from app.agents import tool_loading
from app.agents.builder import _READONLY_TOOL_ALLOWLIST, build_deep_agent
from app.db.models import Agent as AgentRow

# DB / workspace isolation lives in ``conftest.py``.

# A model with no provider-native tools — every `custom:`/laios model (verified via
# `openai_chat_supports_web_search`), and the only case in which the local web tools
# are function tools the read-only filter can see.
_NO_NATIVE = ModelProfile(supported_native_tools=frozenset())

# Every per-agent tool switch on.
_ALL_ON = {
    "include_subagents": True,
    "include_todo": True,
    "include_skills": True,
    "include_memory": True,
    "include_plan": True,
    "web_search": True,
}


def _row(**flags) -> AgentRow:
    row = AgentRow(name="auditor", instructions="hi")
    for key, value in flags.items():
        setattr(row, key, value)
    return row


async def _rosters(
    row: AgentRow,
    workspace,
    *,
    profile: ModelProfile | None = _NO_NATIVE,
    search: str | None = None,
    **kwargs,
) -> list[list[str]]:
    """Tool names offered on each step of a real run.

    With ``search``, the model calls ``search_tools`` with that query on the opening
    step, so the second entry shows what discovery revealed.
    """
    steps: list[list[str]] = []

    def respond(_messages, info: AgentInfo):
        steps.append([t.name for t in info.function_tools])
        if search is not None and len(steps) == 1:
            return ModelResponse(parts=[ToolCallPart("search_tools", {"queries": [search]})])
        return ModelResponse(parts=[TextPart("ok")])

    agent, deps = build_deep_agent(row, str(workspace), **kwargs)
    with agent.override(model=FunctionModel(respond, profile=profile)):
        await agent.run("hi", deps=deps)
    return steps


# --- read-only web access ----------------------------------------------------


@pytest.mark.parametrize(
    ("provider", "expected", "extra"),
    [
        (None, "duckduckgo_search", {}),
        ("tavily", "tavily_search", {"tavily_api_key": "test-key"}),
        ("exa", "exa_search", {"exa_api_key": "test-key"}),
    ],
)
async def test_ask_mode_keeps_the_local_web_search_tool(tmp_path, provider, expected, extra):
    """An /ask turn with web search must survive, and be able to search.

    The allowlist used to list ``"web_search"``, a name no tool ever carries. On a
    model without native web search that stripped the local fallback and left the
    native tool with nothing to fall back to, so pydantic-ai raised
    ``UserError: Native tool(s) ['WebSearchTool'] not supported by this model``
    *before the request* — the whole /ask turn lost, not a degraded one. With
    tavily/exa (forced local, no native tool) there was no error and no search
    either: silently no web access.
    """
    steps = await _rosters(
        _row(**_ALL_ON),
        tmp_path,
        read_only=True,
        web_search_provider=provider,
        **extra,
    )

    assert expected in steps[0]
    # Reading a page is part of the read-only surface too.
    assert "web_fetch" in steps[0]
    # And the guarantee still holds: no write, exec or delegate path.
    assert not {"write_file", "hashline_edit", "execute", "task"} & set(steps[0])


async def test_readonly_allowlist_has_no_dead_entries(tmp_path, monkeypatch):
    """Every allowlisted name must be a tool some build really registers.

    The existing read-only test asserts the roster is a *subset* of the allowlist,
    which a misspelled or stale entry passes silently — that is how ``"web_search"``
    survived. This asserts the other direction.
    """
    import app.agents.builder as builder

    # Enumerate the flat universe: a deferred tool is withheld from the wire, so
    # deferral would hide most of the roster from this census.
    monkeypatch.setattr(builder.settings, "tool_search_enabled", False)
    registered: set[str] = set()
    # Web providers each contribute a differently-named local search tool.
    for provider, keys in (
        (None, {}),
        ("tavily", {"tavily_api_key": "k"}),
        ("exa", {"exa_api_key": "k"}),
    ):
        steps = await _rosters(_row(**_ALL_ON), tmp_path, web_search_provider=provider, **keys)
        registered |= set(steps[0])
    # Hindsight's tools only exist on that memory provider; their names are pinned
    # against the real toolset in test_hindsight_memory.
    registered |= {hs.RETAIN_TOOL, hs.RECALL_TOOL, hs.REFLECT_TOOL}
    # `search_tools` is emitted by the tool-search wrapper only when something is
    # deferred; covered by the deferral tests below.
    registered |= {"search_tools"}

    assert not _READONLY_TOOL_ALLOWLIST - registered


# --- on-demand tool loading --------------------------------------------------


async def test_full_build_defers_non_core_tools(tmp_path):
    """A fully-loaded agent leads with the core loop, not all 51 tools."""
    steps = await _rosters(_row(**_ALL_ON), tmp_path, workspace_id="ws1")
    offered = set(steps[0])

    # Discovery is available, and the tools needed in most turns are not behind it.
    assert "search_tools" in offered
    assert {"ls", "read_file", "grep", "glob", "write_file", "execute"} <= offered
    # Named by DEV_SERVER_DIRECTIVE / the skills + memory directives, so never hidden.
    assert {"run_in_background", "list_shells", "list_skills", "load_skill"} <= offered
    # The long tail is hidden: delegation, the browser, monitors, conversation utils.
    assert not {"task", "open_app", "view_app", "start_monitor"} & offered
    assert not {"search_conversation_history", "compact_conversation"} & offered
    # Meaningfully smaller than the flat roster it replaces.
    assert len(offered) < 30


async def test_search_tools_reveals_a_deferred_group(tmp_path):
    """One search loads the whole capability the agent asked about."""
    steps = await _rosters(
        _row(**_ALL_ON),
        tmp_path,
        workspace_id="ws1",
        search="browser app console network errors",
    )
    revealed = set(steps[1]) - set(steps[0])

    assert {"open_app", "view_app", "get_console_logs", "get_network_errors"} <= revealed
    # Revealed tools stay callable alongside the core ones.
    assert {"ls", "read_file", "search_tools"} <= set(steps[1])


async def test_a_discovered_task_tool_is_still_pinned_to_the_roster(tmp_path):
    """Deferring ``task`` must not cost the roster guarantee it is wrapped in.

    ``_task_tool_roster_filter`` rewrites ``task``'s description and injects a
    ``subagent_type`` enum so the model cannot delegate to a subagent that does not
    exist. It runs per step, so it has to catch a ``task`` the model reveals
    mid-turn — otherwise deferral would quietly hand back the bad-delegation bug.
    """
    steps: list[dict] = []

    def respond(_messages, info: AgentInfo):
        steps.append({t.name: t for t in info.function_tools})
        if len(steps) == 1:
            return ModelResponse(
                parts=[ToolCallPart("search_tools", {"queries": ["task subagent delegate"]})]
            )
        return ModelResponse(parts=[TextPart("ok")])

    agent, deps = build_deep_agent(_row(**_ALL_ON), str(tmp_path), workspace_id="ws1")
    with agent.override(model=FunctionModel(respond, profile=_NO_NATIVE)):
        await agent.run("hi", deps=deps)

    assert "task" not in steps[0], "task should start deferred"
    task = steps[1]["task"]
    subagent_type = task.parameters_json_schema["properties"]["subagent_type"]
    assert subagent_type["enum"] == ["general-purpose", "research", "planner"]
    assert "Do not invent a subagent type" in (task.description or "")


async def test_small_rosters_are_left_flat(tmp_path):
    """Below the threshold nothing is deferred and no search tool is registered.

    Hiding a handful of tools does not pay for the discovery round trip, and this is
    what keeps /ask (mostly core tools) on a flat roster without special-casing it.
    """
    row = _row(
        include_subagents=False,
        include_todo=False,
        include_skills=False,
        include_memory=False,
        web_search=False,
    )
    offered = set((await _rosters(row, tmp_path))[0])

    assert "search_tools" not in offered
    assert {"ls", "read_file", "write_file", "execute"} <= offered


async def test_tool_search_can_be_turned_off(tmp_path, monkeypatch):
    """The kill switch restores the full flat roster."""
    import app.agents.builder as builder

    monkeypatch.setattr(builder.settings, "tool_search_enabled", False)
    offered = set((await _rosters(_row(**_ALL_ON), tmp_path, workspace_id="ws1"))[0])

    assert "search_tools" not in offered
    # Everything the deferral test found hidden is offered up front again.
    assert {"task", "open_app", "view_app", "start_monitor"} <= offered


async def test_discovered_tools_are_still_vetted_in_ask_mode(tmp_path, monkeypatch):
    """Discovery cannot smuggle a write tool into the read-only surface.

    /ask normally stays under the deferral threshold, so force it on: what matters
    is that the read-only allowlist runs *per step* and therefore vets tools the
    model reveals mid-turn, rather than only the opening roster.
    """
    monkeypatch.setattr(tool_loading, "_MIN_DEFERRABLE", 1)
    steps = await _rosters(
        _row(**_ALL_ON),
        tmp_path,
        read_only=True,
        search="write file edit execute shell delegate subagent",
    )

    # The search tool itself must survive the allowlist, or the deferred tools would
    # be unreachable for the rest of the turn.
    assert "search_tools" in steps[0]
    for offered in steps:
        assert not {
            "write_file",
            "hashline_edit",
            "execute",
            "run_in_background",
            "run_skill_script",
            "task",
        } & set(offered)
        assert set(offered) <= _READONLY_TOOL_ALLOWLIST
