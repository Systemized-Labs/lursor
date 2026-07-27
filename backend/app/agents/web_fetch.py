"""A ``web_fetch`` tool whose failures don't kill the turn.

The library's local web-fetch tool raises ``ModelRetry`` for every failure mode,
including ones the model can do nothing about: a 404, a DNS failure, a timeout,
an SSRF/domain-policy rejection (``pydantic_ai.common_tools.web_fetch``, which
funnels ``ValueError``/``httpx`` errors into ``ModelRetry``). ``ModelRetry`` draws
on the agent's per-tool retry budget, and exhausting that budget raises
``UnexpectedModelBehavior``, which aborts the whole agent run.

That is the wrong outcome for a dead link. An agent researching across several
sources can hit four unreachable URLs in a row without doing anything wrong, and
a run that dies on "Tool 'web_fetch' exceeded max retries count of N" loses the
turn over a fact about the internet. Raising the retry count only moves the wall.

So we do here what ``view_image`` does in ``vision.py``: return the failure to the
model as an ``"Error: ..."`` string. The model still learns exactly what went
wrong — and can pick a different URL, or give up on that source and carry on —
but it costs an ordinary model round instead of retry budget, and can never be
fatal. Argument-schema errors (a missing or non-string ``url``) are unaffected:
those are raised by pydantic-ai before the tool body runs, so the retry budget
still covers a model that cannot form the call at all.

Only the *local* tool is replaced. On models with a provider-native fetch tool
the native one still wins (``NativeOrLocalTool`` suppresses the local fallback),
exactly as with the library default.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic_ai.capabilities import WebFetch
from pydantic_ai.exceptions import ModelRetry
from pydantic_ai.tools import Tool

logger = logging.getLogger(__name__)

# Appended to the library tool's own description. Without this the model sees an
# "Error: ..." return and often just refetches the same dead URL; naming the
# convention up front is what turns a failure into a decision.
_ERROR_CONTRACT = (
    " If the fetch fails (unreachable host, HTTP error, timeout, blocked URL) "
    "the result is a string starting with 'Error:' rather than page content. "
    "Read it, then try a different URL or approach — refetching the same URL "
    "will fail the same way."
)


def build_web_fetch_capability() -> WebFetch:
    """The ``WebFetch`` capability with a non-fatal local fallback.

    Mirrors the library's ``WebFetch(local=True)`` — native fetch where the model
    supports one, local otherwise — with the local tool wrapped so environmental
    failures come back as text instead of consuming retry budget.
    """
    return WebFetch(local=_resilient_local_tool())


def _resilient_local_tool() -> Tool[Any]:
    """Wrap the library's local web-fetch tool so it never raises ``ModelRetry``.

    Built by delegating to the public ``web_fetch_tool()`` factory rather than
    reimplementing the fetch: SSRF protection, the markdown ``Accept`` handling,
    binary passthrough, and content truncation stay exactly as the library does
    them, and keep tracking it across upgrades.
    """
    # Imported lazily: this pulls in `markdownify` (the `web-fetch` optional
    # group), and the import cost belongs on first agent build, not on ours.
    from pydantic_ai.common_tools.web_fetch import web_fetch_tool

    library_tool = web_fetch_tool()
    fetch = library_tool.function

    async def web_fetch(url: str) -> Any:
        """Fetch a web page and return its content as markdown.

        Args:
            url: The URL to fetch.
        """
        try:
            return await fetch(url)
        except ModelRetry as exc:
            # Not a model mistake to correct — a fact about the URL. Hand it back
            # as content so the run continues.
            logger.info("web_fetch failed for %s: %s", url, exc.message)
            return f"Error: {exc.message}"

    return Tool[Any](
        web_fetch,
        # The name is load-bearing: the read-only and plan-mode tool filters in
        # ``builder.py`` allowlist "web_fetch" by name.
        name=library_tool.name,
        description=(library_tool.description or "") + _ERROR_CONTRACT,
    )
