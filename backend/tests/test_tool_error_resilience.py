"""An unhandled tool exception must not be able to kill the turn.

pydantic-ai converts only ``ModelRetry`` and argument-validation errors into
something the model can react to. Anything else escaping a tool body is re-raised
by the default ``on_tool_execute_error`` and ends the run immediately — no retry
budget involved, first failure fatal.

That was live for every tool without its own error handling, most importantly
``web_search``: the DuckDuckGo/Tavily/Exa tools in ``pydantic_ai.common_tools``
have no ``try`` at all, so a ``RatelimitException`` from ``ddgs`` — routine, and
usually hit on the first search of a research turn — took the whole run down.

``ToolErrorsAsText`` turns those into ``"Error: ..."`` text instead. The tests
below pin the behaviour end-to-end against a real agent run, and pin the
*premise* (that without it the run dies) so this can't quietly stop mattering.
"""

from __future__ import annotations

import logging

import pytest
from pydantic_ai import Agent as PydanticAgent
from pydantic_ai.exceptions import (
    ModelRetry,
    UnexpectedModelBehavior,
    UsageLimitExceeded,
    UserError,
)
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from app.agents import builder
from app.agents.tool_errors import ToolErrorsAsText
from app.db.models import Agent

# What ddgs raises on a rate-limit, standing in for any tool that doesn't catch.
_TOOL_ERROR = RuntimeError("ratelimit: too many requests")


def _agent_calling(tool, *, capabilities=None) -> tuple[PydanticAgent, dict]:
    """An agent that calls ``tool`` once, then answers with text.

    Returns the agent and a counter dict recording how often the tool ran, so a
    test can tell "recovered" from "never called".
    """
    seen = {"calls": 0, "results": []}

    async def counted(query: str) -> str:
        seen["calls"] += 1
        return await tool(query)

    def respond(messages, info: AgentInfo):
        if seen["calls"] == 0:
            return ModelResponse(parts=[ToolCallPart("counted", {"query": "x"})])
        # Echo what came back from the tool so the test can assert the model saw it.
        for message in reversed(messages):
            for part in message.parts:
                content = getattr(part, "content", None)
                if isinstance(content, str) and content.startswith("Error:"):
                    seen["results"].append(content)
        return ModelResponse(parts=[TextPart("carried on")])

    agent = PydanticAgent(
        FunctionModel(respond),
        tools=[counted],
        capabilities=capabilities,
    )
    return agent, seen


async def _raising(_query: str) -> str:
    raise _TOOL_ERROR


async def test_unhandled_tool_error_is_fatal_without_the_capability():
    """The premise. If pydantic-ai ever starts absorbing these, this test says so."""
    agent, seen = _agent_calling(_raising)

    with pytest.raises(RuntimeError, match="ratelimit"):
        await agent.run("go")

    assert seen["calls"] == 1, "died on the first failure, no retry"


async def test_capability_turns_the_error_into_text_and_the_run_completes():
    """The fix: same tool, same exception, run finishes."""
    agent, seen = _agent_calling(_raising, capabilities=[ToolErrorsAsText()])

    result = await agent.run("go")

    assert result.output == "carried on"
    # The model was told which tool failed and why — enough to choose differently.
    assert seen["results"], "the model never saw an Error: result"
    assert "counted" in seen["results"][0]
    assert "ratelimit" in seen["results"][0]


async def test_failure_is_logged_not_just_swallowed(caplog):
    """A bug in one of our own tools must stay visible to us, not only to the agent."""
    agent, _ = _agent_calling(_raising, capabilities=[ToolErrorsAsText()])

    with caplog.at_level(logging.WARNING, logger="app.agents.tool_errors"):
        await agent.run("go")

    assert any("counted" in r.getMessage() for r in caplog.records)
    # The traceback is what makes it diagnosable after the fact.
    assert any(r.exc_info for r in caplog.records)


async def test_model_retry_still_reaches_the_retry_budget():
    """The net is scoped to real exceptions — ``ModelRetry`` semantics are untouched.

    A tool that raises ``ModelRetry`` must still be retried and still terminate on
    an exhausted budget, otherwise the capability would have quietly disabled
    retries everywhere. ``retries=1`` keeps it short.
    """
    calls = {"n": 0}

    async def always_retry(query: str) -> str:
        calls["n"] += 1
        raise ModelRetry("try again")

    def respond(messages, info: AgentInfo):
        return ModelResponse(parts=[ToolCallPart("always_retry", {"query": "x"})])

    agent = PydanticAgent(
        FunctionModel(respond),
        tools=[always_retry],
        retries=1,
        capabilities=[ToolErrorsAsText()],
    )

    with pytest.raises(UnexpectedModelBehavior, match="exceeded max retries"):
        await agent.run("go")

    assert calls["n"] > 1, "ModelRetry was absorbed instead of retried"


async def test_framework_terminal_errors_stay_fatal():
    """A tool raising an ``AgentRunError`` must not be absorbed.

    This is the trap the capability fell into on the first draft: an exhausted
    retry budget raises ``UnexpectedModelBehavior`` from *inside* the tool
    execution path, so a blanket ``except Exception`` net catches it and the run
    stops being able to terminate — the model just re-calls the failing tool until
    it exhausts its round budget. ``UsageLimitExceeded`` behaves the same way, and
    stands in for the family here.
    """

    async def limit_exceeded(query: str) -> str:
        raise UsageLimitExceeded("request_limit exceeded")

    def respond(messages, info: AgentInfo):
        return ModelResponse(parts=[ToolCallPart("limit_exceeded", {"query": "x"})])

    agent = PydanticAgent(
        FunctionModel(respond),
        tools=[limit_exceeded],
        capabilities=[ToolErrorsAsText()],
    )

    with pytest.raises(UsageLimitExceeded):
        await agent.run("go")


async def test_user_error_stays_fatal():
    """Misconfiguration needs a human, not a line of transcript."""

    async def misconfigured(query: str) -> str:
        raise UserError("capability is configured wrong")

    def respond(messages, info: AgentInfo):
        return ModelResponse(parts=[ToolCallPart("misconfigured", {"query": "x"})])

    agent = PydanticAgent(
        FunctionModel(respond),
        tools=[misconfigured],
        capabilities=[ToolErrorsAsText()],
    )

    with pytest.raises(UserError, match="configured wrong"):
        await agent.run("go")


def test_builder_installs_the_net_first(monkeypatch, tmp_path):
    """Ordering is load-bearing: error hooks are consulted in reverse, so the
    fallback has to be registered first to be asked last."""
    seen: dict = {}

    def fake_create_deep_agent(**kwargs):
        seen.update(kwargs)
        return object()

    monkeypatch.setattr(builder, "create_deep_agent", fake_create_deep_agent)
    builder.build_deep_agent(Agent(name="A"), str(tmp_path), {}, [], {})

    capabilities = seen["capabilities"] or []
    assert isinstance(capabilities[0], ToolErrorsAsText)


def test_builder_keeps_it_first_ahead_of_escape_hatch_capabilities(monkeypatch, tmp_path):
    """Capabilities supplied through ``extra_config`` still get first refusal."""
    seen: dict = {}

    def fake_create_deep_agent(**kwargs):
        seen.update(kwargs)
        return object()

    monkeypatch.setattr(builder, "create_deep_agent", fake_create_deep_agent)
    row = Agent(name="A", extra_config={"capabilities": [ToolErrorsAsText()]})
    builder.build_deep_agent(row, str(tmp_path), {}, [], {})

    capabilities = seen["capabilities"] or []
    assert isinstance(capabilities[0], ToolErrorsAsText)
    assert len(capabilities) >= 2
