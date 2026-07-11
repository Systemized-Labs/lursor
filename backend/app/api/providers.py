"""Custom model providers — CRUD for user-added local model endpoints.

Each provider is an OpenAI-compatible base URL (Ollama, LM Studio, vLLM, …).
Their models are surfaced in the picker via ``GET /models`` and runs are routed
to them in ``agents/builder.py``.
"""

from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import CustomProvider
from app.db.session import get_session
from app.schemas.provider import (
    ProviderCreate,
    ProviderHealth,
    ProviderRead,
    ProviderUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/providers", tags=["providers"])


async def _probe_provider(provider: CustomProvider) -> ProviderHealth:
    """Probe a provider's ``/models`` and classify the outcome for the user.

    Mirrors how ``models._custom_group`` fetches the catalogue, but instead of
    silently dropping a failing provider it reports *why* it failed so the UI can
    surface it (unreachable, bad key, empty catalogue, …).
    """
    base = provider.base_url.rstrip("/")
    if not base:
        return ProviderHealth(status="error", error="No base URL configured.")

    headers = {"Accept": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{base}/models", headers=headers)
    except httpx.TimeoutException:
        return ProviderHealth(
            status="error", error="Timed out reaching the endpoint (5s)."
        )
    except httpx.RequestError as exc:
        logger.warning("health: %r unreachable: %s", provider.name, exc)
        return ProviderHealth(
            status="error",
            error=(
                "Could not reach the endpoint — check the base URL and that "
                "the server is running."
            ),
        )

    if resp.status_code in (401, 403):
        return ProviderHealth(
            status="error",
            error=(
                "Authentication failed — this endpoint requires an API key "
                "(or the key is wrong)."
            ),
        )
    if resp.status_code >= 400:
        return ProviderHealth(
            status="error",
            error=f"Endpoint returned HTTP {resp.status_code}.",
        )

    try:
        data = resp.json().get("data", [])
    except ValueError:
        return ProviderHealth(
            status="error", error="Response was not valid JSON — is this an OpenAI-compatible URL?"
        )

    count = sum(1 for m in data if isinstance(m, dict) and m.get("id"))
    if count == 0:
        return ProviderHealth(
            status="error", error="Reachable, but the endpoint returned no models."
        )
    return ProviderHealth(status="ok", model_count=count)


@router.get("", response_model=list[ProviderRead])
async def list_providers(session: AsyncSession = Depends(get_session)):
    # Providers auto-managed by a laios connection are surfaced in the model
    # picker but managed from the laios tab, so hide them from manual CRUD here.
    from app.api.laios import managed_provider_ids

    managed = await managed_provider_ids(session)
    result = await session.execute(
        select(CustomProvider).order_by(CustomProvider.created_at)
    )
    return [p for p in result.scalars().all() if p.id not in managed]


@router.post("", response_model=ProviderRead, status_code=status.HTTP_201_CREATED)
async def create_provider(
    payload: ProviderCreate, session: AsyncSession = Depends(get_session)
):
    provider = CustomProvider(**payload.model_dump())
    session.add(provider)
    await session.commit()
    await session.refresh(provider)
    return provider


@router.post("/test", response_model=ProviderHealth)
async def test_provider(payload: ProviderCreate):
    """Probe an unsaved provider so users can verify a config before saving."""
    return await _probe_provider(CustomProvider(**payload.model_dump()))


@router.get("/{provider_id}/health", response_model=ProviderHealth)
async def check_provider_health(
    provider_id: str, session: AsyncSession = Depends(get_session)
):
    """Probe a saved provider's endpoint and report its status."""
    provider = await session.get(CustomProvider, provider_id)
    if provider is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
    return await _probe_provider(provider)


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
