"""Name a conversation from its opening message.

Powers auto-titling: when a thread's first user turn lands, a one-shot
:class:`pydantic_ai.Agent` reads that message and writes a short, human-friendly
title in place of the default placeholder. It mirrors
:mod:`app.agents.compaction` — a tiny call through
:func:`app.agents.builder.resolve_model`, so titling runs on the same OpenRouter
/ custom-provider plumbing as chat, on a small/fast model. The caller fires it in
the background so it never blocks the chat stream (see ``api/chat.py``).
"""

from __future__ import annotations

from pydantic_ai import Agent as PydanticAgent

from app.agents.builder import resolve_model
from app.config import get_settings
from app.db.models import CustomProvider

settings = get_settings()

# Hard cap on the stored title, matching the placeholder truncation in chat.py, so
# a chatty model can't produce a giant string that breaks the sidebar layout.
_MAX_TITLE_CHARS = 60
# Cap on the opening message we feed the model — a title only needs the gist, and
# a pasted blob shouldn't blow past the tiny model's context.
_MAX_INPUT_CHARS = 2000

TITLE_SYSTEM = """\
You name conversations. Given a user's opening message to an AI coding agent, \
write a short, specific title for that conversation.

Rules:
- 2 to 6 words, in Title Case, with no trailing punctuation.
- Name the task or topic, not the user ("Fix flaky auth test", not "User asks \
about a failing test").
- No quotes, no code fences, no preamble or explanation.
- Return ONLY the title text.
"""


async def generate_title(
    user_text: str,
    model_str: str,
    custom_providers: dict[str, CustomProvider] | None = None,
) -> str:
    """Generate a short title from a thread's first user message.

    ``model_str`` is resolved through Lursor's stack (OpenRouter / custom
    providers); the caller supplies the fast title model. Returns the cleaned
    title, or ``""`` when there's no text to title or the model returns nothing.
    """
    text = (user_text or "").strip()
    if not text:
        return ""
    model = resolve_model(model_str or settings.default_model, custom_providers or {})
    titler = PydanticAgent(model, instructions=TITLE_SYSTEM)
    result = await titler.run(
        "Write the conversation title for this opening message:\n\n"
        + text[:_MAX_INPUT_CHARS]
    )
    # Models sometimes wrap the answer in quotes or spread it over lines despite
    # the instructions; collapse to a single clean line and clamp the length.
    title = " ".join(str(result.output).split()).strip().strip('"').strip()
    return title[:_MAX_TITLE_CHARS]
