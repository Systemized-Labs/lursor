from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import Skill
from app.db.session import get_session
from app.schemas.skill import SkillCreate, SkillRead, SkillUpdate

router = APIRouter(prefix="/skills", tags=["skills"])


@router.get("", response_model=list[SkillRead])
async def list_skills(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Skill).order_by(Skill.created_at))
    return result.scalars().all()


@router.post("", response_model=SkillRead, status_code=status.HTTP_201_CREATED)
async def create_skill(payload: SkillCreate, session: AsyncSession = Depends(get_session)):
    skill = Skill(**payload.model_dump())
    session.add(skill)
    await session.commit()
    await session.refresh(skill)
    return skill


@router.get("/{skill_id}", response_model=SkillRead)
async def get_skill(skill_id: str, session: AsyncSession = Depends(get_session)):
    skill = await session.get(Skill, skill_id)
    if skill is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")
    return skill


@router.patch("/{skill_id}", response_model=SkillRead)
async def update_skill(
    skill_id: str, payload: SkillUpdate, session: AsyncSession = Depends(get_session)
):
    skill = await session.get(Skill, skill_id)
    if skill is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(skill, key, value)
    session.add(skill)
    await session.commit()
    await session.refresh(skill)
    return skill


@router.delete("/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_skill(skill_id: str, session: AsyncSession = Depends(get_session)):
    skill = await session.get(Skill, skill_id)
    if skill is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")
    await session.delete(skill)
    await session.commit()
