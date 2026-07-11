"""Global subagents — reusable specialists any agent can delegate to.

A subagent is stored once and applies to every agent that has
``include_subagents`` enabled (there is no per-agent link — see
``db/models.py`` :class:`Subagent`). The builder turns each row into a
pydantic-deep ``SubAgentConfig`` at run time (``agents/builder.py``).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import Subagent
from app.db.session import get_session
from app.schemas.subagent import SubagentCreate, SubagentRead, SubagentUpdate

router = APIRouter(prefix="/subagents", tags=["subagents"])


@router.get("", response_model=list[SubagentRead])
async def list_subagents(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Subagent).order_by(Subagent.created_at))
    return result.scalars().all()


@router.post("", response_model=SubagentRead, status_code=status.HTTP_201_CREATED)
async def create_subagent(
    payload: SubagentCreate, session: AsyncSession = Depends(get_session)
):
    subagent = Subagent(**payload.model_dump())
    session.add(subagent)
    await session.commit()
    await session.refresh(subagent)
    return subagent


@router.get("/{subagent_id}", response_model=SubagentRead)
async def get_subagent(subagent_id: str, session: AsyncSession = Depends(get_session)):
    subagent = await session.get(Subagent, subagent_id)
    if subagent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Subagent not found")
    return subagent


@router.patch("/{subagent_id}", response_model=SubagentRead)
async def update_subagent(
    subagent_id: str,
    payload: SubagentUpdate,
    session: AsyncSession = Depends(get_session),
):
    subagent = await session.get(Subagent, subagent_id)
    if subagent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Subagent not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(subagent, key, value)
    session.add(subagent)
    await session.commit()
    await session.refresh(subagent)
    return subagent


@router.delete("/{subagent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_subagent(
    subagent_id: str, session: AsyncSession = Depends(get_session)
):
    subagent = await session.get(Subagent, subagent_id)
    if subagent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Subagent not found")
    await session.delete(subagent)
    await session.commit()
