"""Last-resort net so an unhandled tool exception can't kill the turn.

pydantic-ai converts only ``ModelRetry`` and argument-validation errors into
something the model can react to. Any *other* exception escaping a tool body is
re-raised (``AbstractCapability.on_tool_execute_error`` defaults to ``raise
error``) and takes the whole agent run down with it — not after a retry budget,
immediately, on the first failure.

Most tools in this stack already return ``f"Error: ..."`` text instead of raising
(the whole ``pydantic_ai_backends`` console toolset, pydantic-deep's memory / plan
/ skills / teams / browser toolsets, and our own ``view_image`` and browser-QA
tools), so they were never exposed to this. The gap is the tools that don't:

- ``web_search`` — the DuckDuckGo, Tavily, and Exa tools in
  ``pydantic_ai.common_tools`` have no error handling at all, so a routine
  ``RatelimitException`` from ``ddgs`` ends the run. Search is typically the
  *first* thing a research turn does, which makes the zero-tolerance tool the one
  most likely to fail.
- anything added later that raises — HTTP/MCP tools especially, once the ``mcp``
  tool kind in ``db.models`` is wired into execution.

Rather than wrap each of those, we handle the failure once at the layer that
already exists for it: return the exception to the model as text, so it can pick
another approach, and log it so a genuine bug in one of our own tools is still
visible to us rather than only to the agent.

Scope is deliberately narrow. This hook fires only for exceptions raised by tool
*execution*: pydantic-ai excludes control flow (``SkipToolExecution``,
``CallDeferred``, ``ApprovalRequired``, ``ToolRetryError``) and ``ModelRetry``
before calling it, and errors from the ``before_tool_execute`` /
``after_tool_execute`` hooks never route here at all — so a ``StuckLoopError``
still aborts the run, as intended. ``asyncio.CancelledError`` is a
``BaseException``, not an ``Exception``, so stopping a run is unaffected.

Environmental failures that arrive as ``ModelRetry`` are a different problem with
a different fix — see ``agents/web_fetch.py``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from pydantic_ai.capabilities import AbstractCapability, ValidatedToolArgs
from pydantic_ai.exceptions import AgentRunError, UserError
from pydantic_ai.messages import ToolCallPart
from pydantic_ai.tools import RunContext, ToolDefinition

logger = logging.getLogger(__name__)

# Framework-level failures that must stay fatal, even though they reach this hook
# the same way a tool's own exception does.
#
# `AgentRunError` covers the run's own terminal signals — including
# `UnexpectedModelBehavior`, which is what an exhausted retry budget raises *from
# inside the tool-execution path*. Absorbing that one is not a smaller version of
# the bug we're fixing, it's a worse one: the run stops terminating. The model
# re-calls the failing tool, gets text back, calls it again, and the turn only
# ends when it runs out of the 150 model rounds. (`UsageLimitExceeded` and
# `ModelHTTPError` are the same family — a nested agent's model failing inside a
# `task` call stays fatal, exactly as it was before this capability existed.)
#
# `UserError` is misconfiguration (an unsupported native tool, a bad capability
# argument). It needs a human, not a retry: reporting it to the model as text
# would bury a deployment fault in a transcript.
_FATAL = (AgentRunError, UserError)


@dataclass
class ToolErrorsAsText(AbstractCapability[Any]):
    """Return unhandled tool exceptions to the model as ``"Error: ..."`` text.

    Install *first* in the capability list. ``CombinedCapability`` consults
    ``on_tool_execute_error`` in reverse order and stops at the first capability
    that returns a value, so the earliest-registered one is asked last — which is
    what a fallback wants: any capability with a considered opinion about a tool
    failure gets to act on it before this blanket net does.
    """

    async def on_tool_execute_error(
        self,
        ctx: RunContext[Any],
        *,
        call: ToolCallPart,
        tool_def: ToolDefinition,
        args: ValidatedToolArgs,
        error: Exception,
    ) -> Any:
        if isinstance(error, _FATAL):
            raise error

        # `exc_info` so our own bugs stay diagnosable: the agent sees a one-line
        # summary, the logs keep the traceback.
        logger.warning(
            "tool %r raised %s; returning it to the model as text: %s",
            call.tool_name,
            type(error).__name__,
            error,
            exc_info=error,
        )
        return f"Error: {call.tool_name} failed: {error}"
