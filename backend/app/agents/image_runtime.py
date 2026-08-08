"""Which models generate this run's images, what they cost, and which to reach for.

``build_deep_agent`` is synchronous, but deciding whether an agent gets the image
tool needs a session (the connection rows and the app's source setting) *and* the
network (what each box is actually serving, or what OpenRouter offers). So the
async work happens here, once, and the result is handed to the builder as a single
value — the same shape as :class:`~app.agents.video_runtime.VideoRuntime` and
:class:`~app.agents.skill_runtime.SkillRuntime`.

``None`` means "build without the image tool": the agent's ``include_image`` flag is
off, or the configured source cannot serve.

**The source never falls back.** ``AppConfig.image_source`` picks laios, OpenRouter
or one custom provider, and a run resolves within that source or not at all — even
when another is sitting right there and working. Silently crossing would be worse
than failing in every direction: onto OpenRouter it spends money nobody authorised,
and onto a box (or someone's own endpoint) it quietly swaps a chosen model for a
different one. So every "no" here comes with a sentence, and the sentence names the
source, or the empty picker reads as a bug rather than a choice.

**The third source is a custom provider** — the same OpenAI-compatible base URL the
chat picker routes to (:class:`~app.db.models.CustomProvider`). It resolves exactly
like laios, because it *is* the laios shape with a different endpoint: the same
``/v1/images/generations`` surface, the same absence of published measurements, so
the same :class:`ImageProfile` table and the same fail-open default. What differs is
only how its models are found, which is ``app/media/custom.py``'s problem.

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
from app.db.models import AppConfig, LaiosConnection
from app.media import custom as custom_media
from app.media import openrouter as openrouter_media
from app.media import refs
from app.media.custom import CustomMediaModel
from app.media.history import observed_image_costs
from app.media.openrouter import ORImageModel, PriceQuote

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
    """One image model an agent could reach, and what it costs.

    Covers all three sources. A laios model carries a :class:`ImageProfile` (this
    build's own measurements, since a box publishes none) and a connection; an
    OpenRouter model carries the catalogue entry it came from (which *is* its
    declaration) and no connection; a custom-provider model carries both a profile
    (its endpoint publishes no measurements either) and the
    :class:`~app.media.custom.CustomMediaModel` that says how it was classified.
    ``provider`` says which.
    """

    connection_id: str
    connection_name: str
    # The *served* name for laios (what the gateway routes on — never a recipe id),
    # the model slug for OpenRouter, or the id a custom endpoint answers to.
    model: str
    # Positional third-after-model so that ``ImageModel(cid, name, served, profile)``
    # — the laios shape this class had before OpenRouter existed — still reads.
    profile: ImageProfile | None = None
    provider: str = refs.LAIOS
    catalogue: ORImageModel | None = None
    # The classification, on the custom path. Carries whether the endpoint declared
    # this model's modality or we matched it by name — a caveat the picker has to
    # be able to state, since a name match can be wrong.
    custom: CustomMediaModel | None = None
    # Mean USD this install has actually paid per image on this model, over its
    # completed runs. The fallback price for an OpenRouter model that OpenRouter
    # bills per output token, which publishes no rate a picker can state (see
    # ``app/media/history.py``); always None on laios, which bills in electricity
    # and reports no number.
    observed_cost: float | None = None

    @property
    def ref(self) -> str:
        """The stable id for this model across both sources."""
        return refs.format_model_ref(self.provider, self.model, self.connection_id)

    @property
    def source(self) -> str:
        """The source ref to submit against."""
        return refs.format_source(self.provider, self.connection_id)

    @property
    def is_openrouter(self) -> bool:
        return self.provider == refs.OPENROUTER

    @property
    def is_custom(self) -> bool:
        return self.provider == refs.CUSTOM

    @property
    def label(self) -> str:
        if self.catalogue is not None:
            return self.catalogue.label
        if self.custom is not None:
            return self.custom.label
        return self.profile.label if self.profile else self.model

    @property
    def note(self) -> str:
        if self.catalogue is not None:
            return self.catalogue.note
        if self.custom is not None:
            # Both halves, and in this order: how we know this is an image model at
            # all comes before what it is expected to cost, because the first is
            # the one that can be wrong.
            measured = self.profile.note if self.recognised and self.profile else ""
            return f"{self.custom.note} {measured}".strip()
        return self.profile.note if self.profile else ""

    @property
    def price(self) -> PriceQuote | None:
        """What one image costs, when there is an honest number for it.

        The catalogue's published rate first. It is a quote rather than a
        retrospective average, it is true before this install has ever run the
        model, and it is the same number for everyone — so a fresh install gets a
        priced picker instead of forty blank rows.

        What this install has paid is the fallback, for the models OpenRouter
        bills per output token and therefore quotes no per-image rate for (see
        ``app/media/openrouter``). :attr:`price_source` says which of the two a
        caller is holding, because they do not mean the same thing.
        """
        if self.catalogue is not None and self.catalogue.price is not None:
            return self.catalogue.price
        if self.observed_cost is None:
            return None
        return PriceQuote(amount=self.observed_cost, unit="image", approximate=True)

    @property
    def price_source(self) -> str:
        """``"catalogue"``, ``"observed"``, or ``""`` — where :attr:`price` came from."""
        if self.catalogue is not None and self.catalogue.price is not None:
            return "catalogue"
        return "observed" if self.observed_cost is not None else ""

    @property
    def recognised(self) -> bool:
        """Whether this build knows how to size a request for it.

        For laios and a custom provider this is "we have measurements" (see the
        fail-open note above) — both serve the same ``/v1/images/generations``
        surface and publish nothing about how long a step takes. For OpenRouter it
        is always true: the catalogue states the model's own parameters, so there
        is nothing left to guess at.
        """
        if self.provider == refs.OPENROUTER:
            return True
        return self.profile is not None and self.profile is not GENERIC_PROFILE

    def estimate_seconds(self, steps: int, guidance: bool) -> float | None:
        """Expected wall clock, or None when there is no measurement.

        Always None on OpenRouter: a hosted render's latency is queue time plus
        someone else's hardware, and neither is knowable from here.
        """
        if self.profile is None:
            return None
        per_step = self.profile.seconds_per_step
        if per_step is None:
            return None
        if not guidance and self.profile.seconds_per_step_no_guidance is not None:
            per_step = self.profile.seconds_per_step_no_guidance
        return steps * per_step


@dataclass(frozen=True)
class ImageRuntime:
    """Every image model the configured source offers, plus which one to use."""

    models: tuple[ImageModel, ...]
    default: ImageModel
    # True when at least one model was reached but none is one this build has
    # measured. Surfaced so the agent editor can say "this works, but untested"
    # rather than leaving the operator to infer it from a log line. Never true on
    # OpenRouter, where the catalogue is the declaration.
    assumed: bool = field(default=False)
    # Which source resolved. Every model in ``models`` is on it — the resolver
    # never mixes the two.
    provider: str = refs.LAIOS
    # True when ``default`` is a model the user pinned in Settings rather than the
    # source's own cheapest. Surfaced so a summary can say "pinned" instead of
    # implying the resolver chose it.
    pinned: bool = False

    def find(self, name: str | None) -> ImageModel | None:
        """The model the agent named, matched leniently, or the default for None.

        Exact match on the served name (or slug) first, then a unique substring —
        an operator serving ``qwen-image-2512`` should not punish an agent that
        asked for ``qwen-image``, and neither should ``openai/gpt-image-2`` punish
        one that asked for ``gpt-image``. An ambiguous substring resolves to
        nothing rather than to a guess, and the caller lists what is available.

        A full ref (``openrouter:openai/gpt-image-2``) also matches, so the string
        stored in Settings can be handed straight back in.
        """
        wanted = (name or "").strip().lower()
        if not wanted:
            return self.default
        for candidate in self.models:
            if wanted in (candidate.model.lower(), candidate.ref.lower()):
                return candidate
        matches = [c for c in self.models if wanted in c.model.lower()]
        return matches[0] if len(matches) == 1 else None


def _cost_key(model: ImageModel) -> tuple[Any, ...]:
    """Sort key putting the cheapest known model first.

    An unmeasured model sorts last rather than free: unknown cost is not zero cost,
    and defaulting to one would quietly make the untested path the common one. Ties
    break alphabetically so the choice is stable across runs.

    The two sources measure different things — seconds of local GPU versus dollars
    — and they are never in the same list, so there is nothing to reconcile. What
    they share is the shape: a known cost, then an unknown one, then the name.
    """
    if model.provider == refs.OPENROUTER:
        # A published rate and a measured average are both dollars for one image,
        # and a per-megapixel rate is dollars for about one image at 1K — close
        # enough to order by, and the row states its own unit either way. What
        # would not be honest is calling an unpriced model the cheapest.
        quote = model.price
        return (quote is None, quote.amount if quote else 0.0, model.model)
    profile = model.profile or GENERIC_PROFILE
    per_step = profile.seconds_per_step
    return (
        per_step is None,
        profile.default_steps * (per_step or 0.0),
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


async def app_config(session: AsyncSession) -> AppConfig | None:
    """The single settings row, or None before anything has been saved."""
    return (await session.execute(select(AppConfig))).scalars().first()


async def resolve_image_target(
    session: AsyncSession,
) -> tuple[ImageRuntime | None, str]:
    """The runtime plus a sentence saying why, for surfaces that must explain.

    Same resolution as :func:`load_image_runtime` (and the same caches), but it
    also answers "why not" — which the agent editor and the Settings card both
    need, because a checkbox that silently does nothing is indistinguishable from
    a broken one.

    Branches on the configured source and stays inside it (see the module note).
    """
    cfg = await app_config(session)
    source = refs.parse_source(cfg.image_source if cfg else None)
    pinned = cfg.image_model if cfg else None

    if source.is_openrouter:
        found, unavailable = await _openrouter_models(session)
    elif source.is_custom:
        found, unavailable = await _custom_models(session, source.connection_id)
    else:
        found, unavailable = await _laios_models(session, source.connection_id)
    if unavailable is not None:
        return None, unavailable

    return _assemble(found, pinned, source.provider, "image")


async def _laios_models(
    session: AsyncSession, connection_id: str
) -> tuple[list[ImageModel], str | None]:
    """Every image model the connected boxes are serving."""
    query = select(LaiosConnection).order_by(LaiosConnection.created_at)
    if connection_id:
        query = query.where(LaiosConnection.id == connection_id)
    connections = list((await session.execute(query)).scalars().all())
    if not connections:
        return [], "no laios connection is configured"

    found = [
        ImageModel(
            connection_id=conn.id,
            connection_name=conn.name,
            model=served.served_name,
            provider=refs.LAIOS,
            profile=profile_for(served.served_name),
        )
        for conn in connections
        for served in await _image_models(conn)
    ]
    if not found:
        return [], (
            "LAIOS is the configured image source, but no connected box is serving "
            "an image model — serve one, or switch the source in Settings → "
            "Image & video"
        )
    return found, None


async def _custom_models(
    session: AsyncSession, provider_id: str
) -> tuple[list[ImageModel], str | None]:
    """Every image model the selected custom provider is classified as serving.

    The laios shape with a different endpoint: a custom provider publishes no
    measurements either, so its models get the same :class:`ImageProfile` lookup by
    name and the same fail-open default. What it does *not* share is how the models
    were found — see ``app/media/custom.py`` — so the reason sentence distinguishes
    "this endpoint has no images API" from "it has one but nothing looked like an
    image model", which want different things done about them.
    """
    providers = await custom_media.media_providers(session)
    if provider_id:
        providers = [p for p in providers if p.id == provider_id]
        if not providers:
            return [], (
                f"the configured custom image provider {provider_id!r} no longer "
                "exists — pick another in Settings → Image & video"
            )
    if not providers:
        return [], (
            "a custom provider is the configured image source, but none is "
            "configured — add one in Settings → Providers"
        )

    found: list[ImageModel] = []
    no_route: list[str] = []
    for provider in providers:
        entry = await custom_media.catalogue(provider)
        if custom_media.IMAGE in entry.missing_routes:
            no_route.append(provider.name)
        found.extend(
            ImageModel(
                connection_id=provider.id,
                connection_name=provider.name,
                model=model.id,
                provider=refs.CUSTOM,
                profile=profile_for(model.id),
                custom=model,
            )
            for model in entry.images
        )

    if not found:
        names = ", ".join(p.name for p in providers)
        if no_route:
            return [], (
                f"{', '.join(no_route)} does not serve an images API — its "
                "/images/generations route answered 404. Point the provider at an "
                "OpenAI-compatible image endpoint, or switch the source in "
                "Settings → Image & video"
            )
        return [], (
            f"{names} is the configured image source, but none of its models is "
            "one we can identify as an image model — add the model to the "
            "provider's model list as 'image:<model-id>', or switch the source in "
            "Settings → Image & video"
        )
    return found, None


async def _openrouter_models(
    session: AsyncSession,
) -> tuple[list[ImageModel], str | None]:
    """Every image model OpenRouter offers, at its rate or at what we have paid.

    Both numbers are gathered here even though only one is shown per model: the
    catalogue's rate rides on the entry, and the observed average is one indexed
    aggregate for the whole source, so fetching it for models that will not use it
    costs nothing extra.
    """
    if not openrouter_media.configured():
        return [], (
            "OpenRouter is the configured image source, but no OpenRouter API key "
            "is set — add one in Settings → Providers"
        )
    catalogue = await openrouter_media.image_models()
    if not catalogue:
        return [], (
            "OpenRouter is the configured image source, but its image catalogue "
            "could not be read. Nothing will run on a LAIOS box while OpenRouter "
            "is selected"
        )
    observed = await observed_image_costs(session, refs.OPENROUTER)
    return [
        ImageModel(
            connection_id="",
            connection_name="OpenRouter",
            model=entry.slug,
            provider=refs.OPENROUTER,
            catalogue=entry,
            observed_cost=observed.get(entry.slug),
        )
        for entry in catalogue
    ], None


def _assemble(
    found: list[ImageModel], pinned: str | None, provider: str, kind: str
) -> tuple[ImageRuntime | None, str]:
    """Order the candidates, honour the pin, and write the summary sentence.

    A pin that no longer resolves **fails** rather than quietly reverting to the
    cheapest. The pin is a decision about what to spend and what a result should
    look like, and swapping it for a different model without saying so is the same
    class of surprise as crossing sources. "Auto" is the setting for anyone who
    wants the resolver to choose.
    """
    ordered = tuple(sorted(found, key=_cost_key))
    default = ordered[0]

    if pinned:
        chosen = next((m for m in ordered if m.ref == pinned), None)
        if chosen is None:
            available = ", ".join(m.ref for m in ordered[:4]) or "nothing"
            return None, (
                f"the pinned {kind} model {pinned!r} is not available from "
                f"{provider} right now (offering: {available}) — pick another in "
                f"Settings → Image & video, or choose Auto"
            )
        default = chosen

    runtime = ImageRuntime(
        models=ordered,
        default=default,
        assumed=not any(m.recognised for m in ordered),
        provider=provider,
        pinned=bool(pinned),
    )

    logger.info(
        "%s tools resolved to %r on %r (%d model(s) available%s%s)",
        kind,
        default.model,
        default.connection_name,
        len(ordered),
        ", pinned" if runtime.pinned else "",
        ", none measured by this build" if runtime.assumed else "",
    )

    reason = f"{default.model} on {default.connection_name}"
    if runtime.pinned:
        reason += " (pinned)"
    if len(ordered) > 1:
        reason += f" (+{len(ordered) - 1} more)"
    if not default.recognised:
        reason += ", which this build has no measurements for"
    return runtime, reason
