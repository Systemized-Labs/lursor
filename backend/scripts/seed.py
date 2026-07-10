"""Seed the database with one example skill and agent.

Idempotent-ish: skips seeding if any agents already exist.

    uv run python -m scripts.seed
"""

import asyncio

from sqlmodel import select

from app.db.models import Agent, Skill, ThinkingLevel
from app.db.session import async_session_factory, init_db


async def main() -> None:
    await init_db()
    async with async_session_factory() as session:
        existing = (await session.execute(select(Agent))).scalars().first()
        if existing is not None:
            print("Agents already exist; skipping seed.")
            return

        skill = Skill(
            name="Concise Answers",
            description="Answer directly and briefly, no filler.",
            content=(
                "# Concise Answers\n\n"
                "When responding, lead with the answer. Avoid preamble and "
                "restating the question. Prefer short paragraphs and lists.\n"
            ),
        )
        agent = Agent(
            name="Assistant",
            description="A general-purpose helper agent.",
            instructions="You are a helpful, precise assistant.",
            include_todo=True,
            include_skills=True,
            thinking=ThinkingLevel.low,
            skills=[skill],
        )
        session.add(agent)
        await session.commit()
        print(f"Seeded agent '{agent.name}' ({agent.id}) with skill '{skill.name}'.")


if __name__ == "__main__":
    asyncio.run(main())
