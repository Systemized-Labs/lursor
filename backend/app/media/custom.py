"""Images and clips on a user-added OpenAI-compatible endpoint.

The third media source, alongside a laios box and OpenRouter. A
:class:`~app.db.models.CustomProvider` is already a base URL plus an optional key
that the chat side routes runs to (``api/models.py``, ``agents/builder.py``); this
module answers the two questions the media side additionally needs — *does this
endpoint generate images or clips at all*, and *which of its models do* — and hands
back a client for the ones that do.

**Why this needs a classifier and the other two sources do not.** A laios box
publishes ``capabilities: [image]`` per recipe and OpenRouter publishes separate
``/images/models`` and ``/videos/models`` catalogues, so both name their media
models outright. The OpenAI-compatible ``/models`` surface has no such field: it is
a list of ids and nothing else on a bare server. So the modality has to be
recovered, and it is recovered in three layers, most authoritative first:

1. **``GET /model/info``** — LiteLLM's own catalogue (which is what a laios
   gateway, Portkey and most self-hosted proxies front with). Every entry carries
   ``model_info.mode``, and ``image_generation`` / ``video_generation`` /
   ``chat`` are exactly the answer. When this responds, it *is* the classification
   — the name heuristics below are not consulted for a model it covered, in either
   direction.
2. **Fields on ``/models`` itself.** vLLM, LM Studio and OpenRouter-shaped proxies
   variously carry ``type``, ``mode``, ``modality`` (``"text->image"``),
   ``output_modalities`` or ``architecture.output_modalities``. Any of them is a
   declaration and is read as one.
3. **The model id.** Only for models the first two said nothing about. ``flux``,
   ``sdxl`` and ``wan2.2`` are how the weights are actually named, and a picker
   that showed nothing for an endpoint serving them would be wrong more often than
   this is. Models classified this way are marked ``declared=False`` so every
   surface can say "matched by name" rather than implying the endpoint claimed it.

**And one gate in front of all three.** Before any of it counts, the endpoint is
asked whether it has the route at all: a ``POST`` of ``{}`` to
``/images/generations`` (or ``/videos``) must fail, and *how* it fails is the
signal — ``404``/``405``/``501`` means there is no such API here, anything else
(``400``, ``422``, an auth challenge) means there is one and it rejected an empty
body, which is the correct behaviour. An empty body carries no model and no prompt,
so nothing can be generated and nothing can be billed by it. That gate is what
stops an Ollama install from offering ``llava`` as an image *generator* because the
name looked right.

Nothing is ever inferred by *running* a generation. A real request would cost GPU
time or money to answer a question about a picker, which is the same trade
``ImageProfile.seconds_per_step`` refuses when it declines to invent a measurement.

Cached for five minutes per provider, matching ``image_runtime._CACHE_TTL_SECONDS``
— classification costs up to four round trips and would otherwise run on every turn
of a media-enabled agent.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import CustomProvider

logger = logging.getLogger(__name__)

IMAGE = "image"
VIDEO = "video"

# Mirrors the two runtimes' served-model caches, for the same reason.
_CACHE_TTL_SECONDS = 300.0

# Classification is up to four requests against an endpoint that is usually on
# localhost but may be anywhere. Short, because it runs on the resolve path.
_PROBE_TIMEOUT = httpx.Timeout(5.0, connect=3.0)

# The generation calls themselves. An image request *is* the render, so it gets the
# same budget as ``api/images._GENERATE_TIMEOUT``; a video submit returns a job id.
_GENERATE_TIMEOUT = httpx.Timeout(600.0, connect=30.0)
_DEFAULT_TIMEOUT = httpx.Timeout(30.0)

# What each modality's route is, on the OpenAI-compatible surface both laios and
# OpenAI itself expose. Probed with an empty body; see the module docstring.
_ROUTES = {IMAGE: "/images/generations", VIDEO: "/videos"}

# Statuses that mean "there is no such API here". Everything else — including a
# 401 or a 429 — means the route exists and something other than its absence went
# wrong, which is not a reason to hide the modality.
_ABSENT = frozenset({404, 405, 501})

# ``model_info.mode`` values LiteLLM uses (layer 1).
_LITELLM_MODES = {
    "image_generation": IMAGE,
    "image_edit": IMAGE,
    "video_generation": VIDEO,
}

# Values that can appear in a ``type`` / ``mode`` / ``modality`` /
# ``output_modalities`` field on a ``/models`` entry (layer 2). Matched as a
# substring of the lowercased value, so ``"text->image"`` and ``"text_to_video"``
# both land.
_DECLARED_VIDEO = ("video",)
_DECLARED_IMAGE = ("image",)

# Layer 3: how the weights are actually named. Video first — ``hunyuan-video`` and
# ``stable-video-diffusion`` both contain an image hint further along, and the more
# specific family wins.
_VIDEO_HINTS = (
    "wan2",
    "wan-",
    "ltx",
    "hunyuan-video",
    "cogvideo",
    "mochi",
    "minimax-h3",
    "stable-video",
    "svd",
    "animatediff",
    "allegro",
    "veo",
    "sora",
    "seedance",
    "kling",
    "pika",
    "runway",
    "video",
)
_IMAGE_HINTS = (
    "flux",
    "stable-diffusion",
    "sdxl",
    "sd3",
    "sd-turbo",
    "z-image",
    "qwen-image",
    "imagen",
    "dall-e",
    "dalle",
    "gpt-image",
    "kandinsky",
    "playground-v",
    "pixart",
    "hidream",
    "seedream",
    "recraft",
    "ideogram",
    "chroma",
    "image",
)


@dataclass(frozen=True)
class CustomMediaModel:
    """One model a custom provider can generate with, and how we know.

    ``declared`` separates "the endpoint said this is an image model" from "the id
    looks like one". It is the same distinction ``VideoRuntime.assumed`` and
    ``ImageModel.recognised`` draw, and it exists so a picker can carry the caveat
    instead of stating a guess in the voice of a fact.
    """

    id: str
    label: str
    modality: str
    declared: bool = False

    @property
    def note(self) -> str:
        if self.declared:
            return "Declared by the endpoint."
        return (
            "Matched by name — this endpoint does not say which of its models "
            "generate media, so it may not accept this one."
        )


@dataclass(frozen=True)
class CustomCatalogue:
    """What one provider offers, per modality, plus why a modality is empty."""

    images: tuple[CustomMediaModel, ...] = ()
    videos: tuple[CustomMediaModel, ...] = ()
    # Set when the endpoint answered "no such route" for a modality. Distinct from
    # "the route exists but no model matched", because the two want different
    # advice and an empty picker has to explain itself either way.
    missing_routes: frozenset[str] = field(default_factory=frozenset)

    def for_modality(self, modality: str) -> tuple[CustomMediaModel, ...]:
        return self.images if modality == IMAGE else self.videos


# provider id -> (catalogue, when we asked)
_cache: dict[str, tuple[CustomCatalogue, float]] = {}


def reset_custom_media_cache() -> None:
    """Drop the classification cache. For tests, and after a provider is edited."""
    _cache.clear()


def base_url(provider: CustomProvider) -> str:
    return (provider.base_url or "").rstrip("/")


def _headers(provider: CustomProvider, *, json_body: bool = False) -> dict[str, str]:
    headers = {"Accept": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


def client(
    provider: CustomProvider, timeout: httpx.Timeout | None = None
) -> httpx.AsyncClient:
    """Client bound to this provider's OpenAI-compatible base.

    The same shape ``videos._gateway`` returns for a laios connection, so the two
    share every call below them — both are ``/v1``-rooted OpenAI-compatible
    origins, and the only difference is which credential opens them.
    """
    return httpx.AsyncClient(
        base_url=base_url(provider),
        headers=_headers(provider),
        timeout=timeout or _DEFAULT_TIMEOUT,
    )


def image_client(provider: CustomProvider) -> httpx.AsyncClient:
    """Client for the one call that actually waits on a GPU."""
    return client(provider, timeout=_GENERATE_TIMEOUT)


def download_client(
    provider: CustomProvider, url: str, timeout: httpx.Timeout | None = None
) -> httpx.AsyncClient:
    """Client for fetching a result the endpoint pointed at with an absolute URL.

    Carries the provider's key **only when the URL is on the provider's own
    origin**. A self-hosted server hands back a URL on itself and needs the header;
    anything else is a host the upstream named, and forwarding somebody's API key
    to an arbitrary host on an upstream's say-so is how a compromised or merely
    sloppy endpoint exfiltrates it.
    """
    origin = urlsplit(base_url(provider))
    target = urlsplit(url)
    same_origin = (origin.scheme, origin.netloc) == (target.scheme, target.netloc)
    headers = _headers(provider) if same_origin else {"Accept": "*/*"}
    return httpx.AsyncClient(
        headers=headers, timeout=timeout or _DEFAULT_TIMEOUT, follow_redirects=True
    )


async def media_providers(session: AsyncSession) -> list[CustomProvider]:
    """Custom providers eligible as a media source, oldest first.

    Excludes the ones a laios connection auto-manages. Those point at the same
    box's LiteLLM gateway, so offering them here would list every served image
    model twice — once under "LAIOS box" and once under a provider the user never
    created — and the two would submit to the same GPU by different routes.
    """
    from app.api.laios import managed_provider_ids

    managed = await managed_provider_ids(session)
    result = await session.execute(
        select(CustomProvider).order_by(CustomProvider.created_at)
    )
    return [p for p in result.scalars().all() if p.id not in managed and p.base_url]


async def load_provider(session: AsyncSession, provider_id: str) -> CustomProvider:
    """One provider by id, or a 400 naming what went wrong."""
    from fastapi import HTTPException, status

    provider = await session.get(CustomProvider, provider_id)
    if provider is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"no custom provider {provider_id!r} — it may have been deleted; "
            "pick another in Settings → Image & video",
        )
    if not base_url(provider):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"the custom provider {provider.name!r} has no base URL",
        )
    return provider


def _lower_strings(raw: Any) -> tuple[str, ...]:
    if isinstance(raw, str):
        return (raw.lower(),)
    if isinstance(raw, list):
        return tuple(str(v).lower() for v in raw if isinstance(v, (str, int, float)))
    return ()


def _declared_modality(entry: dict[str, Any]) -> str | None:
    """Layer 2 — a modality the ``/models`` entry states outright, or ``None``.

    Every key here is one a real OpenAI-compatible server puts a modality in. They
    are read together rather than in precedence order because no server sets more
    than one of them, and video is checked before image for the same reason the
    name hints are (``"text->video"`` says nothing about images, but a combined
    ``["image", "video"]`` list belongs to the more specific modality).
    """
    architecture = entry.get("architecture")
    values: list[str] = []
    for key in ("type", "mode", "modality", "output_modalities", "capabilities"):
        values.extend(_lower_strings(entry.get(key)))
    if isinstance(architecture, dict):
        values.extend(_lower_strings(architecture.get("output_modalities")))
    if not values:
        return None
    joined = " ".join(values)
    if any(hint in joined for hint in _DECLARED_VIDEO):
        return VIDEO
    if any(hint in joined for hint in _DECLARED_IMAGE):
        return IMAGE
    return None


def guess_modality(model_id: str) -> str | None:
    """Layer 3 — the modality a model id suggests, or ``None`` for "looks textual".

    Exported because the same question is worth answering in the provider form,
    where it can be shown as a suggestion rather than acted on.
    """
    name = (model_id or "").strip().lower()
    if not name:
        return None
    if any(hint in name for hint in _VIDEO_HINTS):
        return VIDEO
    if any(hint in name for hint in _IMAGE_HINTS):
        return IMAGE
    return None


async def _get(
    http: httpx.AsyncClient, path: str
) -> tuple[int | None, Any]:
    """GET a JSON body. ``(None, None)`` when the endpoint could not be reached."""
    try:
        resp = await http.get(path)
    except (httpx.TimeoutException, httpx.RequestError) as exc:
        logger.debug("custom media probe: %s unreachable: %s", path, exc)
        return None, None
    if resp.status_code >= 400:
        return resp.status_code, None
    try:
        return resp.status_code, resp.json()
    except ValueError:
        return resp.status_code, None


async def _route_exists(http: httpx.AsyncClient, modality: str) -> bool:
    """Whether this endpoint has the modality's API. See the module docstring.

    An unreachable endpoint answers ``True``: we did not learn that the route is
    absent, and hiding a modality on a network blip would look like the provider
    losing a capability it still has. The generation call reports the real problem.
    """
    try:
        resp = await http.post(_ROUTES[modality], json={})
    except (httpx.TimeoutException, httpx.RequestError):
        return True
    return resp.status_code not in _ABSENT


async def _catalogue_entries(http: httpx.AsyncClient) -> list[dict[str, Any]]:
    _, payload = await _get(http, "/models")
    data = payload.get("data") if isinstance(payload, dict) else None
    return [e for e in data if isinstance(e, dict)] if isinstance(data, list) else []


async def _litellm_modes(http: httpx.AsyncClient) -> dict[str, str]:
    """Layer 1 — ``model name -> modality`` from LiteLLM's ``/model/info``.

    Includes the models it calls ``chat``, mapped to ``""``. That empty string is
    load-bearing: it is what tells the classifier "this one was covered and is not
    media", so the name heuristics never get to overrule an endpoint that answered.
    """
    _, payload = await _get(http, "/model/info")
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        return {}
    modes: dict[str, str] = {}
    for entry in data:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("model_name") or "").strip()
        info = entry.get("model_info")
        if not name or not isinstance(info, dict):
            continue
        mode = str(info.get("mode") or "").strip().lower()
        modes[name] = _LITELLM_MODES.get(mode, "")
    return modes


async def _classify(provider: CustomProvider) -> CustomCatalogue:
    """Probe one provider and sort its models into modalities."""
    async with client(provider, timeout=_PROBE_TIMEOUT) as http:
        entries, modes, has_images, has_videos = await asyncio.gather(
            _catalogue_entries(http),
            _litellm_modes(http),
            _route_exists(http, IMAGE),
            _route_exists(http, VIDEO),
        )

    # Manually-listed ids are a fallback for an endpoint whose ``/models`` is not
    # readable, exactly as they are on the chat side — so they are folded in as
    # bare entries and classified by the same three layers.
    seen = {str(e.get("id") or "").strip() for e in entries}
    entries = entries + [
        {"id": model_id}
        for model_id in provider.manual_model_ids()
        if model_id not in seen
    ]

    # ``image:flux-dev`` on the provider — the operator's own declaration, and the
    # only thing here that outranks the endpoint's. It exists for the case the
    # three layers cannot cover (a server that publishes no modality serving a
    # model whose id says nothing), so deferring to a probe would defeat it.
    tagged = {model: modality for modality, model in provider.manual_media_models()}
    entries += [{"id": model_id} for model_id in tagged if model_id not in seen]

    images: list[CustomMediaModel] = []
    videos: list[CustomMediaModel] = []
    for entry in entries:
        model_id = str(entry.get("id") or "").strip()
        if not model_id:
            continue
        declared = True
        modality = tagged.get(model_id)
        if modality is None:
            modality = modes.get(model_id)
        if modality is None:
            modality = _declared_modality(entry)
        if modality is None:
            modality = guess_modality(model_id)
            declared = False
        if not modality:
            continue
        model = CustomMediaModel(
            id=model_id,
            label=str(entry.get("name") or model_id),
            modality=modality,
            declared=declared,
        )
        (images if modality == IMAGE else videos).append(model)

    # The route gate exists to stop a *heuristic* misfiring, so an operator who
    # tagged a model for a modality outranks it: they have said the endpoint does
    # this, and a probe that disagrees is the thing more likely to be wrong (a
    # gateway that only routes known paths, a proxy in front). Everything else the
    # gate still governs.
    has_images = has_images or any(m == IMAGE for m in tagged.values())
    has_videos = has_videos or any(m == VIDEO for m in tagged.values())

    missing = {m for m, ok in ((IMAGE, has_images), (VIDEO, has_videos)) if not ok}
    catalogue = CustomCatalogue(
        images=tuple(sorted(images, key=lambda m: m.id)) if has_images else (),
        videos=tuple(sorted(videos, key=lambda m: m.id)) if has_videos else (),
        missing_routes=frozenset(missing),
    )
    logger.info(
        "custom media provider %r: %d image model(s), %d video model(s)%s",
        provider.name,
        len(catalogue.images),
        len(catalogue.videos),
        f" (no {'/'.join(sorted(missing))} API)" if missing else "",
    )
    return catalogue


async def catalogue(provider: CustomProvider) -> CustomCatalogue:
    """What this provider serves, cached for :data:`_CACHE_TTL_SECONDS`."""
    now = time.monotonic()
    cached = _cache.get(provider.id)
    if cached is not None and now - cached[1] < _CACHE_TTL_SECONDS:
        return cached[0]
    result = await _classify(provider)
    _cache[provider.id] = (result, now)
    return result
