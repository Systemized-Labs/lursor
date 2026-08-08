"""The OpenRouter media client — catalogue parsing, caching, and error text.

The payloads below are trimmed copies of real responses from
``/api/v1/images/models``, ``/api/v1/images/models/{slug}/endpoints`` and
``/api/v1/videos/models``, keeping the shapes that actually caused design
decisions: an image model's list entry publishes ``supported_parameters`` as a
per-parameter type/values block and **no price**, its ``/endpoints`` payload
publishes a ``pricing`` array in one of three units (only two of which become a
price per image), and a video model publishes flat capability lists plus a
``pricing_skus`` map whose keys differ from provider to provider.

The property this file protects hardest is the failure behaviour. The configured
source never falls back to the other one, so a transient catalogue blip that
emptied the cache would read as "OpenRouter cannot generate images" and stop
generation entirely. Reusing the last good catalogue is what prevents that, and
it is the one thing here that is invisible until it breaks.
"""

from __future__ import annotations

import httpx
import pytest

from app.config import get_settings
from app.media import openrouter

IMAGE_PAYLOAD = {
    "data": [
        {
            "id": "openai/gpt-image-2",
            "name": "OpenAI: GPT Image 2",
            "description": "A model.\nSecond line that should not appear.",
            "architecture": {"output_modalities": ["image"]},
            "supported_parameters": {
                "quality": {"type": "enum", "values": ["low", "medium", "high"]},
                "aspect_ratio": {"type": "enum", "values": ["1:1", "16:9"]},
                "output_format": {"type": "enum", "values": ["png", "jpeg", "webp"]},
                "n": {"type": "range", "min": 1, "max": 4},
                "input_references": {"type": "range", "min": 0, "max": 3},
                "seed": {"type": "boolean"},
            },
        },
        {
            "id": "krea/krea-2-large",
            "name": "Krea: Krea 2 Large",
            "supported_parameters": {
                "resolution": {"type": "enum", "values": ["1K"]},
                "aspect_ratio": {"type": "enum", "values": ["1:1", "4:3"]},
            },
        },
        {"id": "black-forest-labs/flux.2-pro", "name": "BFL: FLUX.2 Pro"},
        {"id": "broken/no-endpoints", "name": "Broken"},
        # No id — must be skipped rather than becoming a blank row in the picker.
        {"name": "Nameless"},
    ]
}

# One ``/images/models/{slug}/endpoints`` payload per model above, covering each
# way OpenRouter quotes a generated image.
ENDPOINT_PAYLOADS = {
    # Per output token. There is no token count for a resolution nobody has picked,
    # so no per-image number can be stated up front.
    "openai/gpt-image-2": {
        "endpoints": [
            {
                "provider_slug": "openai",
                "pricing": [
                    {"billable": "input_text", "unit": "token", "cost_usd": 5e-06},
                    {"billable": "output_image", "unit": "token", "cost_usd": 3e-05},
                ],
            }
        ]
    },
    # A flat rate, quoted twice (two resolutions) and by two providers. The floor
    # is $0.03, and the spread is what makes it "from".
    "krea/krea-2-large": {
        "endpoints": [
            {
                "provider_slug": "krea",
                "pricing": [
                    # Sending a reference image is not the price of making one.
                    {"billable": "input_image", "unit": "image", "cost_usd": 0.001},
                    {
                        "billable": "output_image",
                        "unit": "image",
                        "cost_usd": 0.04,
                        "variant": "2k",
                    },
                    {
                        "billable": "output_image",
                        "unit": "image",
                        "cost_usd": 0.03,
                        "variant": "1k",
                    },
                ],
            },
            {
                "provider_slug": "krea-mirror",
                "pricing": [
                    {"billable": "output_image", "unit": "image", "cost_usd": 0.05}
                ],
            },
        ]
    },
    "black-forest-labs/flux.2-pro": {
        "endpoints": [
            {
                "provider_slug": "black-forest-labs",
                "pricing": [
                    {"billable": "output_image", "unit": "megapixel", "cost_usd": 0.03}
                ],
            }
        ]
    },
}

VIDEO_PAYLOAD = {
    "data": [
        {
            "id": "black-forest-labs/flux-3-video",
            "name": "Black Forest Labs: FLUX.3 Video",
            "description": "A video model.",
            "supported_resolutions": ["720p", "1080p"],
            "supported_aspect_ratios": ["16:9", "9:16"],
            "supported_sizes": None,
            "supported_durations": [5, 6, 7, 8],
            "supported_frame_images": ["first_frame", "last_frame"],
            "generate_audio": True,
            "seed": False,
            # Cents per second: 17 -> $0.17/s, 29 -> $0.29/s. The floor is 0.17.
            "pricing_skus": {
                "cents_per_second_output_720p": "17",
                "cents_per_second_output_1080p": "29",
            },
            "allowed_passthrough_parameters": ["safety_tolerance"],
        },
        {
            "id": "minimax/hailuo-3",
            "name": "MiniMax: H3",
            "supported_resolutions": ["2K"],
            "supported_aspect_ratios": ["16:9"],
            "supported_durations": [5, 10],
            "supported_frame_images": None,
            "generate_audio": True,
            # Dollars per second directly, plus a per-image key that is not a rate.
            "pricing_skus": {"duration_seconds": "0.13", "reference_images": "0.04"},
        },
        {
            "id": "opaque/tokens-only",
            "name": "Opaque",
            # Per-token pricing cannot become a per-second number.
            "pricing_skus": {"video_tokens": "0.0000056"},
        },
    ]
}


@pytest.fixture(autouse=True)
def fresh_catalogues():
    openrouter.reset_catalogues()
    yield
    openrouter.reset_catalogues()


@pytest.fixture
def key(monkeypatch):
    monkeypatch.setattr(get_settings(), "openrouter_api_key", "sk-or-test")


class _Transport(httpx.MockTransport):
    """Counts requests so the cache can be observed rather than assumed."""

    def __init__(self, handler):
        self.calls: list[httpx.Request] = []

        def wrapped(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            return handler(request)

        super().__init__(wrapped)


def _install(monkeypatch, handler) -> _Transport:
    """Point every client this module builds at ``handler``."""
    transport = _Transport(handler)
    original = httpx.AsyncClient.__init__

    def patched(self, *args, **kwargs):
        kwargs["transport"] = transport
        original(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched)
    return transport


def _json(payload, status: int = 200):
    return lambda request: httpx.Response(status, json=payload)


def _images(*, endpoints: bool = True):
    """The image catalogue plus its per-model price calls, routed by path.

    ``endpoints=False`` fails every price call, which is the realistic partial
    failure: the list is one request and the prices are forty more, so the sweep
    can fail on its own.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if not path.endswith("/endpoints"):
            return httpx.Response(200, json=IMAGE_PAYLOAD)
        if not endpoints:
            return httpx.Response(503, json={"error": {"message": "upstream down"}})
        slug = path.split("/images/models/", 1)[1].rsplit("/endpoints", 1)[0]
        payload = ENDPOINT_PAYLOADS.get(slug)
        if payload is None:
            return httpx.Response(404, json={"error": {"message": "no such model"}})
        return httpx.Response(200, json=payload)

    return handler


# --- Image catalogue ----------------------------------------------------------


async def test_image_models_parse_their_supported_parameters(monkeypatch, key):
    _install(monkeypatch, _images())
    models = await openrouter.image_models()

    assert [m.slug for m in models] == [
        "black-forest-labs/flux.2-pro",
        "broken/no-endpoints",
        "krea/krea-2-large",
        "openai/gpt-image-2",
    ]
    gpt = {m.slug: m for m in models}["openai/gpt-image-2"]
    assert gpt.label == "OpenAI: GPT Image 2"
    assert gpt.qualities == ("low", "medium", "high")
    assert gpt.aspect_ratios == ("1:1", "16:9")
    assert gpt.formats == ("png", "jpeg", "webp")
    assert gpt.seed is True
    assert gpt.max_reference_images == 3
    assert gpt.note == "A model."  # first line only


async def test_an_absent_parameter_is_empty_not_a_default(monkeypatch, key):
    """Empty means "this model does not take that knob", so the builder omits it."""
    _install(monkeypatch, _images())
    krea = {m.slug: m for m in await openrouter.image_models()}["krea/krea-2-large"]
    assert krea.qualities == ()
    assert krea.formats == ()
    assert krea.seed is False
    assert krea.resolutions == ("1K",)


async def test_no_key_means_no_catalogue_and_no_request(monkeypatch):
    monkeypatch.setattr(get_settings(), "openrouter_api_key", None)
    transport = _install(monkeypatch, _images())
    assert await openrouter.image_models() == ()
    assert transport.calls == []


# --- Image prices -------------------------------------------------------------


async def test_a_flat_rate_is_the_cheapest_of_its_variants(monkeypatch, key):
    """Two resolutions and two providers quote four numbers; the floor is the one."""
    _install(monkeypatch, _images())
    krea = {m.slug: m for m in await openrouter.image_models()}["krea/krea-2-large"]

    assert krea.price is not None
    assert krea.price.unit == "image"
    assert krea.price.amount == pytest.approx(0.03)
    assert krea.price.approximate is True  # more than one rate exists
    # The reference-image rate on the same endpoint is what it costs to *send* an
    # image, and counting it would have made the floor $0.001.
    assert krea.price.amount > 0.001


async def test_a_per_megapixel_rate_keeps_its_own_unit(monkeypatch, key):
    """Not multiplied out — that would assume a resolution nobody has picked."""
    _install(monkeypatch, _images())
    flux = {m.slug: m for m in await openrouter.image_models()}[
        "black-forest-labs/flux.2-pro"
    ]

    assert flux.price is not None
    assert flux.price.unit == "megapixel"
    assert flux.price.amount == pytest.approx(0.03)
    assert flux.price.approximate is False  # one rate, so it is a quote


async def test_a_token_priced_model_has_no_upfront_price(monkeypatch, key):
    """Per output token cannot become per image, and a guess would be worse."""
    _install(monkeypatch, _images())
    gpt = {m.slug: m for m in await openrouter.image_models()}["openai/gpt-image-2"]
    assert gpt.price is None


async def test_a_failed_price_call_costs_that_row_its_price_only(monkeypatch, key):
    _install(monkeypatch, _images())
    models = {m.slug: m for m in await openrouter.image_models()}

    assert models["broken/no-endpoints"].price is None  # its /endpoints 404s
    assert models["krea/krea-2-large"].price is not None  # the others still priced


async def test_the_whole_sweep_failing_leaves_the_catalogue_standing(monkeypatch, key):
    """An unpriced picker is a worse outcome than an empty one only in theory."""
    _install(monkeypatch, _images(endpoints=False))
    models = await openrouter.image_models()

    assert [m.slug for m in models] == [
        "black-forest-labs/flux.2-pro",
        "broken/no-endpoints",
        "krea/krea-2-large",
        "openai/gpt-image-2",
    ]
    assert all(m.price is None for m in models)


# --- Video catalogue ----------------------------------------------------------


async def test_video_models_parse_their_capabilities(monkeypatch, key):
    _install(monkeypatch, _json(VIDEO_PAYLOAD))
    models = {m.slug: m for m in await openrouter.video_models()}

    flux = models["black-forest-labs/flux-3-video"]
    assert flux.resolutions == ("720p", "1080p")
    assert flux.durations == (5.0, 6.0, 7.0, 8.0)
    assert flux.frame_images == ("first_frame", "last_frame")
    assert flux.keyframes is True
    assert flux.audio is True
    assert flux.passthrough == ("safety_tolerance",)
    # ``supported_sizes: null`` is a real value in this API, not a missing field.
    assert flux.sizes == ()

    assert models["minimax/hailuo-3"].keyframes is False


async def test_cents_and_dollars_both_become_a_per_second_rate(monkeypatch, key):
    _install(monkeypatch, _json(VIDEO_PAYLOAD))
    models = {m.slug: m for m in await openrouter.video_models()}

    flux = models["black-forest-labs/flux-3-video"].price
    assert flux is not None
    assert flux.unit == "second"
    assert flux.amount == pytest.approx(0.17)  # the 720p floor, not the 1080p rate
    assert flux.approximate is True  # more than one rate exists

    h3 = models["minimax/hailuo-3"].price
    assert h3 is not None
    assert h3.amount == pytest.approx(0.13)  # dollars already; the per-image key
    assert h3.approximate is False  # is not a rate and does not count


async def test_an_unparseable_price_is_none_not_zero(monkeypatch, key):
    """Unknown cost is not free — the same argument ``image_runtime`` already makes."""
    _install(monkeypatch, _json(VIDEO_PAYLOAD))
    models = {m.slug: m for m in await openrouter.video_models()}
    assert models["opaque/tokens-only"].price is None


# --- Caching ------------------------------------------------------------------


async def test_a_second_call_within_the_ttl_makes_no_request(monkeypatch, key):
    """The price sweep is behind the same cache — forty calls per period, not per view."""
    transport = _install(monkeypatch, _images())
    models = await openrouter.image_models()
    assert len(transport.calls) == 1 + len(models)  # the list, then one price each

    await openrouter.image_models()
    assert len(transport.calls) == 1 + len(models)


async def test_a_failed_refresh_reuses_the_last_good_catalogue(monkeypatch, key):
    """The no-fallback rule makes this load-bearing: an empty catalogue = no images."""
    _install(monkeypatch, _images())
    first = await openrouter.image_models()
    assert first

    _install(monkeypatch, _json({"error": {"message": "upstream down"}}, status=503))
    assert await openrouter.image_models(force_refresh=True) == first


async def test_the_first_fetch_failing_yields_an_empty_catalogue(monkeypatch, key):
    _install(monkeypatch, _json({"error": {"message": "nope"}}, status=500))
    assert await openrouter.image_models() == ()


# --- Generation ---------------------------------------------------------------


async def test_generate_image_returns_bytes_and_the_actual_cost(monkeypatch, key):
    import base64

    pixels = b"\x89PNG\r\n\x1a\nnot-really"
    _install(
        monkeypatch,
        _json(
            {
                "created": 1,
                "data": [
                    {
                        "b64_json": base64.b64encode(pixels).decode(),
                        "media_type": "image/png",
                    }
                ],
                "usage": {"cost": 0.031},
            }
        ),
    )
    result = await openrouter.generate_image({"model": "x/y", "prompt": "a cat"})
    assert result.data == pixels
    assert result.media_type == "image/png"
    assert result.cost_usd == pytest.approx(0.031)


async def test_generate_image_without_a_key_says_so(monkeypatch):
    monkeypatch.setattr(get_settings(), "openrouter_api_key", None)
    _install(monkeypatch, _json({}))
    with pytest.raises(openrouter.OpenRouterMediaError, match="no OpenRouter API key"):
        await openrouter.generate_image({"model": "x/y", "prompt": "a cat"})


async def test_an_empty_data_array_is_an_error_not_an_empty_image(monkeypatch, key):
    _install(monkeypatch, _json({"data": [], "usage": {"cost": 0.0}}))
    with pytest.raises(openrouter.OpenRouterMediaError, match="no image"):
        await openrouter.generate_image({"model": "x/y", "prompt": "a cat"})


async def test_submit_video_requires_an_id(monkeypatch, key):
    _install(monkeypatch, _json({"status": "pending"}, status=202))
    with pytest.raises(openrouter.OpenRouterMediaError, match="no id"):
        await openrouter.submit_video({"model": "x/y", "prompt": "a cat"})


async def test_submit_video_returns_the_job(monkeypatch, key):
    _install(
        monkeypatch,
        _json({"id": "abc", "status": "pending", "polling_url": "…"}, status=202),
    )
    assert (await openrouter.submit_video({"model": "x/y"}))["id"] == "abc"


async def test_download_rejects_an_empty_body(monkeypatch, key):
    _install(monkeypatch, lambda request: httpx.Response(200, content=b""))
    with pytest.raises(openrouter.OpenRouterMediaError, match="empty clip"):
        await openrouter.download("https://openrouter.ai/x")


# --- Error text ---------------------------------------------------------------


def test_error_detail_unwraps_the_nested_shape():
    resp = httpx.Response(
        400, json={"error": {"code": "invalid_size", "message": "bad size"}}
    )
    assert openrouter.error_detail(resp) == "bad size (code invalid_size)"


def test_error_detail_unwraps_a_flat_detail():
    assert openrouter.error_detail(httpx.Response(422, json={"detail": "nope"})) == "nope"


def test_error_detail_never_returns_a_stringified_dict():
    """An agent reading a raw dict cannot act on it; a sentence it can."""
    resp = httpx.Response(500, text="<html>gateway error</html>")
    detail = openrouter.error_detail(resp)
    assert detail and not detail.startswith("{")
