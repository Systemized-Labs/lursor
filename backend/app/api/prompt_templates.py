from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import PromptTemplate
from app.db.session import get_session
from app.schemas.prompt_template import (
    PromptTemplateCreate,
    PromptTemplateRead,
    PromptTemplateUpdate,
)

router = APIRouter(prefix="/prompt-templates", tags=["prompt-templates"])


@router.get("", response_model=list[PromptTemplateRead])
async def list_prompt_templates(session: AsyncSession = Depends(get_session)):
    result = await session.execute(
        select(PromptTemplate).order_by(
            PromptTemplate.category, PromptTemplate.name
        )
    )
    return result.scalars().all()


@router.post("", response_model=PromptTemplateRead, status_code=status.HTTP_201_CREATED)
async def create_prompt_template(
    payload: PromptTemplateCreate, session: AsyncSession = Depends(get_session)
):
    # User-created templates are never builtin; the curated set only comes from
    # the seed script, so is_builtin is not part of the create payload.
    template = PromptTemplate(**payload.model_dump())
    session.add(template)
    await session.commit()
    await session.refresh(template)
    return template


@router.get("/{template_id}", response_model=PromptTemplateRead)
async def get_prompt_template(
    template_id: str, session: AsyncSession = Depends(get_session)
):
    template = await session.get(PromptTemplate, template_id)
    if template is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Prompt template not found")
    return template


@router.patch("/{template_id}", response_model=PromptTemplateRead)
async def update_prompt_template(
    template_id: str,
    payload: PromptTemplateUpdate,
    session: AsyncSession = Depends(get_session),
):
    template = await session.get(PromptTemplate, template_id)
    if template is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Prompt template not found")
    if template.is_builtin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Built-in templates are read-only. Duplicate it to customize.",
        )
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(template, key, value)
    session.add(template)
    await session.commit()
    await session.refresh(template)
    return template


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_prompt_template(
    template_id: str, session: AsyncSession = Depends(get_session)
):
    template = await session.get(PromptTemplate, template_id)
    if template is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Prompt template not found")
    if template.is_builtin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Built-in templates cannot be deleted.",
        )
    await session.delete(template)
    await session.commit()
