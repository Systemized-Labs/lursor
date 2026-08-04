"""Which box generates this run's clips, what it accepts, and how to ask it.

``build_deep_agent`` is synchronous, but deciding whether an agent gets the video
tools needs a session (the connection rows) *and* the network (what each box is
actually serving). So the async work happens here, once, and the result is handed
to the builder as a single value — the same shape as
:class:`~app.agents.skill_runtime.SkillRuntime`.

``None`` means "build without video tools", and it is the answer for every one of:
the agent's ``include_video`` flag is off, there is no laios connection, no
connection is serving a video-capable model, or nothing serving is one we know how
to *drive*. That last clause is the interesting one.

**Why "capabilities: [video]" is not enough to drive a model.** The request surface
is per-model, not per-engine: MiniMax-H3 takes its own canonical body (``task`` /
``target`` / ``conditions``) while the generic SGLang video API takes ``seconds`` /
``size`` / ``input_reference``. Guessing wrong does not fail loudly — SGLang's base
``lower_video_request_kwargs`` discards fields it does not recognise, then falls
back to its own default duration and resolution, so the caller pays full GPU time
for a clip of the wrong length with its conditioning frames silently ignored, and
gets HTTP 200. That is worse than any error.

So the model has to *declare* its request shape, in the recipe's ``video_profile``
block, which the control plane surfaces on ``/v1/models``
(``docs/upstream/laios-video-profile.patch``). Resolution order:

1. a profile naming a :data:`SCHEMAS` we implement → drive it, with the profile's
   own ranges as the local constraints;
2. no profile, but the model *identifies* as MiniMax-H3 → drive it as H3 with the
   measured defaults. Grandfathered on purpose: H3 predates the profile and is the
   only video recipe in the wild, so requiring one would turn a working box off;
3. anything else → **no tools**, with a log line naming the model and why.

Fail-closed throughout, which is the opposite of the chat picker's capability
filter (``non_chat_served_names``, which fails open): the picker hides on a guess
and can afford to guess generously, while a generation tool built against a box we
cannot classify would burn minutes of someone's GPU to produce the wrong thing.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field, replace
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.api.laios import VideoServedModel, video_served_models
from app.db.models import LaiosConnection

logger = logging.getLogger(__name__)

# Request bodies ``agents/video_tools.py`` knows how to build. A profile naming
# anything else is a model we cannot drive, however video-capable it is.
SCHEMA_MINIMAX_H3 = "minimax_h3.request/v1"
SCHEMA_SGLANG_VIDEO = "sglang.video/v1"
SCHEMAS = frozenset({SCHEMA_MINIMAX_H3, SCHEMA_SGLANG_VIDEO})

# How a model with no profile is recognised as MiniMax-H3 (resolution step 2).
# ``model_id`` is the Hugging Face repo and the most stable identity; the served
# name and recipe id are operator-chosen, so they are only a fallback.
_H3_MODEL_IDS = frozenset({"minimaxai/minimax-h3", "minimax/minimax-h3"})
_H3_NAME_HINT = "minimax-h3"

# How long a box's answer to "what are you serving" is reused. Resolution costs a
# control-plane round trip per connection and happens on every turn of a
# video-enabled agent, so an unreachable box would add its 5s timeout to each one.
# What a box serves changes on a serve/stop, so the stale window costs at most one
# turn's worth of tools — and a job submitted against a model that stopped in the
# meantime fails with the gateway's own message rather than silently.
_CACHE_TTL_SECONDS = 300.0

# connection id -> (models, when we asked)
_served_cache: dict[str, tuple[tuple[VideoServedModel, ...], float]] = {}


@dataclass(frozen=True)
class VideoConstraints:
    """What the serving model accepts, as the tools enforce it locally.

    The defaults are MiniMax-H3's, measured rather than derived: the short edge is
    fixed (``target.short_edge must be 768 for minimax_h3``), the duration range and
    the 4-50 step range are its own validation, ``sizes`` are the pixel dimensions
    the engine *returns* (768 at 16:9 is 1365 by arithmetic and 1344 in practice,
    because it snaps the long edge to its patch size), and 44 s/step is the recipe's
    own measurement. They apply only to a model resolved as H3; anything else brings
    its own numbers from its profile.

    Validating locally is worth a dataclass because a 400 round trip through a
    tunnel costs more than a check, and the useful half of the message
    ("must be in [4, 15]") is knowable here.
    """

    short_edge: int | None = 768
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
    # The only progress signal for a model that reports ``queued`` until it is done.
    seconds_per_step: int = 44
    # Whether first/last-frame conditioning is supported at all.
    keyframes: bool = True
    # Video and a synchronised stereo AAC track in one mp4. Named here because
    # ``view_video`` has to say plainly that it cannot judge the audio.
    emits_audio: bool = True


@dataclass(frozen=True)
class VideoRuntime:
    """The resolved generation target for one run."""

    connection_id: str
    connection_name: str
    # The *served* name, which is what the gateway routes on — never a recipe id.
    model: str
    # Which body shape to build (one of :data:`SCHEMAS`).
    request_schema: str = SCHEMA_MINIMAX_H3
    constraints: VideoConstraints = field(default_factory=VideoConstraints)
    # True when the profile was missing and the model was recognised by identity.
    # Surfaced so the operator can see the difference between "declared" and
    # "assumed" rather than having to infer it from a log line.
    assumed: bool = False


def _range(profile: dict[str, Any], key: str) -> tuple[float, float] | None:
    """A ``{min, max}`` block from a profile, or ``None`` if unusable."""
    raw = profile.get(key)
    if not isinstance(raw, dict):
        return None
    try:
        low = float(raw["min"])
        high = float(raw["max"])
    except (KeyError, TypeError, ValueError):
        return None
    return (low, high) if low <= high else None


def constraints_from_profile(profile: dict[str, Any]) -> VideoConstraints:
    """Read a recipe's ``video_profile`` into constraints.

    Every field is optional and falls back to leaving that knob *unconstrained*
    rather than to H3's value — a profile that says nothing about duration must not
    silently inherit 4-15 s from a different model. The exception is
    ``seconds_per_step``, which only feeds an estimate: a wrong estimate is a worse
    message, not a wrong request.
    """
    ratios = profile.get("aspect_ratios")
    sizes = profile.get("sizes")
    duration = _range(profile, "duration_seconds")
    steps = _range(profile, "num_inference_steps")
    short_edge = profile.get("short_edge")
    try:
        seconds_per_step = int(float(profile.get("seconds_per_step") or 0)) or 44
    except (TypeError, ValueError):
        seconds_per_step = 44

    return VideoConstraints(
        short_edge=int(short_edge) if isinstance(short_edge, (int, float)) else None,
        aspect_ratios=tuple(str(r) for r in ratios if isinstance(r, str))
        if isinstance(ratios, list)
        else (),
        sizes={str(k): str(v) for k, v in sizes.items()}
        if isinstance(sizes, dict)
        else {},
        # 0/inf rather than H3's numbers: unconstrained, so the engine stays the
        # authority for a model whose operator did not narrow it.
        min_duration_seconds=duration[0] if duration else 0.0,
        max_duration_seconds=duration[1] if duration else float("inf"),
        min_steps=int(steps[0]) if steps else 1,
        max_steps=int(steps[1]) if steps else 1000,
        seconds_per_step=seconds_per_step,
        keyframes=bool(profile.get("keyframes")),
        emits_audio=bool(profile.get("audio")),
    )


def _looks_like_h3(model: VideoServedModel) -> bool:
    """Whether an unprofiled model is MiniMax-H3 (resolution step 2)."""
    if model.model_id.strip().lower() in _H3_MODEL_IDS:
        return True
    return _H3_NAME_HINT in f"{model.recipe_id} {model.served_name}".lower()


def _resolve_model(
    conn: LaiosConnection, model: VideoServedModel
) -> VideoRuntime | None:
    """Turn one served model into a runtime, or explain why we cannot drive it."""
    profile = model.profile
    if profile:
        schema = str(profile.get("request_schema") or "").strip()
        if schema in SCHEMAS:
            return VideoRuntime(
                connection_id=conn.id,
                connection_name=conn.name,
                model=model.served_name,
                request_schema=schema,
                constraints=constraints_from_profile(profile),
            )
        logger.info(
            "video model %r on %r declares request_schema %r, which this build "
            "cannot drive; offering no video tools for it",
            model.served_name,
            conn.name,
            schema or "(missing)",
        )
        return None

    if _looks_like_h3(model):
        # No profile, but we know this one from measurement. Everything else with no
        # profile is undeclared, and guessing is what produces a silently wrong clip.
        return VideoRuntime(
            connection_id=conn.id,
            connection_name=conn.name,
            model=model.served_name,
            request_schema=SCHEMA_MINIMAX_H3,
            constraints=VideoConstraints(),
            assumed=True,
        )

    logger.info(
        "video model %r on %r declares no video_profile and is not one this build "
        "recognises; offering no video tools for it (see "
        "docs/upstream/laios-video-profile.patch)",
        model.served_name,
        conn.name,
    )
    return None


async def _video_models(conn: LaiosConnection) -> tuple[VideoServedModel, ...]:
    """Cached ``video_served_models`` for one connection."""
    now = time.monotonic()
    cached = _served_cache.get(conn.id)
    if cached is not None and now - cached[1] < _CACHE_TTL_SECONDS:
        return cached[0]
    models = tuple(await video_served_models(conn))
    _served_cache[conn.id] = (models, now)
    return models


def reset_video_model_cache() -> None:
    """Drop the served-model cache. For tests, and for a forced re-resolve."""
    _served_cache.clear()


async def load_video_runtime(
    session: AsyncSession, *, include_video: bool
) -> VideoRuntime | None:
    """Resolve the connection, model and request shape this run's tools would use.

    ``include_video=False`` (the agent's flag) short-circuits before any network
    call, which is why the default-off flag costs nothing for every other agent.
    """
    if not include_video:
        return None
    return (await resolve_video_target(session))[0]


async def resolve_video_target(
    session: AsyncSession,
) -> tuple[VideoRuntime | None, str]:
    """The runtime plus a sentence saying why, for surfaces that must explain.

    Same resolution as :func:`load_video_runtime` (and the same cache), but it also
    answers "why not" — which the agent editor needs, because a checkbox that
    silently does nothing is indistinguishable from a broken one.
    """
    result = await session.execute(
        select(LaiosConnection).order_by(LaiosConnection.created_at)
    )
    connections = list(result.scalars().all())
    if not connections:
        return None, "no laios connection is configured"

    saw_video_model = False
    for conn in connections:
        for model in await _video_models(conn):
            saw_video_model = True
            runtime = _resolve_model(conn, model)
            if runtime is None:
                continue
            how = (
                "assumed from its identity"
                if runtime.assumed
                else f"declared as {runtime.request_schema}"
            )
            logger.info(
                "video tools resolved to %r on %r (%s)",
                runtime.model,
                conn.name,
                how,
            )
            return runtime, f"{runtime.model} on {conn.name} ({how})"

    if saw_video_model:
        return None, (
            "a connected box is serving a video model, but it does not declare a "
            "request shape this build can drive"
        )
    return None, "no connected box is serving a video model"


def with_constraints(runtime: VideoRuntime, **overrides: Any) -> VideoRuntime:
    """A copy of ``runtime`` with some constraints replaced. For tests."""
    return replace(runtime, constraints=replace(runtime.constraints, **overrides))
