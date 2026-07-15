"""Resolve the app-wide web-search provider into a Pydantic AI capability.

The per-agent ``web_search`` flag only decides *whether* an agent may search the
web; *which* backend it uses is an app-wide choice (``AppConfig.web_search_provider``),
mirroring how the OpenRouter key is configured once for the whole app.

Providers:

- ``native``     — the model's own web search only, no local fallback. Raises at
                   run time on models without native support, so it's opt-in for
                   deployments whose models all expose a native web tool.
- ``duckduckgo`` — the model's native search when it supports one, otherwise a
                   local DuckDuckGo fallback. The default; needs no API key. This
                   is the historical behaviour.
- ``tavily``     — native when supported, otherwise Tavily (needs an API key).
- ``exa``        — native when supported, otherwise Exa (needs an API key).

Tavily and Exa each require an optional dependency (``tavily-python`` / ``exa-py``)
and an API key. If either is missing we log a warning and fall back to DuckDuckGo
so a misconfigured provider degrades gracefully instead of hard-failing a run.
"""

from __future__ import annotations

import logging

from pydantic_ai.capabilities import WebSearch

logger = logging.getLogger(__name__)

# The provider used when nothing is configured — matches the pre-existing
# behaviour (``WebSearch(local="duckduckgo")``), so existing agents are unchanged.
DEFAULT_WEB_SEARCH_PROVIDER = "duckduckgo"

# Every provider the UI may select. Kept in sync with the frontend
# ``WebSearchProvider`` union and the ``WebSearchProvider`` schema literal.
WEB_SEARCH_PROVIDERS = ("native", "duckduckgo", "tavily", "exa")


def build_web_search_capability(
    provider: str | None,
    *,
    tavily_api_key: str | None = None,
    exa_api_key: str | None = None,
) -> WebSearch:
    """Build the ``WebSearch`` capability for the configured ``provider``.

    ``WebSearch`` prefers the model's native web tool and uses the ``local=``
    fallback only when the model has none — so ``tavily``/``exa``/``duckduckgo``
    all keep native search where available and differ only in the fallback.
    ``native`` disables the fallback entirely. Unknown values fall back to
    DuckDuckGo.
    """
    name = (provider or DEFAULT_WEB_SEARCH_PROVIDER).strip().lower()

    if name == "native":
        # Native only — no local fallback. Errors on models without a native
        # web tool, which is the point of opting into this provider.
        return WebSearch(local=False)

    if name == "tavily":
        tool = _tavily_tool(tavily_api_key)
        if tool is not None:
            return WebSearch(local=tool)
        return WebSearch(local="duckduckgo")

    if name == "exa":
        tool = _exa_tool(exa_api_key)
        if tool is not None:
            return WebSearch(local=tool)
        return WebSearch(local="duckduckgo")

    # duckduckgo (the default) and any unrecognized value.
    return WebSearch(local="duckduckgo")


def _tavily_tool(api_key: str | None):
    """The Tavily search tool, or ``None`` (with a warning) if unusable."""
    if not api_key:
        logger.warning(
            "web search: provider 'tavily' selected but no API key is set; "
            "falling back to DuckDuckGo"
        )
        return None
    try:
        from pydantic_ai.common_tools.tavily import tavily_search_tool
    except ImportError:
        logger.warning(
            "web search: 'tavily-python' is not installed; falling back to DuckDuckGo"
        )
        return None
    return tavily_search_tool(api_key=api_key)


def _exa_tool(api_key: str | None):
    """The Exa search tool, or ``None`` (with a warning) if unusable."""
    if not api_key:
        logger.warning(
            "web search: provider 'exa' selected but no API key is set; "
            "falling back to DuckDuckGo"
        )
        return None
    try:
        from pydantic_ai.common_tools.exa import exa_search_tool
    except ImportError:
        logger.warning(
            "web search: 'exa-py' is not installed; falling back to DuckDuckGo"
        )
        return None
    return exa_search_tool(api_key=api_key)
