"""Models endpoint — proxy OpenRouter's model catalogue.

Keeps the OpenRouter key server-side and returns the catalogue grouped by
provider so the frontend model picker can render it directly.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.api.laios import non_chat_served_names
from app.config import get_settings
from app.db.models import CustomProvider, LaiosConnection
from app.db.session import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/models", tags=["models"])

# Prefix carried by a stored model string so runs can be routed back to the
# right backend. Cloud models go through OpenRouter; custom models encode their
# provider id (see agents/builder.py for the parsing side).
OPENROUTER_PREFIX = "openrouter:"
CUSTOM_PREFIX = "custom:"

# Map OpenRouter provider prefixes to display names.
_PROVIDER_LABELS: dict[str, str] = {
    "anthropic": "Anthropic",
    "openai": "OpenAI",
    "google": "Google",
    "meta-llama": "Meta / Llama",
    "deepseek": "DeepSeek",
    "qwen": "Qwen",
    "mistralai": "Mistral",
    "x-ai": "xAI",
    "cohere": "Cohere",
    "amazon": "Amazon Nova",
    "moonshotai": "Moonshot / Kimi",
    "perplexity": "Perplexity",
    "nvidia": "NVIDIA",
    "microsoft": "Microsoft",
    "01-ai": "01.AI",
    "minimax": "MiniMax",
    "alibaba": "Alibaba",
}


def _provider_label(provider_slug: str) -> str:
    return _PROVIDER_LABELS.get(provider_slug, provider_slug.replace("-", " ").title())


@router.get("")
async def list_models(
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    """Return available models grouped by provider.

    Merges the OpenRouter cloud catalogue with the models advertised by each
    user-added custom provider (locally-hosted, OpenAI-compatible endpoints).
    Every entry carries a ``value`` — the exact string to persist on an agent so
    the run can be routed back to the right backend.

    Returns a list of provider groups::

        [
          {
            "label": "Anthropic",
            "models": [
              {"id": "anthropic/claude-opus-4", "label": "claude-opus-4",
               "name": "Claude Opus 4", "value": "openrouter:anthropic/claude-opus-4"},
              ...
            ]
          },
          ...
        ]
    """
    settings = get_settings()
    url = f"{settings.openrouter_base_url.rstrip('/')}/models"
    headers: dict[str, str] = {"Accept": "application/json"}
    if settings.openrouter_api_key:
        headers["Authorization"] = f"Bearer {settings.openrouter_api_key}"

    # Load custom providers up front so they can still be returned even if
    # OpenRouter is unreachable (a common case when working fully offline).
    custom_providers = (
        (await session.execute(select(CustomProvider))).scalars().all()
    )

    raw_models: list[dict[str, Any]] = []
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            raw_models = resp.json().get("data", [])
    except (httpx.HTTPStatusError, httpx.RequestError) as exc:
        # Don't fail the whole request: custom/local models should still show.
        # When there are none either, surface the error so the picker can fall
        # back to its static list.
        logger.error("models: OpenRouter fetch failed: %s", exc)
        if not custom_providers:
            raise HTTPException(
                status_code=502, detail="Failed to fetch models from OpenRouter"
            ) from exc

    # Group by provider (prefix before the first "/").
    groups: dict[str, list[dict[str, Any]]] = {}
    for m in raw_models:
        model_id: str = m.get("id", "")
        if "/" not in model_id:
            provider = "other"
            short_name = model_id
        else:
            provider, short_name = model_id.split("/", 1)

        pricing = m.get("pricing") or {}
        entry: dict[str, Any] = {
            "id": model_id,
            "label": short_name,
            "name": m.get("name", short_name),
            "value": f"{OPENROUTER_PREFIX}{model_id}",
        }
        if m.get("description"):
            entry["description"] = m["description"]
        if m.get("context_length"):
            entry["context_length"] = m["context_length"]
        if pricing.get("prompt") or pricing.get("completion"):
            entry["pricing"] = {
                "prompt": pricing.get("prompt"),
                "completion": pricing.get("completion"),
            }
        architecture = m.get("architecture") or {}
        modality = architecture.get("modality")
        if modality:
            entry["modality"] = modality
        input_modalities = architecture.get("input_modalities")
        if input_modalities:
            entry["input_modalities"] = input_modalities

        groups.setdefault(provider, []).append(entry)

    # Sort providers: known ones first (in _PROVIDER_LABELS order), then alphabetical.
    known_order = list(_PROVIDER_LABELS.keys())

    def _sort_key(provider: str) -> tuple[int, str]:
        try:
            return (known_order.index(provider), provider)
        except ValueError:
            return (len(known_order), provider)

    cloud_groups = [
        {"label": _provider_label(provider), "models": models}
        for provider, models in sorted(groups.items(), key=lambda kv: _sort_key(kv[0]))
    ]

    # Custom (locally-hosted) providers listed first so they're easy to find.
    # A laios-managed provider mirrors a box's inference gateway, and that
    # gateway's model list cannot say which entries are chat models. Ask the
    # matching control plane so a video generator never reaches the picker.
    hidden = await _non_chat_models_by_provider(session)

    custom_groups = [
        g
        for p in custom_providers
        if (g := await _custom_group(p, hidden.get(p.id, frozenset())))
    ]

    return custom_groups + cloud_groups


async def _non_chat_models_by_provider(
    session: AsyncSession,
) -> dict[str, set[str]]:
    """Per laios-managed provider, the served names that are not chat models.

    Only auto-managed providers are considered: a manually-added one has no
    control plane to ask, so its list is taken at face value.
    """
    connections = (
        (
            await session.execute(
                select(LaiosConnection).where(
                    LaiosConnection.linked_provider_id.is_not(None)
                )
            )
        )
        .scalars()
        .all()
    )

    # Concurrently: this runs on every picker open, and each probe carries its own
    # timeout, so serially one unreachable box would stall the whole catalogue for
    # its full timeout before the next was even tried.
    probes = await asyncio.gather(
        *(non_chat_served_names(conn) for conn in connections),
        return_exceptions=True,
    )

    hidden: dict[str, set[str]] = {}
    for conn, names in zip(connections, probes, strict=True):
        if isinstance(names, BaseException):
            logger.warning(
                "models: capability probe for %r failed: %s", conn.name, names
            )
            continue
        if names:
            logger.info(
                "models: hiding %d non-chat model(s) from %r: %s",
                len(names),
                conn.name,
                ", ".join(sorted(names)),
            )
            hidden[conn.linked_provider_id] = names
    return hidden


async def _custom_group(
    provider: CustomProvider, hidden: set[str] | frozenset[str] = frozenset()
) -> dict[str, Any] | None:
    """Fetch a custom provider's model list via its OpenAI-compatible ``/models``.

    Returns a picker group, or ``None`` if the endpoint is unreachable so one
    dead provider can't blank out the whole catalogue.

    ``hidden`` drops served names that are not chat models — a box serving only a
    video generator yields no group at all rather than one unusable entry.

    Discovery is best-effort: some endpoints serve ``/chat/completions`` happily
    while ``/models`` is auth-gated or unimplemented (e.g. an inference server
    behind a gateway that only proxies the completion routes). Those providers
    fall back to ``manual_models`` so their models are still selectable — without
    it the provider would be dropped here and there'd be no way to pick it.
    """
    base = provider.base_url.rstrip("/")
    if not base:
        return None
    headers = {"Accept": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"

    raw: list[dict[str, Any]] = []
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{base}/models", headers=headers)
            resp.raise_for_status()
            raw = resp.json().get("data", [])
    except (httpx.HTTPStatusError, httpx.RequestError, ValueError) as exc:
        logger.warning("models: custom provider %r unreachable: %s", provider.name, exc)

    model_ids = [m.get("id", "") for m in raw if isinstance(m, dict)]
    model_ids = [model_id for model_id in model_ids if model_id]
    if not model_ids:
        model_ids = provider.manual_model_ids()
        if model_ids:
            logger.info(
                "models: custom provider %r using %d manually-listed model(s)",
                provider.name,
                len(model_ids),
            )

    # Applied after the manual fallback too: a hand-listed video model is just as
    # unchattable as a discovered one.
    model_ids = [model_id for model_id in model_ids if model_id not in hidden]

    if not model_ids:
        return None
    return {
        "label": provider.name,
        "models": [
            {
                "id": model_id,
                "label": model_id,
                "name": model_id,
                "value": f"{CUSTOM_PREFIX}{provider.id}:{model_id}",
            }
            for model_id in model_ids
        ],
    }
