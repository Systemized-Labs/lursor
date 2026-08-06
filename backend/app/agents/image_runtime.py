"""Which boxes generate this run's images, what they cost, and which to reach for.

``build_deep_agent`` is synchronous, but deciding whether an agent gets the image
tool needs a session (the connection rows) *and* the network (what each box is
actually serving). So the async work happens here, once, and the result is handed to
the builder as a single value — the same shape as
:class:`~app.agents.video_runtime.VideoRuntime` and
:class:`~app.agents.skill_runtime.SkillRuntime`.

``None`` means "build without the image tool": the agent's ``include_image`` flag is
off, there is no laios connection, or nothing connected is serving an image model.

**Two deliberate differences from ``video_runtime.py``**, and both are worth the
words because this module otherwise reads as its copy.

*It resolves a set, not a target.* Video resolves to one model because "can we drive
this at all" is a binary question with one right answer. Here every image model
speaks the same ``/v1/images/generations`` surface, and the choice between them is a
real cost/quality tradeoff the agent is better placed to make than this resolver:
``z-image-turbo`` is ~6.5 s an image, ``qwen-image-2512`` is 58-116 s and renders the
best open-weight glyphs. So the runtime carries every serving model plus a default,
and ``generate_image`` takes an optional ``model``. Constraints move down onto
:class:`ImageProfile`, per candidate rather than per runtime.

*It fails open.* Video fails closed because the request *shape* is per-model: SGLang's
``lower_video_request_kwargs`` silently discards fields it does not recognise and
returns HTTP 200, so an unclassified box burns minutes of GPU producing a clip of the
wrong length with its conditioning ignored. That failure mode does not exist here.
Both known recipes take the same fields and only the sensible *values* differ, so an
unrecognised image model still gets the tool — with :data:`GENERIC_PROFILE`:
conservative steps, no guidance fields (an omitted field cannot be rejected, a
wrongly-sent one can), and **no** time estimate rather than a confident wrong one.
Video's worst case was a silently wrong render; this one's is a mediocre default. That
asymmetry is the whole argument, and it is the same conclusion the frontend reached at
``frontend/src/pages/image/image-settings.ts:12-33``.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.api.laios import ServedModel, image_served_models
from app.db.models import LaiosConnection

logger = logging.getLogger(__name__)

# How long a box's answer to "what are you serving" is reused. Resolution costs a
# control-plane round trip per connection and happens on every turn of an
# image-enabled agent, so an unreachable box would add its 5 s timeout to each one.
# Mirrors ``video_runtime._CACHE_TTL_SECONDS`` for the same reasons; the two caches
# are separate, which costs one extra ``/v1/models`` per box per window for an agent
# with both capabilities on.
_CACHE_TTL_SECONDS = 300.0

# connection id -> (models, when we asked)
_served_cache: dict[str, tuple[tuple[ServedModel, ...], float]] = {}


@dataclass(frozen=True)
class ImageProfile:
    """What a given image model costs and which knobs it actually has.

    The backend half of ``frontend/src/pages/image/image-settings.ts:69-126``, which
    is where the argument for a table (rather than video's declared profile block)
    is written out. Every number is measured on a DGX Spark GB10 at 1024x1024 and
    recorded in laios's ``docs/inference-matrix.md``, not derived from parameter
    counts.

    Two copies of the same table is a real cost, and the reason it is paid rather
    than served from one place is that the two have different jobs: the frontend's
    drives sliders and tick labels, this one drives validation ranges and a tool
    docstring. The one field where drift produces a wrong *request* rather than a
    worse estimate is :attr:`guidance` — see ``image_tools._guidance_fields``.
    """

    # Matched as a substring of the lowercased served name.
    match: str
    label: str
    default_steps: int
    min_steps: int
    max_steps: int
    # Measured wall clock per denoise step with the model's default guidance. None
    # for an unknown model: no estimate at all is honest, a made-up one is trusted.
    seconds_per_step: float | None = None
    # Per step with CFG off, where the model can do that — roughly half, because
    # guidance runs the transformer twice per step.
    seconds_per_step_no_guidance: float | None = None
    # Whether guidance is a knob here at all. The engine turns CFG on when
    # ``true_cfg_scale > 1`` *and* ``negative_prompt is not None``, and Qwen's
    # sampling defaults set ``negative_prompt`` to " " — a space, which is not None
    # — so CFG is on by default there and doubles the cost. Z-Image defaults it to
    # None and is CFG-distilled, so sending guidance fields at all would switch on
    # something the checkpoint does not want.
    guidance: bool = False
    # One line for the tool docstring: what this model is for.
    note: str = ""


Z_IMAGE = ImageProfile(
    match="z-image",
    label="Z-Image-Turbo",
    # Step-distilled to 9. Raising it is not obviously better on a turbo checkpoint,
    # so the range is tight rather than spanning to Qwen's 50.
    default_steps=9,
    min_steps=4,
    max_steps=20,
    seconds_per_step=0.72,
    guidance=False,
    note="6B, step-distilled to 9 — about 7 seconds an image. The right default "
    "for everything except exact glyphs.",
)

QWEN_IMAGE = ImageProfile(
    match="qwen-image",
    label="Qwen-Image-2512",
    default_steps=25,
    min_steps=10,
    max_steps=50,
    # 58s at 25 steps and 116s at 50, measured — ~2.3 s/step with CFG on.
    seconds_per_step=2.3,
    seconds_per_step_no_guidance=1.16,
    guidance=True,
    note="20B with the best open-weight text rendering — but 1-2 minutes an image, "
    "and guidance doubles it. Worth it when the words in the picture must be right.",
)

IMAGE_PROFILES: tuple[ImageProfile, ...] = (Z_IMAGE, QWEN_IMAGE)

# The fallback for a served name that matches no profile. Reachable two ways: a new
# ``capabilities: [image]`` recipe this build predates, or a box whose control plane
# is not published through the tunnel. Both want the same thing — the request shape
# both known models share, no cost claim, and no guidance fields.
GENERIC_PROFILE = ImageProfile(
    match="",
    label="Unknown image model",
    default_steps=20,
    min_steps=1,
    max_steps=50,
    seconds_per_step=None,
    guidance=False,
    note="Not a model this build has measured — steps and size are relayed as sent, "
    "with no time estimate.",
)


def profile_for(model: str) -> ImageProfile:
    """The profile for a served name, or :data:`GENERIC_PROFILE`.

    Mirrors ``image-settings.ts:128-134``: first substring match on the lowercased
    served name, since operators name an instance after its recipe.
    """
    name = (model or "").strip().lower()
    for profile in IMAGE_PROFILES:
        if profile.match in name:
            return profile
    return GENERIC_PROFILE


@dataclass(frozen=True)
class ImageModel:
    """One image model an agent could reach, and what it costs."""

    connection_id: str
    connection_name: str
    # The *served* name, which is what the gateway routes on — never a recipe id.
    model: str
    profile: ImageProfile

    @property
    def recognised(self) -> bool:
        """False when this build has no measurements for it (see fail-open above)."""
        return self.profile is not GENERIC_PROFILE

    def estimate_seconds(self, steps: int, guidance: bool) -> float | None:
        """Expected wall clock, or None for a model with no measurement."""
        per_step = self.profile.seconds_per_step
        if per_step is None:
            return None
        if not guidance and self.profile.seconds_per_step_no_guidance is not None:
            per_step = self.profile.seconds_per_step_no_guidance
        return steps * per_step


@dataclass(frozen=True)
class ImageRuntime:
    """Every serving image model across every connection, plus which one to use."""

    models: tuple[ImageModel, ...]
    default: ImageModel
    # True when at least one model was reached but none is one this build has
    # measured. Surfaced so the agent editor can say "this works, but untested"
    # rather than leaving the operator to infer it from a log line.
    assumed: bool = field(default=False)

    def find(self, name: str | None) -> ImageModel | None:
        """The model the agent named, matched leniently, or the default for None.

        Exact match on the served name first, then a unique substring — an operator
        serving ``qwen-image-2512`` should not punish an agent that asked for
        ``qwen-image``. An ambiguous substring resolves to nothing rather than to a
        guess, and the caller lists what is available.
        """
        wanted = (name or "").strip().lower()
        if not wanted:
            return self.default
        for candidate in self.models:
            if candidate.model.lower() == wanted:
                return candidate
        matches = [c for c in self.models if wanted in c.model.lower()]
        return matches[0] if len(matches) == 1 else None


def _cost_key(model: ImageModel) -> tuple[Any, ...]:
    """Sort key putting the cheapest known model first.

    An unmeasured model sorts last rather than free: unknown cost is not zero cost,
    and defaulting to one would quietly make the untested path the common one. Ties
    break alphabetically so the choice is stable across runs.
    """
    per_step = model.profile.seconds_per_step
    return (
        per_step is None,
        model.profile.default_steps * (per_step or 0.0),
        model.model,
    )


async def _image_models(conn: LaiosConnection) -> tuple[ServedModel, ...]:
    """Cached :func:`image_served_models` for one connection."""
    now = time.monotonic()
    cached = _served_cache.get(conn.id)
    if cached is not None and now - cached[1] < _CACHE_TTL_SECONDS:
        return cached[0]
    models = tuple(await image_served_models(conn))
    _served_cache[conn.id] = (models, now)
    return models


def reset_image_model_cache() -> None:
    """Drop the served-model cache. For tests, and for a forced re-resolve."""
    _served_cache.clear()


async def load_image_runtime(
    session: AsyncSession, *, include_image: bool
) -> ImageRuntime | None:
    """Resolve the image models this run's tool could use.

    ``include_image=False`` (the agent's flag) short-circuits before any network
    call, which is why the default-off flag costs nothing for every other agent.
    """
    if not include_image:
        return None
    return (await resolve_image_target(session))[0]


async def resolve_image_target(
    session: AsyncSession,
) -> tuple[ImageRuntime | None, str]:
    """The runtime plus a sentence saying why, for surfaces that must explain.

    Same resolution as :func:`load_image_runtime` (and the same cache), but it also
    answers "why not" — which the agent editor needs, because a checkbox that
    silently does nothing is indistinguishable from a broken one.
    """
    result = await session.execute(
        select(LaiosConnection).order_by(LaiosConnection.created_at)
    )
    connections = list(result.scalars().all())
    if not connections:
        return None, "no laios connection is configured"

    found: list[ImageModel] = []
    for conn in connections:
        for served in await _image_models(conn):
            found.append(
                ImageModel(
                    connection_id=conn.id,
                    connection_name=conn.name,
                    model=served.served_name,
                    profile=profile_for(served.served_name),
                )
            )

    if not found:
        return None, "no connected box is serving an image model"

    ordered = tuple(sorted(found, key=_cost_key))
    default = ordered[0]
    runtime = ImageRuntime(
        models=ordered,
        default=default,
        assumed=not any(m.recognised for m in ordered),
    )

    logger.info(
        "image tools resolved to %r on %r (%d model(s) available%s)",
        default.model,
        default.connection_name,
        len(ordered),
        ", none measured by this build" if runtime.assumed else "",
    )

    reason = f"{default.model} on {default.connection_name}"
    if len(ordered) > 1:
        reason += f" (+{len(ordered) - 1} more)"
    if not default.recognised:
        reason += ", which this build has no measurements for"
    return runtime, reason
