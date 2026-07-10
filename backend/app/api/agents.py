from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import Agent, Skill, Tool
from app.db.session import get_session
from app.schemas.agent import AgentCreate, AgentRead, AgentUpdate

router = APIRouter(prefix="/agents", tags=["agents"])


async def _resolve(session: AsyncSession, model, ids: list[str]) -> list:
    """Load rows by id, 404-ing if any id is unknown."""
    if not ids:
        return []
    result = await session.execute(select(model).where(model.id.in_(ids)))
    rows = result.scalars().all()
    found = {r.id for r in rows}
    missing = set(ids) - found
    if missing:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown {model.__name__.lower()} id(s): {', '.join(sorted(missing))}",
        )
    return rows


@router.get("", response_model=list[AgentRead])
async def list_agents(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Agent).order_by(Agent.created_at))
    return [AgentRead.from_agent(a) for a in result.scalars().all()]


@router.post("", response_model=AgentRead, status_code=status.HTTP_201_CREATED)
async def create_agent(payload: AgentCreate, session: AsyncSession = Depends(get_session)):
    # Resolve links before the agent joins the session, so assigning the
    # collections cannot trigger a sync lazy-load on a flushed-but-unloaded object.
    skills = await _resolve(session, Skill, payload.skill_ids)
    tools = await _resolve(session, Tool, payload.tool_ids)
    data = payload.model_dump(exclude={"skill_ids", "tool_ids"})
    agent = Agent(**data, skills=skills, tools=tools)
    session.add(agent)
    await session.commit()
    return AgentRead.from_agent(agent)


@router.get("/{agent_id}", response_model=AgentRead)
async def get_agent(agent_id: str, session: AsyncSession = Depends(get_session)):
    agent = await session.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    return AgentRead.from_agent(agent)


@router.patch("/{agent_id}", response_model=AgentRead)
async def update_agent(
    agent_id: str, payload: AgentUpdate, session: AsyncSession = Depends(get_session)
):
    agent = await session.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")

    data = payload.model_dump(exclude_unset=True, exclude={"skill_ids", "tool_ids"})
    for key, value in data.items():
        setattr(agent, key, value)
    if payload.skill_ids is not None:
        agent.skills = await _resolve(session, Skill, payload.skill_ids)
    if payload.tool_ids is not None:
        agent.tools = await _resolve(session, Tool, payload.tool_ids)

    session.add(agent)
    await session.commit()
    return AgentRead.from_agent(agent)


@router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent(agent_id: str, session: AsyncSession = Depends(get_session)):
    agent = await session.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    await session.delete(agent)
    await session.commit()
