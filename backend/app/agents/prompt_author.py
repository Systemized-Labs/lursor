"""Author and refine agent system prompts with an LLM.

A one-shot :class:`pydantic_ai.Agent` runs a *meta-prompt* — a prompt-engineering
system prompt distilled from the recurring structure seen across leaked
production system prompts (role → capabilities → tone → constraints → tool-use →
output format). It reuses :func:`app.agents.builder.resolve_model`, so generation
runs on the same OpenRouter / custom-provider plumbing as chat.

The output is meant to drop straight into ``Agent.instructions``, so the model is
told to return only the prompt text — no preamble, no code fences.
"""

from __future__ import annotations

from pydantic import BaseModel
from pydantic_ai import Agent as PydanticAgent

from app.agents.builder import resolve_model
from app.config import get_settings
from app.db.models import CustomProvider, ThinkingLevel

settings = get_settings()


class AgentPromptContext(BaseModel):
    """The subset of an agent's config that shapes a capability-aware prompt."""

    name: str = ""
    description: str = ""
    include_todo: bool = False
    include_subagents: bool = False
    include_skills: bool = False
    include_memory: bool = False
    include_plan: bool = False
    web_search: bool = False
    browser_qa: bool = False
    include_video: bool = False
    include_image: bool = False
    thinking: ThinkingLevel = ThinkingLevel.off
    skill_names: list[str] = []
    tool_names: list[str] = []
    model: str | None = None


META_PROMPT = """\
You are an expert prompt engineer. Your job is to write a single, high-quality \
system prompt for an AI agent, given a brief and the agent's runtime \
capabilities.

Write the prompt so it is specific, testable, and grounded in the capabilities \
the agent actually has. Follow this structure, using short markdown headings, \
and omit any section that does not apply:

- **Role & goal** — who the agent is and the outcome it drives toward.
- **How you work** — the agent's operating approach; reference only the enabled \
capabilities below (todo lists, planning, subagents, memory, skills, web \
search). Never instruct the agent to use a tool or capability it does not have.
- **Tone & style** — concrete, matched to the role.
- **Constraints & safety** — what to avoid; when to ask instead of assume; how \
to handle uncertainty.
- **Output format** — the expected shape of responses when it matters.

Rules:
- Prefer positive, concrete instructions over vague adjectives; add a short \
example when it sharpens the intent.
- Be concise. Do not pad. A focused one-page prompt beats a sprawling one.
- Return ONLY the finished system prompt text. No preamble, no explanation, no \
surrounding code fences.
"""


def _capability_lines(ctx: AgentPromptContext) -> str:
    """Render the enabled capabilities as guidance the meta-prompt can lean on."""
    lines: list[str] = []
    if ctx.name:
        lines.append(f"- Agent name: {ctx.name}")
    if ctx.description:
        lines.append(f"- Short description: {ctx.description}")

    caps: list[str] = []
    if ctx.include_plan:
        caps.append("planning (write and follow an explicit plan for large tasks)")
    if ctx.include_todo:
        caps.append("todo list (track multi-step work as a checklist)")
    if ctx.include_subagents:
        caps.append("subagents (delegate independent sub-tasks)")
    if ctx.include_memory:
        caps.append("persistent memory (recall facts across runs)")
    if ctx.include_skills:
        skills = ", ".join(ctx.skill_names) if ctx.skill_names else "attached skills"
        caps.append(f"skills ({skills})")
    if ctx.web_search:
        caps.append("web search (cite sources; verify current facts before answering)")
    if ctx.browser_qa:
        caps.append(
            "browser QA (open the app in a headless browser to view and test it, "
            "read console/network errors, and verify the UI you build)"
        )
    if ctx.include_video:
        caps.append(
            "video generation (generate clips with synchronised audio on a "
            "connected laios box, then assemble them with ffmpeg; each render "
            "takes minutes of GPU time, so draft cheap before committing)"
        )
    if ctx.include_image:
        caps.append(
            "image generation (generate images on a connected laios box in seconds "
            "and look at them; a generated image is also a starting frame for video)"
        )
    if ctx.tool_names:
        caps.append("tools: " + ", ".join(ctx.tool_names))

    thinking = ctx.thinking.value if isinstance(ctx.thinking, ThinkingLevel) else str(ctx.thinking)
    if thinking and thinking != "off":
        caps.append(f"extended thinking (level: {thinking})")

    if caps:
        lines.append("- Enabled capabilities:")
        lines.extend(f"    - {c}" for c in caps)
    else:
        lines.append(
            "- Enabled capabilities: none beyond plain chat — do not reference "
            "tools, files, planning, or delegation."
        )
    return "\n".join(lines)


def _build_author(
    ctx: AgentPromptContext, custom_providers: dict[str, CustomProvider]
) -> PydanticAgent:
    # Authoring is a one-shot `.run()`, not a stream.
    model = resolve_model(
        ctx.model or settings.default_model, custom_providers, streaming=False
    )
    return PydanticAgent(model, instructions=META_PROMPT)


async def generate_prompt(
    brief: str,
    ctx: AgentPromptContext,
    custom_providers: dict[str, CustomProvider] | None = None,
) -> str:
    """Draft a system prompt from a one-line brief + the agent's capabilities."""
    author = _build_author(ctx, custom_providers or {})
    user_message = (
        f"Brief for the agent:\n{brief.strip()}\n\n"
        f"Agent capabilities:\n{_capability_lines(ctx)}\n\n"
        "Write the system prompt now."
    )
    result = await author.run(user_message)
    return str(result.output).strip()


async def improve_prompt(
    current: str,
    ctx: AgentPromptContext,
    custom_providers: dict[str, CustomProvider] | None = None,
) -> str:
    """Rewrite an existing system prompt, tightened and made capability-aware."""
    author = _build_author(ctx, custom_providers or {})
    user_message = (
        "Improve the following system prompt. Keep its intent, but make it "
        "clearer, better structured, and consistent with the agent's actual "
        "capabilities. Remove references to capabilities the agent does not have "
        "and add guidance for enabled ones that are unaddressed.\n\n"
        f"Current system prompt:\n---\n{current.strip()}\n---\n\n"
        f"Agent capabilities:\n{_capability_lines(ctx)}\n\n"
        "Return the improved system prompt now."
    )
    result = await author.run(user_message)
    return str(result.output).strip()
