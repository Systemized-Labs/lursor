"""What this install has actually paid, per model.

OpenRouter's image catalogue publishes no price. It lives behind a per-model
``/endpoints`` call — one request per model, forty of them for one picker — and
even then it is quoted per *output token*, which cannot be turned into a price
per image without knowing how many tokens a given resolution produces. So there
is no honest number to show before the first generation.

There is one after it. Every finished run records the provider's own
``usage.cost``, so the average of a model's past runs is a real number about a
real thing, and it is the only price this app can put next to an OpenRouter image
model without inventing it. It is also what makes "auto" mean something for
images: with no catalogue price, picking the cheapest model would otherwise be
picking one at random out of forty, some of which cost twenty times the others.

Deliberately not a cache. The query is one indexed aggregate over a table that
holds one row per generation, and a stale price is worse than a fast one.
"""

from __future__ import annotations

from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import ImageGeneration, VideoJob


async def observed_image_costs(
    session: AsyncSession, provider: str
) -> dict[str, float]:
    """``{model: mean USD per image}`` over this install's completed runs.

    Only rows that actually reported a cost count — a NULL is "we do not know",
    not "it was free", and averaging zeros in would understate every model that
    has ever failed to report.
    """
    return await _mean_costs(session, ImageGeneration, provider)


async def observed_video_costs(session: AsyncSession, provider: str) -> dict[str, float]:
    """``{model: mean USD per clip}`` over this install's completed jobs."""
    return await _mean_costs(session, VideoJob, provider)


async def _mean_costs(session: AsyncSession, table, provider: str) -> dict[str, float]:
    result = await session.execute(
        select(table.model, func.avg(table.cost_usd))
        .where(table.provider == provider, table.cost_usd.is_not(None))
        .group_by(table.model)
    )
    return {
        str(model): float(mean)
        for model, mean in result.all()
        if model and mean is not None
    }
