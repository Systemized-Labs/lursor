"""Seed the database.

Two independent, idempotent steps:

- **Prompt templates** — a curated set of reusable system prompts. Upserted by
  name (built-in rows only), so re-running refreshes their content without
  duplicating or clobbering user-created templates.
- **Example agent + skill** — a single starter, only when no agents exist yet.

    uv run python -m scripts.seed
"""

import asyncio

from sqlmodel import select

from app.db.models import Agent, Skill, ThinkingLevel
from app.db.prompt_seed import seed_prompt_templates as _seed_prompt_templates
from app.db.session import async_session_factory, init_db
from app.skills import store as skill_store


async def seed_prompt_templates(session) -> None:
    """Upsert the curated built-in templates (see ``app.db.prompt_seed``)."""
    created, updated = await _seed_prompt_templates(session)
    print(f"Prompt templates: {created} created, {updated} refreshed.")


async def seed_example_agent(session) -> None:
    """Seed one example agent + skill, only when no agents exist yet."""
    existing = (await session.execute(select(Agent))).scalars().first()
    if existing is not None:
        print("Agents already exist; skipping example agent.")
        return

    name = "Concise Answers"
    description = "Answer directly and briefly, no filler."
    content = (
        "# Concise Answers\n\n"
        "When responding, lead with the answer. Avoid preamble and "
        "restating the question. Prefer short paragraphs and lists.\n"
    )
    # Skills live in the global scope now (no per-agent link) — any agent with
    # ``include_skills`` on discovers them. Seed one global skill + one agent.
    root = skill_store.global_skills_root()
    slug = skill_store.slugify(name, taken=set(skill_store.list_slugs(root)))
    skill_store.write_skill(
        slug, root, name=name, description=description, content=content
    )
    skill = Skill(slug=slug, name=name, description=description, content=content)
    agent = Agent(
        name="Assistant",
        description="A general-purpose helper agent.",
        instructions="You are a helpful, precise assistant.",
        include_todo=True,
        include_skills=True,
        thinking=ThinkingLevel.low,
    )
    session.add_all([skill, agent])
    await session.commit()
    print(f"Seeded agent '{agent.name}' ({agent.id}) with global skill '{skill.name}'.")


async def main() -> None:
    await init_db()
    async with async_session_factory() as session:
        await seed_prompt_templates(session)
        await seed_example_agent(session)


if __name__ == "__main__":
    asyncio.run(main())
