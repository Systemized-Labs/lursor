"""Which box generates this run's clips, and what it will accept.

``build_deep_agent`` is synchronous, but deciding whether an agent gets the video
tools needs a session (the connection rows) *and* the network (what each box is
actually serving). So the async work happens here, once, and the result is handed
to the builder as a single value — the same shape as
:class:`~app.agents.skill_runtime.SkillRuntime`.

``None`` means "build without video tools", and it is the answer for every one of:
the agent's ``include_video`` flag is off, there is no laios connection, or no
connection is serving a video-capable model. That is deliberately **fail-closed**,
unlike the chat picker's capability filter (``non_chat_served_names``, which fails
open): the picker hides on a guess and can afford to guess generously, while a
generation tool built against a box we cannot classify would 400 on every call.
An absent tool is honest; a tool that always fails is not.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.api.laios import video_served_names
from app.db.models import LaiosConnection

logger = logging.getLogger(__name__)

# How long a box's answer to "what are you serving" is reused. Resolution costs a
# control-plane round trip per connection and happens on every turn of a
# video-enabled agent, so an unreachable box would add its 5s timeout to each one.
# What a box serves changes on a serve/stop, so the stale window costs at most one
# turn's worth of tools — and a job submitted against a model that stopped in the
# meantime fails with the gateway's own message rather than silently.
_CACHE_TTL_SECONDS = 300.0

# connection id -> (served video model names, when we asked)
_served_cache: dict[str, tuple[frozenset[str], float]] = {}


@dataclass(frozen=True)
class VideoConstraints:
    """What the serving model accepts, as the tools enforce it locally.

    These are MiniMax-H3's, which is the only ``capabilities: [video]`` recipe
    today, and they are read off the engine rather than derived: the short edge is
    fixed (``target.short_edge must be 768 for minimax_h3``), the duration range and
    the 4-50 step range are its own validation, and ``sizes`` are the pixel
    dimensions the engine *returns* — 768 at 16:9 is 1365 by arithmetic and 1344 in
    practice, because it snaps the long edge to its patch size.

    A dataclass rather than module constants so the day the model inventory carries
    real per-model constraints there is one place for them to land.
    """

    short_edge: int = 768
    aspect_ratios: tuple[str, ...] = ("16:9", "9:16", "1:1")
    sizes: dict[str, str] = field(
        default_factory=lambda: {
            "16:9": "1344 x 768",
            "9:16": "768 x 1344",
            "1:1": "768 x 768",
        }
    )
    min_duration_seconds: float = 4.0
    max_duration_seconds: float = 15.0
    min_steps: int = 4
    max_steps: int = 50
    # Measured at 1344x768x107f in the recipe header: the whole progress story,
    # since H3 reports queued/0 for the entire run and then flips to completed/100.
    seconds_per_step: int = 44
    # Video and a synchronised stereo AAC track, in one mp4. Named here because
    # ``view_video`` has to say plainly that it cannot judge the audio.
    emits_audio: bool = True


@dataclass(frozen=True)
class VideoRuntime:
    """The resolved generation target for one run."""

    connection_id: str
    connection_name: str
    # The *served* name, which is what the gateway routes on — never a recipe id.
    model: str
    constraints: VideoConstraints = field(default_factory=VideoConstraints)


async def _video_models(conn: LaiosConnection) -> frozenset[str]:
    """Cached ``video_served_names`` for one connection."""
    now = time.monotonic()
    cached = _served_cache.get(conn.id)
    if cached is not None and now - cached[1] < _CACHE_TTL_SECONDS:
        return cached[0]
    names = frozenset(await video_served_names(conn))
    _served_cache[conn.id] = (names, now)
    return names


def reset_video_model_cache() -> None:
    """Drop the served-model cache. For tests, and for a forced re-resolve."""
    _served_cache.clear()


async def load_video_runtime(
    session: AsyncSession, *, include_video: bool
) -> VideoRuntime | None:
    """Resolve the connection and model this run's video tools would use.

    ``include_video=False`` (the agent's flag) short-circuits before any network
    call, which is why the default-off flag costs nothing for every other agent.
    """
    if not include_video:
        return None

    result = await session.execute(
        select(LaiosConnection).order_by(LaiosConnection.created_at)
    )
    connections = list(result.scalars().all())
    if not connections:
        return None

    for conn in connections:
        names = await _video_models(conn)
        if not names:
            continue
        # Deterministic when a box serves several: the tools name the model they
        # picked in every result, so which one it is must not vary per turn.
        model = sorted(names)[0]
        logger.info(
            "video tools resolved to model %r on connection %r", model, conn.name
        )
        return VideoRuntime(
            connection_id=conn.id, connection_name=conn.name, model=model
        )
    return None
