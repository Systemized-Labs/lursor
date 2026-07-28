"""Condense a conversation transcript into a single carry-forward summary.

Powers the ``/compact`` slash command: when a thread grows long, a one-shot
:class:`pydantic_ai.Agent` reads the transcript and writes a dense summary that
replaces it as the thread's context, so later turns cost a fraction of the tokens
while keeping what matters. It reuses :func:`app.agents.builder.resolve_model`, so
summarization runs on the same OpenRouter / custom-provider plumbing as chat.

The output is stored as a ``kind="summary"`` assistant message and shown in the
UI as a distinct "conversation summarized" card; the messages it subsumes are
marked ``compacted`` (hidden, not deleted). See ``api/chat.py`` for the endpoint.

How much of the transcript gets condensed is the thread agent's
``compaction_ratio`` (:func:`split_for_compaction`) — the same knob that governs
the in-run compaction pydantic-deep does on its own; see
``agents/context_budget.py``.
"""

from __future__ import annotations

from collections.abc import Sequence

from pydantic_ai import Agent as PydanticAgent

from app.agents.builder import resolve_model
from app.config import get_settings
from app.db.models import CustomProvider, Message

settings = get_settings()

# The smallest number of messages worth condensing: a single message (or an
# existing lone summary) already *is* the compact form, so a split that would
# leave fewer than this to summarize condenses nothing at all.
_MIN_MESSAGES_TO_COMPACT = 2

# Flat per-message cost added when weighting the transcript for the ratio split
# below, in characters. Every turn carries overhead the body doesn't show (role
# label, tool-call names), so weighting purely by content length would treat a
# run of one-line turns as free and hand almost the whole transcript to the
# "kept" tail.
_MESSAGE_WEIGHT_FLOOR = 100

# Per-message character cap when rendering the transcript, so one runaway tool
# dump or pasted blob can't blow past the summarizer's context window. The point
# of compaction is a lossy digest, so truncating the longest turns is acceptable.
_MAX_MESSAGE_CHARS = 4000

COMPACTION_SYSTEM = """\
You are a context-compression engine. You are given the transcript of a \
conversation between a user and an AI coding agent. Write a dense summary that \
lets the agent continue the conversation seamlessly without seeing the original \
messages.

Capture, in this order and using short markdown headings:
- **Task & intent** — what the user is trying to accomplish, in their own framing.
- **Decisions & constraints** — choices already made, preferences stated, and \
requirements or constraints that must keep holding.
- **Work done** — files created or changed, commands run, and key findings, with \
concrete names (paths, functions, identifiers) preserved verbatim.
- **Current state** — what is working, what is broken or unverified, and any open \
questions.
- **Next steps** — what remains to do, if anything is pending.

Rules:
- Preserve exact identifiers: file paths, function/variable names, commands, URLs, \
and error messages. These are load-bearing — never paraphrase them.
- Be comprehensive about facts but ruthless about prose. No pleasantries, no \
meta-commentary about the summary itself.
- Do not invent anything not present in the transcript.
- Return ONLY the summary text. No preamble, no surrounding code fences.
"""


def _message_weight(message: Message) -> int:
    """Roughly how much context ``message`` occupies, in characters."""
    return len(message.content or "") + _MESSAGE_WEIGHT_FLOOR


def split_for_compaction(
    messages: Sequence[Message], ratio: float
) -> tuple[list[Message], list[Message]]:
    """Split a transcript into ``(to_summarize, kept_verbatim)`` for ``ratio``.

    ``ratio`` is the share of the transcript to fold into the summary: ``1.0``
    (the default) summarizes everything, ``0.7`` summarizes the oldest ~70% and
    leaves the newest ~30% untouched, so the turns the user just had survive
    word-for-word while the long tail behind them collapses.

    The share is measured in characters (see :func:`_message_weight`) rather than
    tokens — the exact boundary doesn't matter, only that it lands in roughly the
    right place, and a character count needs no model round-trip. Message
    boundaries are never split, and at least :data:`_MIN_MESSAGES_TO_COMPACT`
    messages are always condensed; when the tail budget would swallow that many,
    the oldest ones are condensed anyway rather than making the call a no-op.

    Returns ``([], list(messages))`` when there is too little history to condense,
    which the caller reports as "not enough history".
    """
    rows = list(messages)
    if len(rows) < _MIN_MESSAGES_TO_COMPACT:
        return [], rows
    if ratio >= 1:
        return rows, []

    keep_budget = sum(_message_weight(m) for m in rows) * (1 - ratio)
    kept: list[Message] = []
    used = 0
    # Newest → oldest: keep turns verbatim while they fit the tail budget, always
    # leaving enough behind to be worth summarizing.
    for message in reversed(rows):
        if len(rows) - len(kept) <= _MIN_MESSAGES_TO_COMPACT:
            break
        weight = _message_weight(message)
        if used + weight > keep_budget:
            break
        used += weight
        kept.append(message)
    kept.reverse()
    return rows[: len(rows) - len(kept)], kept


def _render_transcript(messages: list[Message]) -> str:
    """Flatten thread messages into a plain-text transcript for the summarizer.

    Only user/assistant text is rendered (the roles the transcript is stored in);
    each turn is labelled and long turns are truncated to ``_MAX_MESSAGE_CHARS``.
    Tool calls are noted by name so the summary can reflect that work happened
    without ballooning on raw tool payloads.
    """
    lines: list[str] = []
    for m in messages:
        role = m.role.capitalize() if m.role else "Message"
        content = (m.content or "").strip()
        if len(content) > _MAX_MESSAGE_CHARS:
            content = content[:_MAX_MESSAGE_CHARS] + "\n… [truncated]"
        tool_names = [
            str(tc.get("name"))
            for tc in (m.tool_calls or [])
            if isinstance(tc, dict) and tc.get("name")
        ]
        parts: list[str] = []
        if content:
            parts.append(content)
        if tool_names:
            parts.append(f"[called tools: {', '.join(tool_names)}]")
        if not parts:
            continue
        lines.append(f"### {role}\n" + "\n".join(parts))
    return "\n\n".join(lines)


async def summarize_thread(
    messages: list[Message],
    model_str: str,
    custom_providers: dict[str, CustomProvider] | None = None,
) -> str:
    """Summarize a thread's messages into a single carry-forward digest.

    ``model_str`` is resolved through Lursor's stack (OpenRouter / custom
    providers); the caller supplies the compaction-model override or the thread
    agent's model as the fallback. Returns the summary text (stripped).
    """
    transcript = _render_transcript(messages)
    if not transcript.strip():
        return ""
    model = resolve_model(model_str or settings.default_model, custom_providers or {})
    summarizer = PydanticAgent(model, instructions=COMPACTION_SYSTEM)
    user_message = (
        "Summarize the following conversation transcript so the agent can "
        "continue without the originals.\n\n"
        f"---\n{transcript}\n---\n\n"
        "Write the summary now."
    )
    result = await summarizer.run(user_message)
    return str(result.output).strip()
