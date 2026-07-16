"""Model pricing lookup and per-turn cost computation.

The OpenRouter catalogue advertises a per-token price (in USD) for every cloud
model. We fetch it once and cache it in-process with a short TTL so recording
usage on every turn does not re-hit the network. Local/custom models are not in
the catalogue and resolve to ``$0``.

This is the single source of truth for pricing; ``api/models.py`` reuses
:func:`get_pricing_map` to decorate the picker catalogue.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

OPENROUTER_PREFIX = "openrouter:"
CUSTOM_PREFIX = "custom:"

# How long a fetched pricing map stays fresh before the next lookup refetches.
_CACHE_TTL_SECONDS = 15 * 60

# Module-level cache: {model_id: {"prompt": float, "completion": float}}.
_cache: dict[str, dict[str, float]] | None = None
_cache_fetched_at: float = 0.0


def _price(value: Any) -> float:
    """Coerce an OpenRouter price field (a string like ``"0.0000006"``) to float."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


async def get_pricing_map(*, force_refresh: bool = False) -> dict[str, dict[str, float]]:
    """Return ``{model_id: {"prompt": <usd/token>, "completion": <usd/token>}}``.

    Keyed by the bare OpenRouter model id (no ``openrouter:`` prefix), e.g.
    ``"anthropic/claude-opus-4"``. Cached in-process for ``_CACHE_TTL_SECONDS``.
    On a fetch failure the last good map is reused (or an empty map first time),
    so pricing gaps never break a turn.
    """
    global _cache, _cache_fetched_at

    now = time.monotonic()
    if (
        not force_refresh
        and _cache is not None
        and (now - _cache_fetched_at) < _CACHE_TTL_SECONDS
    ):
        return _cache

    settings = get_settings()
    url = f"{settings.openrouter_base_url.rstrip('/')}/models"
    headers: dict[str, str] = {"Accept": "application/json"}
    if settings.openrouter_api_key:
        headers["Authorization"] = f"Bearer {settings.openrouter_api_key}"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            raw_models = resp.json().get("data", [])
    except (httpx.HTTPStatusError, httpx.RequestError) as exc:
        logger.warning("pricing: OpenRouter fetch failed: %s", exc)
        return _cache if _cache is not None else {}

    pricing: dict[str, dict[str, float]] = {}
    for m in raw_models:
        model_id = m.get("id", "")
        p = m.get("pricing") or {}
        if not model_id:
            continue
        pricing[model_id] = {
            "prompt": _price(p.get("prompt")),
            "completion": _price(p.get("completion")),
        }

    _cache = pricing
    _cache_fetched_at = now
    return pricing


async def compute_cost(model: str, usage: Any) -> float:
    """Compute the USD cost of a turn from its model string and ``RunUsage``.

    ``model`` is the raw stored string (``openrouter:<id>`` or ``custom:...``).
    Only OpenRouter models have catalogue pricing; anything else — custom/local
    providers, or a model missing from the catalogue — costs ``0.0``.
    """
    if usage is None or not model.startswith(OPENROUTER_PREFIX):
        return 0.0

    model_id = model[len(OPENROUTER_PREFIX):]
    prices = (await get_pricing_map()).get(model_id)
    if not prices:
        return 0.0

    input_tokens = getattr(usage, "input_tokens", 0) or 0
    output_tokens = getattr(usage, "output_tokens", 0) or 0
    return input_tokens * prices["prompt"] + output_tokens * prices["completion"]
