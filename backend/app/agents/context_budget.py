"""Per-agent overrides for *in-run* context compaction.

pydantic-deep gives every agent a ``ContextManagerCapability``: it counts the
tokens in the message history before each model request and, once the history
passes a fraction of the model's token budget, replaces the oldest part of it
with an LLM-written summary. Two numbers govern that, and the library hard-codes
both — it compresses at **90%** of the budget and keeps **nothing** verbatim
(``keep=("messages", 0)``), and ``create_deep_agent`` exposes no passthrough for
either (only ``context_manager_max_tokens``).

This module makes those two the app's defaults (``settings.default_compaction_*``)
and lets an :class:`~app.db.models.Agent` or :class:`~app.db.models.Subagent` row
override them for its own runs:

* ``compaction_threshold`` — how full the window gets before compaction fires.
  Lower it for a model whose quality falls off well before its stated limit.
* ``compaction_ratio`` — how much of the history is folded into the summary.
  ``1.0`` summarizes all of it (the library's behaviour); ``0.7`` summarizes the
  oldest share and leaves the newest 30% of the budget's worth of messages
  verbatim, which matters when recent tool output must survive intact.

Both are applied by mutating the capability the library already built (see
:func:`apply_compaction_settings`) rather than by building our own, so the agent
keeps the pieces that come with it: the limit warner, the ``compact_conversation``
tool, and the history-archive search toolset.

The manual ``/compact`` slash command is a different mechanism over the same two
knobs — it condenses the stored *transcript* rather than a live run's history.
``compaction_ratio`` governs it too; see :mod:`app.agents.compaction`.
"""

from __future__ import annotations

import logging

from pydantic_ai import Agent as PydanticAgent
from pydantic_ai_summarization import ContextManagerCapability, SummarizationProcessor
from pydantic_ai_summarization.types import ContextSize

from app.config import get_settings
from app.db.models import Agent as AgentRow
from app.db.models import Subagent as SubagentRow

logger = logging.getLogger(__name__)

settings = get_settings()


def _fraction(value: float | None, default: float) -> float:
    """``value`` when it is a usable fraction in (0, 1], else ``default``.

    Both knobs arrive from the database, where a row predating the column (NULL)
    or one written by an older client can hold anything. The API validates the
    range on the way in; this is the second line of defence, since an out-of-range
    ``compress_threshold`` makes the capability raise on construction and would
    take down every run of that agent.
    """
    if value is None:
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not 0 < number <= 1:
        return default
    return number


def resolve_compaction_threshold(row: AgentRow | SubagentRow) -> float:
    """The fraction of the context window at which ``row`` compacts."""
    return _fraction(
        getattr(row, "compaction_threshold", None), settings.default_compaction_threshold
    )


def resolve_compaction_ratio(row: AgentRow | SubagentRow) -> float:
    """The fraction of ``row``'s history that compaction folds into the summary."""
    return _fraction(
        getattr(row, "compaction_ratio", None), settings.default_compaction_ratio
    )


def keep_for_ratio(ratio: float) -> ContextSize:
    """Turn a compact-this-much ratio into the library's ``keep`` setting.

    ``keep`` says what survives compaction, so it is the complement of the ratio.
    A ratio of 1.0 is spelled ``("messages", 0)`` rather than ``("fraction", 0.0)``
    because that is the library's own "summarize everything" spelling — the
    fraction form would leave the last message behind instead.
    """
    if ratio >= 1:
        return ("messages", 0)
    return ("fraction", round(1 - ratio, 4))


def apply_compaction_settings(agent: PydanticAgent, row: AgentRow | SubagentRow) -> None:
    """Retune the agent's context manager to ``row``'s compaction settings.

    ``create_deep_agent`` builds the capability itself and only hands it back on
    ``agent._context_middleware`` (the handle its CLI uses for ``/compact``), so
    this reaches through to it: set the two fields, then rebuild the summarization
    processor, which is constructed from them in ``__post_init__`` and would
    otherwise keep enforcing the values the capability was created with.

    Best-effort by design. Compaction is a safety net, not the run itself, so a
    library upgrade that renames these internals must degrade to "runs on the
    library defaults, with a warning" rather than break every run.
    """
    threshold = resolve_compaction_threshold(row)
    ratio = resolve_compaction_ratio(row)
    capability = getattr(agent, "_context_middleware", None)
    if not isinstance(capability, ContextManagerCapability):
        logger.warning(
            "compaction: no context manager on agent %r — leaving compaction at the "
            "library defaults (threshold=%.2f, ratio=%.2f requested)",
            getattr(row, "name", "?"),
            threshold,
            ratio,
        )
        return

    keep = keep_for_ratio(ratio)
    try:
        capability.compress_threshold = threshold
        capability.keep = keep
        # ``_resolved_max_tokens`` is the budget the capability settled on (an
        # explicit ``max_tokens``, else the model's window via genai-prices, else
        # 200k). Reuse it as-is: this changes *when* and *how much* we compact,
        # never the size of the window we compact against.
        capability._summarization_processor = SummarizationProcessor(
            trigger=("fraction", threshold),
            keep=keep,
            model=capability.summarization_model,
            token_counter=capability.token_counter,
            summary_prompt=capability.summary_prompt,
            max_input_tokens=capability._resolved_max_tokens,
        )
    except Exception as exc:  # noqa: BLE001 — never let tuning break a run
        logger.warning(
            "compaction: could not apply threshold=%.2f ratio=%.2f to agent %r: %s",
            threshold,
            ratio,
            getattr(row, "name", "?"),
            exc,
        )
