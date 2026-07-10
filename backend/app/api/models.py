"""Models endpoint — proxy OpenRouter's model catalogue.

Keeps the OpenRouter key server-side and returns the catalogue grouped by
provider so the frontend model picker can render it directly.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

from app.config import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/models", tags=["models"])

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
async def list_models() -> list[dict[str, Any]]:
    """Fetch available models from OpenRouter and return them grouped by provider.

    Returns a list of provider groups::

        [
          {
            "label": "Anthropic",
            "models": [
              {"id": "anthropic/claude-opus-4", "label": "claude-opus-4", "name": "Claude Opus 4"},
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

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        logger.error("models: OpenRouter returned %s", exc.response.status_code)
        raise HTTPException(status_code=502, detail="Failed to fetch models from OpenRouter")
    except httpx.RequestError as exc:
        logger.error("models: request error: %s", exc)
        raise HTTPException(status_code=502, detail="Could not reach OpenRouter")

    raw_models: list[dict[str, Any]] = data.get("data", [])

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

    return [
        {"label": _provider_label(provider), "models": models}
        for provider, models in sorted(groups.items(), key=lambda kv: _sort_key(kv[0]))
    ]
