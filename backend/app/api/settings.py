"""App-wide settings — currently the OpenRouter API key.

The key can come from two places: the environment / ``.env`` (read at boot into
:class:`Settings`) or a value the user saves here, which is persisted in the
single ``AppConfig`` row. A UI-saved key wins and is applied to the running
process — both the cached :class:`Settings` (read directly by the models
endpoint) and ``OPENROUTER_API_KEY`` in ``os.environ`` (read by Pydantic AI's
OpenRouter provider during runs) — so it takes effect without a restart.
"""

from __future__ import annotations

import logging
import os

import httpx
from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.agents.web_search import DEFAULT_WEB_SEARCH_PROVIDER
from app.config import get_settings
from app.db.models import AppConfig
from app.db.session import async_session_factory, get_session
from app.schemas.settings import (
    OpenRouterSettingsRead,
    OpenRouterSettingsUpdate,
    OpenRouterTestResult,
    WebSearchSettingsRead,
    WebSearchSettingsUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])

# The key provided via the environment / .env, captured once before any UI
# override is applied. Used as the fallback when the user clears their key.
_env_key: str | None = None
_env_captured = False


def _capture_env_baseline() -> None:
    global _env_key, _env_captured
    if not _env_captured:
        _env_key = get_settings().openrouter_api_key
        _env_captured = True


def _apply_key(key: str | None) -> None:
    """Point the running process at ``key`` (or nothing) for OpenRouter."""
    settings = get_settings()
    settings.openrouter_api_key = key or None
    if key:
        os.environ["OPENROUTER_API_KEY"] = key
    else:
        os.environ.pop("OPENROUTER_API_KEY", None)


async def load_app_config() -> None:
    """Apply the persisted key at startup (called from the app lifespan)."""
    _capture_env_baseline()
    async with async_session_factory() as session:
        cfg = (await session.execute(select(AppConfig))).scalars().first()
    if cfg and cfg.openrouter_api_key:
        _apply_key(cfg.openrouter_api_key)


def _hint(key: str | None) -> str | None:
    return f"…{key[-4:]}" if key and len(key) >= 4 else None


async def _get_config(session: AsyncSession) -> AppConfig | None:
    return (await session.execute(select(AppConfig))).scalars().first()


@router.get("/openrouter", response_model=OpenRouterSettingsRead)
async def get_openrouter(session: AsyncSession = Depends(get_session)):
    _capture_env_baseline()
    cfg = await _get_config(session)
    db_key = cfg.openrouter_api_key if cfg else None
    effective = get_settings().openrouter_api_key
    source = "database" if db_key else ("env" if effective else "none")
    return OpenRouterSettingsRead(
        configured=bool(effective), key_hint=_hint(effective), source=source
    )


@router.put("/openrouter", response_model=OpenRouterSettingsRead)
async def set_openrouter(
    payload: OpenRouterSettingsUpdate, session: AsyncSession = Depends(get_session)
):
    _capture_env_baseline()
    key = (payload.api_key or "").strip() or None

    cfg = await _get_config(session)
    if cfg is None:
        cfg = AppConfig()
    cfg.openrouter_api_key = key
    session.add(cfg)
    await session.commit()

    # A saved key takes effect immediately; clearing reverts to the env value.
    _apply_key(key or _env_key)
    return await get_openrouter(session)


@router.post("/openrouter/test", response_model=OpenRouterTestResult)
async def test_openrouter(payload: OpenRouterSettingsUpdate):
    """Probe a key against OpenRouter's ``/key`` endpoint without saving it.

    When ``api_key`` is omitted, the currently-effective key is tested.
    """
    key = (payload.api_key or "").strip() or get_settings().openrouter_api_key
    if not key:
        return OpenRouterTestResult(status="error", error="No key to test.")

    base = get_settings().openrouter_base_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{base}/key", headers={"Authorization": f"Bearer {key}"}
            )
    except httpx.RequestError as exc:
        logger.warning("openrouter: /key unreachable: %s", exc)
        return OpenRouterTestResult(
            status="error", error="Could not reach OpenRouter. Check your connection."
        )

    if resp.status_code in (401, 403):
        return OpenRouterTestResult(status="error", error="OpenRouter rejected the key.")
    if resp.status_code >= 400:
        return OpenRouterTestResult(
            status="error", error=f"OpenRouter returned HTTP {resp.status_code}."
        )

    data = resp.json().get("data", {}) if resp.content else {}
    return OpenRouterTestResult(status="ok", label=data.get("label") or None)


@router.delete("/openrouter", status_code=status.HTTP_204_NO_CONTENT)
async def clear_openrouter(session: AsyncSession = Depends(get_session)):
    _capture_env_baseline()
    cfg = await _get_config(session)
    if cfg is not None:
        cfg.openrouter_api_key = None
        session.add(cfg)
        await session.commit()
    _apply_key(_env_key)


# --- Web search ---------------------------------------------------------------
# The provider is applied at agent-build time (see ``agents/builder.py``), so —
# unlike the OpenRouter key — there is nothing to push into the running process
# here: reads happen per run straight from the DB row / environment.


@router.get("/web-search", response_model=WebSearchSettingsRead)
async def get_web_search(session: AsyncSession = Depends(get_session)):
    cfg = await _get_config(session)
    provider = (cfg.web_search_provider if cfg else None) or DEFAULT_WEB_SEARCH_PROVIDER

    tavily_db = cfg.tavily_api_key if cfg else None
    tavily_env = get_settings().tavily_api_key
    tavily_eff = tavily_db or tavily_env

    exa_db = cfg.exa_api_key if cfg else None
    exa_env = get_settings().exa_api_key
    exa_eff = exa_db or exa_env

    return WebSearchSettingsRead(
        provider=provider,
        tavily_configured=bool(tavily_eff),
        tavily_key_hint=_hint(tavily_eff),
        tavily_source="database" if tavily_db else ("env" if tavily_env else "none"),
        exa_configured=bool(exa_eff),
        exa_key_hint=_hint(exa_eff),
        exa_source="database" if exa_db else ("env" if exa_env else "none"),
    )


@router.put("/web-search", response_model=WebSearchSettingsRead)
async def set_web_search(
    payload: WebSearchSettingsUpdate, session: AsyncSession = Depends(get_session)
):
    cfg = await _get_config(session)
    if cfg is None:
        cfg = AppConfig()

    # Only touch fields the caller actually sent, so the provider and each key
    # can be saved independently without clobbering the others.
    fields = payload.model_fields_set
    if "provider" in fields:
        cfg.web_search_provider = payload.provider
    if "tavily_api_key" in fields:
        cfg.tavily_api_key = (payload.tavily_api_key or "").strip() or None
    if "exa_api_key" in fields:
        cfg.exa_api_key = (payload.exa_api_key or "").strip() or None

    session.add(cfg)
    await session.commit()
    return await get_web_search(session)
