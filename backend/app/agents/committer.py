"""Write commit messages for the Changes panel's one-click commit.

The panel runs the whole commit for the agent-harness workflow (``add -A`` +
commit + push), so asking the human to compose the message is the one awkward
manual step in the middle. The same one-shot :class:`pydantic_ai.Agent`
plumbing that names conversations (:mod:`app.agents.titler`) is pointed at the
staged change instead and writes the message on a small/fast model.

Best-effort, exactly like titling: the caller falls back to a stats-based
message when the model is unreachable or returns nothing, so the commit button
never dead-ends on an LLM hiccup — see ``_fallback_commit_message`` in
:mod:`app.api.git`.
"""

from __future__ import annotations

from pydantic_ai import Agent as PydanticAgent

from app.agents.builder import resolve_model
from app.config import get_settings
from app.db.models import CustomProvider

settings = get_settings()

# Commit subjects are conventionally short; clamp so a chatty model can't push
# a paragraph into `git log --oneline`.
_MAX_MESSAGE_CHARS = 72
# Cap the staged patch fed to the model — a good message needs the gist, and a
# giant generated file shouldn't blow past the small model's context.
_MAX_PATCH_CHARS = 6000

COMMIT_SYSTEM = """\
You write git commit messages. Given a summary of the staged changes and a
sample of the staged diff, write the commit message.

Rules:
- A single line, imperative mood ("Add retry to fetch", "Fix off-by-one in pager").
- 72 characters at most, no trailing punctuation.
- Say what changed and why when the diff makes it obvious; name a file only if a
  single path explains the whole change.
- No quotes, no code fences, no author prefixes, no preamble or explanation.
- Return ONLY the commit message.
"""


async def generate_commit_message(
    stat: str,
    patch: str,
    model_str: str,
    custom_providers: dict[str, CustomProvider] | None = None,
) -> str:
    """Generate a single-line commit message for a staged change.

    ``model_str`` is resolved through Lursor's stack (OpenRouter / custom
    providers); the caller supplies the fast title model. Returns the cleaned
    one-line message, or ``""`` when there is no patch to describe or the model
    returns nothing — the caller owns the fallback.
    """
    patch = (patch or "")[:_MAX_PATCH_CHARS]
    if not patch.strip():
        return ""
    # Composing is a one-shot `.run()`, not a stream — same shape as titling.
    model = resolve_model(
        model_str or settings.default_model, custom_providers or {}, streaming=False
    )
    writer = PydanticAgent(model, instructions=COMMIT_SYSTEM)
    result = await writer.run(
        "Write the commit message for this staged change.\n\n"
        f"{(stat or '').strip()}\n\nStaged diff (may be truncated):\n{patch}"
    )
    # Models sometimes wrap the answer in quotes/backticks despite the
    # instructions; collapse to a single clean line and clamp the length.
    message = (
        " ".join(str(result.output).split()).strip().strip('"').strip("`").strip()
    )
    return message[:_MAX_MESSAGE_CHARS]
