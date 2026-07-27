"""A failed web fetch must not be able to kill the turn.

The library's local web-fetch tool raises ``ModelRetry`` for *environmental*
failures — dead host, HTTP error, timeout, blocked URL — which draws on the
agent's per-tool retry budget. Exhausting that budget raises
``UnexpectedModelBehavior`` and aborts the whole run, so an agent that hit four
unreachable URLs in a row lost its turn ("Tool 'web_fetch' exceeded max retries
count of 3") over facts about the internet rather than any mistake of its own.

``agents/web_fetch.py`` returns those failures to the model as ``"Error: ..."``
text instead. The two properties that matter, pinned here:

- a failing fetch returns rather than raises (so no retry budget is spent, and
  four in a row can't be fatal)
- the tool still looks *exactly* like the library's to the model and to the
  read-only/plan-mode tool filters, which allowlist it by the name ``web_fetch``

Both cases below fail before the request leaves the machine (SSRF guard, bad
scheme), so the test needs no network.
"""

from __future__ import annotations

import pytest
from pydantic_ai.capabilities import WebFetch
from pydantic_ai.common_tools.web_fetch import web_fetch_tool
from pydantic_ai.exceptions import ModelRetry

from app.agents import builder
from app.agents.builder import _TOOL_RETRIES, build_deep_agent
from app.agents.web_fetch import build_web_fetch_capability
from app.db.models import Agent

# Blocked by the SSRF guard, and a URL with no scheme: the two shapes of
# `ModelRetry` the library raises (transport/policy failure, unusable argument).
_FAILING_URLS = ["http://127.0.0.1:9/", "not-a-url"]


def _local_tool():
    """The wrapped local fetch tool from the capability we install."""
    return build_web_fetch_capability().local


@pytest.mark.parametrize("url", _FAILING_URLS)
async def test_failed_fetch_returns_error_text_instead_of_raising(url):
    """The whole point: no exception, so no retry budget is consumed."""
    result = await _local_tool().function(url)

    assert isinstance(result, str)
    assert result.startswith("Error:")
    # The reason has to survive — an opaque failure leaves the model unable to
    # decide whether to try another URL or move on.
    assert url in result


@pytest.mark.parametrize("url", _FAILING_URLS)
async def test_library_tool_would_have_raised(url):
    """Guards the premise. If the library stops raising ``ModelRetry`` here, the
    wrapper is obsolete rather than subtly wrong, and this test says so."""
    with pytest.raises(ModelRetry):
        await web_fetch_tool().function(url)


async def test_repeated_failures_never_exhaust_the_retry_budget():
    """More consecutive failures than the budget allows, still no exception.

    This is the regression in miniature: with the raising tool, attempt
    ``_TOOL_RETRIES + 1`` is what aborts the run.
    """
    fetch = _local_tool().function

    for _ in range(_TOOL_RETRIES + 2):
        assert (await fetch("http://127.0.0.1:9/")).startswith("Error:")


def test_tool_is_indistinguishable_from_the_library_tool():
    """Same name and same argument schema — only the failure contract differs."""
    ours, library = _local_tool(), web_fetch_tool()

    # The tool filters in builder.py allowlist by this exact name.
    assert ours.name == library.name == "web_fetch"
    assert ours.function_schema.json_schema == library.function_schema.json_schema
    assert not ours.takes_ctx
    # The model is told what an "Error:" return means, else it just refetches.
    assert library.description in (ours.description or "")
    assert "Error:" in (ours.description or "")


def test_native_fetch_still_wins_where_supported():
    """We replace the *local* fallback only.

    ``WebFetch`` keeps its native tool, so on models with a provider-side fetch
    the native one is used and the local fallback is suppressed — same behaviour
    as the library's ``WebFetch(local=True)``.
    """
    capability = build_web_fetch_capability()

    assert capability.native is not False
    assert capability.get_native_tools()
    assert capability.get_toolset() is not None


# --- Builder wiring -----------------------------------------------------------


def _captured_kwargs(monkeypatch, row: Agent, workspace) -> dict:
    """Build an agent with ``create_deep_agent`` stubbed, returning its kwargs."""
    seen: dict = {}

    def fake_create_deep_agent(**kwargs):
        seen.update(kwargs)
        return object()

    monkeypatch.setattr(builder, "create_deep_agent", fake_create_deep_agent)
    build_deep_agent(row, str(workspace), {}, [], {})
    return seen


def test_builder_installs_our_fetch_and_suppresses_the_library_one(monkeypatch, tmp_path):
    """Ours replaces the library's — registered once, not twice."""
    kwargs = _captured_kwargs(monkeypatch, Agent(name="A"), tmp_path)

    assert kwargs["web_fetch"] is False, "library tool would double-register"
    assert any(isinstance(c, WebFetch) for c in kwargs["capabilities"] or [])
    assert kwargs["retries"] == _TOOL_RETRIES == 5


def test_extra_config_still_wins(monkeypatch, tmp_path):
    """Both knobs stay overridable per agent through the escape hatch.

    Also guards against passing either keyword twice, which would be a
    ``TypeError`` at build time.
    """
    row = Agent(name="A", extra_config={"retries": 2, "web_fetch": True})
    kwargs = _captured_kwargs(monkeypatch, row, tmp_path)

    assert kwargs["retries"] == 2
    assert kwargs["web_fetch"] is True
    # Asked for the library's tool: ours must stay out of the way entirely.
    assert not any(isinstance(c, WebFetch) for c in kwargs["capabilities"] or [])
