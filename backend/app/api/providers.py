"""Custom model providers — CRUD for user-added local model endpoints.

Each provider is an OpenAI-compatible base URL (Ollama, LM Studio, vLLM, …).
Their models are surfaced in the picker via ``GET /models`` and runs are routed
to them in ``agents/builder.py``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import CustomProvider
from app.db.session import get_session
from app.schemas.provider import ProviderCreate, ProviderRead, ProviderUpdate

router = APIRouter(prefix="/providers", tags=["providers"])


@router.get("", response_model=list[ProviderRead])
async def list_providers(session: AsyncSession = Depends(get_session)):
    result = await session.execute(
        select(CustomProvider).order_by(CustomProvider.created_at)
    )
    return result.scalars().all()


@router.post("", response_model=ProviderRead, status_code=status.HTTP_201_CREATED)
async def create_provider(
    payload: ProviderCreate, session: AsyncSession = Depends(get_session)
):
    provider = CustomProvider(**payload.model_dump())
    session.add(provider)
    await session.commit()
    await session.refresh(provider)
    return provider


@router.get("/{provider_id}", response_model=ProviderRead)
async def get_provider(provider_id: str, session: AsyncSession = Depends(get_session)):
    provider = await session.get(CustomProvider, provider_id)
    if provider is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
    return provider


@router.patch("/{provider_id}", response_model=ProviderRead)
async def update_provider(
    provider_id: str,
    payload: ProviderUpdate,
    session: AsyncSession = Depends(get_session),
):
    provider = await session.get(CustomProvider, provider_id)
    if provider is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(provider, key, value)
    session.add(provider)
    await session.commit()
    await session.refresh(provider)
    return provider


@router.delete("/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_provider(
    provider_id: str, session: AsyncSession = Depends(get_session)
):
    provider = await session.get(CustomProvider, provider_id)
    if provider is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
    await session.delete(provider)
    await session.commit()
