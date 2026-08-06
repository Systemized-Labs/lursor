"""OpenRouter's media APIs — the hosted alternative to a laios box.

The only module that talks to ``openrouter.ai`` for images and clips. Four
surfaces, and they are *not* the chat API:

* ``POST /images`` — **synchronous**. One call returns base64 bytes plus the
  exact USD it cost. Same shape as the laios image path, which is why
  ``api/images.py`` needs one branch and no new architecture.
* ``POST /videos`` — 202 with a job id, then ``GET /videos/{id}`` until
  ``completed``, then the bytes from ``unsigned_urls[0]``. Same shape as the
  laios video path, for the same reason.
* ``GET /images/models`` and ``GET /videos/models`` — capability catalogues.
  These replace the hand-measured ``ImageProfile`` table for hosted models: what
  a laios recipe has to declare in a ``video_profile`` block, OpenRouter publishes
  for every model.

The key comes from the live :class:`~app.config.Settings`, which
``api/settings._apply_key`` keeps current, so a key saved in the UI works without
a restart.

**Pricing is deliberately uneven, and that is the API's shape rather than an
omission here.**

* Video models publish ``pricing_skus``, so a rate per second of output is
  derivable and worth showing before someone spends it. The key set is wide and
  inconsistent (``cents_per_second_output``, ``duration_seconds_1080p``,
  ``text_to_video_duration_seconds_480p``, …) so :func:`_video_rate` takes the
  cheapest parseable per-second key and says "from".
* Image models publish **no price in the catalogue at all**. It lives behind a
  per-model ``/endpoints`` call, one request per model, and is quoted per
  *output token* — which cannot be turned into a price per image without knowing
  the token count a given resolution produces. So there is no upfront image
  price, and inventing one would be worse than none (the argument
  ``ImageProfile.seconds_per_step`` already makes for unmeasured models). What
  the UI shows instead is the exact ``usage.cost`` recorded on past runs of that
  model — see ``api/images.observed_costs``.

Both catalogues are cached like ``app/pricing.py``: 15 minutes, and **the last
good value is reused on a fetch failure**. That matters more here than it does
for pricing. The configured source never falls back to the other one, so a
transient blip that emptied the catalogue would read as "OpenRouter cannot serve
images" and stop generation entirely.
"""

from __future__ import annotations

import base64
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

# Matches ``pricing.py``. A catalogue changes when OpenRouter adds a model, which
# is not something anyone needs to see within the minute.
_CACHE_TTL_SECONDS = 15 * 60

# Listing models is quick. Submitting a video is a job creation, also quick — the
# render happens after the response. Only ``POST /images`` actually waits for a
# GPU, so it gets the generous one, sized like ``api/images._GENERATE_TIMEOUT``.
_CATALOGUE_TIMEOUT = httpx.Timeout(20.0, connect=10.0)
_SUBMIT_TIMEOUT = httpx.Timeout(60.0, connect=15.0)
_GENERATE_TIMEOUT = httpx.Timeout(600.0, connect=30.0)
_DOWNLOAD_TIMEOUT = httpx.Timeout(300.0, connect=30.0)


class OpenRouterMediaError(RuntimeError):
    """A failed call, carrying a message already fit to show a user or an agent."""


@dataclass(frozen=True)
class PriceQuote:
    """A rate, with the unit it is charged in.

    ``approximate`` marks a floor rather than a quote — video rates vary by
    resolution and by whether audio is on, and this is the cheapest of them.
    """

    amount: float
    unit: str  # "second" | "image"
    approximate: bool = False


@dataclass(frozen=True)
class ORImageModel:
    """One OpenRouter image model and the knobs it actually accepts.

    ``aspect_ratios`` / ``resolutions`` / ``qualities`` / ``formats`` come from the
    catalogue's ``supported_parameters`` block, and an empty tuple means "this
    model does not take that parameter" — so the request builder omits it rather
    than sending a default the model would reject.
    """

    slug: str
    label: str
    note: str = ""
    aspect_ratios: tuple[str, ...] = ()
    resolutions: tuple[str, ...] = ()
    qualities: tuple[str, ...] = ()
    formats: tuple[str, ...] = ()
    seed: bool = False
    max_reference_images: int = 0
    # Always None today: the catalogue carries no image price (see the module
    # docstring). Kept on the dataclass so the surfaces that render a price do not
    # need a second shape if OpenRouter starts publishing one.
    price: PriceQuote | None = None

    @property
    def supports(self) -> tuple[str, ...]:
        """The parameter names this model accepts, for a tool docstring."""
        names = []
        if self.aspect_ratios:
            names.append("aspect_ratio")
        if self.resolutions:
            names.append("resolution")
        if self.qualities:
            names.append("quality")
        if self.formats:
            names.append("output_format")
        if self.seed:
            names.append("seed")
        return tuple(names)


@dataclass(frozen=True)
class ORVideoModel:
    """One OpenRouter video model and the clip shapes it will produce."""

    slug: str
    label: str
    note: str = ""
    resolutions: tuple[str, ...] = ()
    aspect_ratios: tuple[str, ...] = ()
    sizes: tuple[str, ...] = ()
    # Discrete allowed lengths in seconds, not a range — OpenRouter publishes an
    # enumeration ([5, 6, …, 20]) and a model will reject anything off it.
    durations: tuple[float, ...] = ()
    frame_images: tuple[str, ...] = ()  # "first_frame" | "last_frame"
    audio: bool = False
    seed: bool = False
    passthrough: tuple[str, ...] = ()
    price: PriceQuote | None = None

    @property
    def keyframes(self) -> bool:
        return bool(self.frame_images)


# Module-level catalogue caches, in the shape ``pricing.py`` established.
_image_cache: tuple[ORImageModel, ...] | None = None
_image_fetched_at: float = 0.0
_video_cache: tuple[ORVideoModel, ...] | None = None
_video_fetched_at: float = 0.0


def reset_catalogues() -> None:
    """Drop both caches. For tests, and for a forced re-read after a key change."""
    global _image_cache, _image_fetched_at, _video_cache, _video_fetched_at
    _image_cache = None
    _image_fetched_at = 0.0
    _video_cache = None
    _video_fetched_at = 0.0


def configured() -> bool:
    """Whether there is a key to call with at all."""
    return bool(get_settings().openrouter_api_key)


def _base() -> str:
    return get_settings().openrouter_base_url.rstrip("/")


def _headers(*, json_body: bool = False) -> dict[str, str]:
    headers = {"Accept": "application/json"}
    key = get_settings().openrouter_api_key
    if key:
        headers["Authorization"] = f"Bearer {key}"
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


def error_detail(resp: httpx.Response) -> str:
    """One readable sentence from an error response.

    The sibling of ``api/videos.gateway_error_detail`` and kept separate from it
    on purpose: the two upstreams nest their messages differently, and a merged
    unwrapper would be a pile of guesses about which one it is looking at. What
    matters is the outcome — an agent or a run row gets a sentence, never a
    stringified dict.
    """
    try:
        payload = resp.json()
    except ValueError:
        text = (resp.text or "").strip()
        return text[:500] or f"HTTP {resp.status_code}"
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            message = str(error.get("message") or "").strip()
            code = error.get("code")
            if message:
                return f"{message} (code {code})" if code else message
        elif isinstance(error, str) and error.strip():
            return error.strip()
        detail = payload.get("detail")
        if isinstance(detail, str) and detail.strip():
            return detail.strip()
        if detail is not None:
            return str(detail)[:500]
    return f"HTTP {resp.status_code}"


def _require_key() -> None:
    if not configured():
        raise OpenRouterMediaError(
            "no OpenRouter API key is set — add one in Settings → Providers"
        )


def _enum(params: dict[str, Any], name: str) -> tuple[str, ...]:
    """The allowed values of an enum parameter, or ``()`` if absent."""
    entry = params.get(name)
    if not isinstance(entry, dict) or entry.get("type") != "enum":
        return ()
    values = entry.get("values")
    if not isinstance(values, list):
        return ()
    return tuple(str(v) for v in values if isinstance(v, (str, int, float)))


def _range_max(params: dict[str, Any], name: str) -> int:
    entry = params.get(name)
    if not isinstance(entry, dict) or entry.get("type") != "range":
        return 0
    try:
        return int(entry.get("max") or 0)
    except (TypeError, ValueError):
        return 0


def _flag(params: dict[str, Any], name: str) -> bool:
    entry = params.get(name)
    return isinstance(entry, dict) and entry.get("type") == "boolean"


def _strings(raw: Any) -> tuple[str, ...]:
    """A list-of-strings field that OpenRouter also spells as ``null``."""
    if not isinstance(raw, list):
        return ()
    return tuple(str(v) for v in raw if isinstance(v, (str, int, float)))


def _numbers(raw: Any) -> tuple[float, ...]:
    if not isinstance(raw, list):
        return ()
    out: list[float] = []
    for value in raw:
        try:
            out.append(float(value))
        except (TypeError, ValueError):
            continue
    return tuple(out)


def _first_line(text: Any, limit: int = 200) -> str:
    """A description trimmed to something that fits in a picker row."""
    body = str(text or "").strip().split("\n", 1)[0]
    return body[:limit].rstrip()


def _video_rate(skus: Any) -> PriceQuote | None:
    """The cheapest published per-second rate, or ``None`` if none parses.

    ``pricing_skus`` is an open map whose keys vary per provider, in two families:
    ``cents_per_second…`` / ``cents_per_video_output_second…`` (cents) and
    ``…duration_seconds…`` (dollars). Everything else — per-token rates, per
    reference image, a generation minimum — cannot become a per-second number and
    is skipped rather than guessed at.

    The cheapest is taken, not an average, because the keys describe alternative
    configurations (480p vs 1080p, audio on vs off) and the honest one-line
    summary of a spread is its floor. Callers render it as "from $X/s".
    """
    if not isinstance(skus, dict):
        return None
    rates: list[float] = []
    for key, raw in skus.items():
        name = str(key)
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if value <= 0:
            continue
        if "second" in name and name.startswith(("cents_per_second", "cents_per_video")):
            rates.append(value / 100.0)
        elif "duration_seconds" in name:
            rates.append(value)
    if not rates:
        return None
    return PriceQuote(amount=min(rates), unit="second", approximate=len(rates) > 1)


def _parse_image_models(payload: Any) -> tuple[ORImageModel, ...]:
    entries = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        return ()
    models: list[ORImageModel] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        slug = str(entry.get("id") or "").strip()
        if not slug:
            continue
        params = entry.get("supported_parameters")
        params = params if isinstance(params, dict) else {}
        models.append(
            ORImageModel(
                slug=slug,
                label=str(entry.get("name") or slug),
                note=_first_line(entry.get("description")),
                aspect_ratios=_enum(params, "aspect_ratio"),
                resolutions=_enum(params, "resolution"),
                qualities=_enum(params, "quality"),
                formats=_enum(params, "output_format"),
                seed=_flag(params, "seed"),
                max_reference_images=_range_max(params, "input_references"),
            )
        )
    return tuple(sorted(models, key=lambda m: m.slug))


def _parse_video_models(payload: Any) -> tuple[ORVideoModel, ...]:
    entries = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        return ()
    models: list[ORVideoModel] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        slug = str(entry.get("id") or "").strip()
        if not slug:
            continue
        models.append(
            ORVideoModel(
                slug=slug,
                label=str(entry.get("name") or slug),
                note=_first_line(entry.get("description")),
                resolutions=_strings(entry.get("supported_resolutions")),
                aspect_ratios=_strings(entry.get("supported_aspect_ratios")),
                sizes=_strings(entry.get("supported_sizes")),
                durations=_numbers(entry.get("supported_durations")),
                frame_images=_strings(entry.get("supported_frame_images")),
                audio=bool(entry.get("generate_audio")),
                seed=bool(entry.get("seed")),
                passthrough=_strings(entry.get("allowed_passthrough_parameters")),
                price=_video_rate(entry.get("pricing_skus")),
            )
        )
    return tuple(sorted(models, key=lambda m: m.slug))


async def _catalogue(path: str) -> Any | None:
    """GET a catalogue, or ``None`` on any failure (callers reuse last-good)."""
    try:
        async with httpx.AsyncClient(timeout=_CATALOGUE_TIMEOUT) as client:
            resp = await client.get(f"{_base()}{path}", headers=_headers())
            resp.raise_for_status()
            return resp.json()
    except (httpx.HTTPStatusError, httpx.RequestError, ValueError) as exc:
        logger.warning("openrouter media: %s fetch failed: %s", path, exc)
        return None


async def image_models(*, force_refresh: bool = False) -> tuple[ORImageModel, ...]:
    """Every image model OpenRouter serves. Empty when there is no key."""
    global _image_cache, _image_fetched_at
    if not configured():
        return ()
    now = time.monotonic()
    if (
        not force_refresh
        and _image_cache is not None
        and (now - _image_fetched_at) < _CACHE_TTL_SECONDS
    ):
        return _image_cache
    payload = await _catalogue("/images/models")
    if payload is None:
        return _image_cache if _image_cache is not None else ()
    _image_cache = _parse_image_models(payload)
    _image_fetched_at = now
    return _image_cache


async def video_models(*, force_refresh: bool = False) -> tuple[ORVideoModel, ...]:
    """Every video model OpenRouter serves. Empty when there is no key."""
    global _video_cache, _video_fetched_at
    if not configured():
        return ()
    now = time.monotonic()
    if (
        not force_refresh
        and _video_cache is not None
        and (now - _video_fetched_at) < _CACHE_TTL_SECONDS
    ):
        return _video_cache
    payload = await _catalogue("/videos/models")
    if payload is None:
        return _video_cache if _video_cache is not None else ()
    _video_cache = _parse_video_models(payload)
    _video_fetched_at = now
    return _video_cache


@dataclass(frozen=True)
class ImageResult:
    """One generated image: the bytes, what the provider called them, the cost."""

    data: bytes
    media_type: str = ""
    cost_usd: float | None = None
    raw: dict[str, Any] = field(default_factory=dict)


def _usage_cost(payload: Any) -> float | None:
    usage = payload.get("usage") if isinstance(payload, dict) else None
    if not isinstance(usage, dict):
        return None
    try:
        return float(usage["cost"])
    except (KeyError, TypeError, ValueError):
        return None


async def generate_image(body: dict[str, Any]) -> ImageResult:
    """``POST /images`` and wait for the pixels.

    Synchronous, like the laios image path — so the caller's "who waits" story
    (a detached task holding the call open, the row polled by the page) needs no
    change. ``usage.cost`` is the *actual* charge, not an estimate, which is why
    it is worth a column even though nothing quotes a price up front.
    """
    _require_key()
    async with httpx.AsyncClient(timeout=_GENERATE_TIMEOUT) as client:
        resp = await client.post(
            f"{_base()}/images", headers=_headers(json_body=True), json=body
        )
        if resp.status_code >= 400:
            raise OpenRouterMediaError(error_detail(resp))
        try:
            payload = resp.json()
        except ValueError as exc:
            raise OpenRouterMediaError(
                "OpenRouter returned a response that is not JSON"
            ) from exc

    entries = payload.get("data") if isinstance(payload, dict) else None
    first = entries[0] if isinstance(entries, list) and entries else None
    if not isinstance(first, dict):
        raise OpenRouterMediaError("OpenRouter returned no image")
    encoded = first.get("b64_json")
    if not isinstance(encoded, str) or not encoded:
        raise OpenRouterMediaError("OpenRouter returned an image with no data")
    try:
        data = base64.b64decode(encoded, validate=False)
    except (ValueError, TypeError) as exc:
        raise OpenRouterMediaError("OpenRouter returned undecodable image data") from exc
    if not data:
        raise OpenRouterMediaError("OpenRouter returned an empty image")

    return ImageResult(
        data=data,
        media_type=str(first.get("media_type") or ""),
        cost_usd=_usage_cost(payload),
        raw=payload if isinstance(payload, dict) else {},
    )


async def submit_video(body: dict[str, Any]) -> dict[str, Any]:
    """``POST /videos``. Returns the 202 payload (``id``, ``status``)."""
    _require_key()
    async with httpx.AsyncClient(timeout=_SUBMIT_TIMEOUT) as client:
        resp = await client.post(
            f"{_base()}/videos", headers=_headers(json_body=True), json=body
        )
        if resp.status_code >= 400:
            raise OpenRouterMediaError(error_detail(resp))
        try:
            payload = resp.json()
        except ValueError as exc:
            raise OpenRouterMediaError(
                "OpenRouter returned a response that is not JSON"
            ) from exc
    if not isinstance(payload, dict) or not payload.get("id"):
        raise OpenRouterMediaError("OpenRouter accepted the job but returned no id")
    return payload


async def poll_video(video_id: str) -> dict[str, Any]:
    """``GET /videos/{id}``. Returns the job payload as sent."""
    _require_key()
    async with httpx.AsyncClient(timeout=_SUBMIT_TIMEOUT) as client:
        resp = await client.get(f"{_base()}/videos/{video_id}", headers=_headers())
        if resp.status_code >= 400:
            raise OpenRouterMediaError(error_detail(resp))
        try:
            payload = resp.json()
        except ValueError as exc:
            raise OpenRouterMediaError(
                "OpenRouter returned a response that is not JSON"
            ) from exc
    return payload if isinstance(payload, dict) else {}


async def download(url: str) -> tuple[bytes, str]:
    """Fetch a finished clip's bytes and its reported content type.

    The URL comes from ``unsigned_urls[0]`` and **expires**, which is why callers
    pull the bytes on the poll that first sees ``completed`` rather than waiting
    for someone to ask for them.
    """
    _require_key()
    async with httpx.AsyncClient(
        timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True
    ) as client:
        resp = await client.get(url, headers=_headers())
        if resp.status_code >= 400:
            raise OpenRouterMediaError(error_detail(resp))
        data = resp.content
    if not data:
        raise OpenRouterMediaError("OpenRouter returned an empty clip")
    return data, resp.headers.get("content-type", "")
