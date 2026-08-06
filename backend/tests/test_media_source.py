"""The source setting decides where generation happens, and never falls back.

This is the property the whole feature rests on, and it is the one that is silent
when it breaks. Both resolvers used to answer one question — "is there a box
serving something we can drive" — and now they answer it *within* a chosen source.
If a resolver ever crossed sources, the two failure modes are:

* configured OpenRouter, resolved to a box — the user picked a specific hosted
  model and quietly got a local one, with different output and different licensing;
* configured laios, resolved to OpenRouter — the user's local box sat idle while
  their card was charged.

Neither raises. Both look like everything working. So the tests here are mostly
about what does **not** happen, and about the sentence that gets shown instead.

A pinned model that has gone missing fails for the same reason at one level down:
the pin is a decision about what to spend and what a result should look like, and
"Auto" already exists for anyone who wants the resolver to choose.
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import delete

from app.agents.image_runtime import reset_image_model_cache, resolve_image_target
from app.agents.video_runtime import (
    SCHEMA_OPENROUTER_VIDEO,
    reset_video_model_cache,
    resolve_video_target,
)
from app.config import get_settings
from app.db.models import AppConfig, LaiosConnection
from app.db.session import async_session_factory
from app.media import openrouter as openrouter_media
from app.media import refs

# A box that really is serving an image model, so "resolved to nothing" below is
# never just "there was nothing to resolve to".
Z_IMAGE = {
    "id": "z-image-turbo",
    "recipe_id": "z-image-turbo",
    "capabilities": ["image"],
    "served_model_name": "z-image-turbo",
    "running_instance": {"status": "running", "served_name": "z-image-turbo"},
}
H3 = {
    "id": "minimax-h3-fl2va",
    "recipe_id": "minimax-h3-fl2va",
    "model_id": "MiniMaxAI/MiniMax-H3",
    "capabilities": ["video"],
    "served_model_name": "minimax-h3",
    "running_instance": {"status": "running", "served_name": "minimax-h3"},
}

OR_IMAGES = {
    "data": [
        {
            "id": "openai/gpt-image-2",
            "name": "GPT Image 2",
            "supported_parameters": {
                "aspect_ratio": {"type": "enum", "values": ["1:1", "16:9"]}
            },
        },
        {
            "id": "google/gemini-2.5-flash-image",
            "name": "Gemini Flash Image",
            "supported_parameters": {
                "aspect_ratio": {"type": "enum", "values": ["1:1", "16:9"]}
            },
        },
    ]
}
OR_VIDEOS = {
    "data": [
        {
            "id": "google/veo-3.1",
            "name": "Veo 3.1",
            "supported_resolutions": ["720p"],
            "supported_aspect_ratios": ["16:9", "9:16"],
            "supported_durations": [4, 8],
            "supported_frame_images": ["first_frame"],
            "generate_audio": True,
            "pricing_skus": {"duration_seconds": "0.40"},
        },
        {
            "id": "bytedance/seedance-2.0",
            "name": "Seedance 2.0",
            "supported_aspect_ratios": ["16:9"],
            "supported_durations": [5],
            "generate_audio": False,
            "pricing_skus": {"duration_seconds": "0.10"},
        },
    ]
}

_REAL_ASYNC_CLIENT = httpx.AsyncClient


@pytest.fixture(autouse=True)
async def _fresh_state(client):
    """A clean connections table, no source setting, and cold caches per case."""
    reset_image_model_cache()
    reset_video_model_cache()
    openrouter_media.reset_catalogues()
    async with async_session_factory() as session:
        await session.execute(delete(LaiosConnection))
        await session.execute(delete(AppConfig))
        await session.commit()
    yield
    async with async_session_factory() as session:
        await session.execute(delete(LaiosConnection))
        await session.execute(delete(AppConfig))
        await session.commit()
    reset_image_model_cache()
    reset_video_model_cache()
    openrouter_media.reset_catalogues()


def _upstreams(monkeypatch, *, laios_models=(), images=None, videos=None) -> None:
    """One fake for both upstreams, so a cross-source resolve has somewhere to go.

    Deliberately serving *both*: a test that proves "OpenRouter is selected, so the
    box is not used" is worthless if the box was unreachable anyway.
    """

    def handle(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/images/models"):
            return httpx.Response(200, json=images or {"data": []})
        if path.endswith("/videos/models"):
            return httpx.Response(200, json=videos or {"data": []})
        if path == "/v1/models":
            # The control plane answers with a bare list, not a ``data`` envelope.
            return httpx.Response(200, json=list(laios_models))
        return httpx.Response(404, json={})

    def mock_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handle)
        return _REAL_ASYNC_CLIENT(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", mock_client)


async def _connect(name: str = "box") -> str:
    async with async_session_factory() as session:
        conn = LaiosConnection(
            name=name, base_url=f"http://{name}:7420", master_key="sk-test"
        )
        session.add(conn)
        await session.commit()
        return conn.id


async def _configure(**fields) -> None:
    async with async_session_factory() as session:
        cfg = AppConfig(**fields)
        session.add(cfg)
        await session.commit()


async def _image():
    async with async_session_factory() as session:
        return await resolve_image_target(session)


async def _video():
    async with async_session_factory() as session:
        return await resolve_video_target(session)


@pytest.fixture
def key(monkeypatch):
    monkeypatch.setattr(get_settings(), "openrouter_api_key", "sk-or-test")


@pytest.fixture
def no_key(monkeypatch):
    monkeypatch.setattr(get_settings(), "openrouter_api_key", None)


# --- The rule: never cross sources --------------------------------------------


async def test_openrouter_never_resolves_to_a_live_box_serving_images(
    monkeypatch, key
):
    """The load-bearing one. A working box is right there and must not be used."""
    await _connect()
    await _configure(image_source="openrouter")
    _upstreams(monkeypatch, laios_models=[Z_IMAGE], images=OR_IMAGES)

    runtime, _ = await _image()
    assert runtime is not None
    assert runtime.provider == refs.OPENROUTER
    assert all(m.provider == refs.OPENROUTER for m in runtime.models)
    assert "z-image-turbo" not in {m.model for m in runtime.models}


async def test_openrouter_never_resolves_to_a_live_box_serving_video(monkeypatch, key):
    await _connect()
    await _configure(video_source="openrouter")
    _upstreams(monkeypatch, laios_models=[H3], videos=OR_VIDEOS)

    runtime, _ = await _video()
    assert runtime is not None
    assert runtime.provider == refs.OPENROUTER
    assert runtime.request_schema == SCHEMA_OPENROUTER_VIDEO
    assert runtime.model != "minimax-h3"


async def test_laios_never_resolves_to_openrouter(monkeypatch, key):
    """The other direction: a box that stopped serving must not start billing."""
    await _connect()
    await _configure(image_source="laios")
    _upstreams(monkeypatch, laios_models=[], images=OR_IMAGES)

    runtime, reason = await _image()
    assert runtime is None
    assert "LAIOS is the configured image source" in reason


async def test_an_unset_source_behaves_exactly_as_before(monkeypatch, key):
    """NULL means laios, so an upgrade does not move anyone onto a paid API."""
    await _connect()
    _upstreams(monkeypatch, laios_models=[Z_IMAGE], images=OR_IMAGES)

    runtime, _ = await _image()
    assert runtime is not None
    assert runtime.provider == refs.LAIOS
    assert runtime.default.model == "z-image-turbo"


# --- Saying why ----------------------------------------------------------------


async def test_no_key_names_the_key_and_where_to_put_it(monkeypatch, no_key):
    await _configure(image_source="openrouter")
    _upstreams(monkeypatch, images=OR_IMAGES)

    runtime, reason = await _image()
    assert runtime is None
    assert "no OpenRouter API key" in reason
    assert "Settings" in reason


async def test_an_unreadable_catalogue_says_the_box_will_not_be_used(monkeypatch, key):
    """The absence of a fallback has to be legible, or it reads as a bug."""
    await _connect()
    await _configure(video_source="openrouter")
    _upstreams(monkeypatch, laios_models=[H3], videos={"data": []})

    runtime, reason = await _video()
    assert runtime is None
    assert "could not be read" in reason
    assert "LAIOS" in reason, "the reason must say the box is deliberately unused"


# --- Choosing within a source ---------------------------------------------------


async def test_video_auto_picks_the_cheapest_published_rate(monkeypatch, key):
    await _configure(video_source="openrouter")
    _upstreams(monkeypatch, videos=OR_VIDEOS)

    runtime, reason = await _video()
    assert runtime is not None
    assert runtime.model == "bytedance/seedance-2.0"  # $0.10/s beats $0.40/s
    assert "$0.10 a second" in reason


async def test_a_pinned_model_wins_over_the_cheapest(monkeypatch, key):
    await _configure(
        video_source="openrouter", video_model="openrouter:google/veo-3.1"
    )
    _upstreams(monkeypatch, videos=OR_VIDEOS)

    runtime, reason = await _video()
    assert runtime is not None
    assert runtime.model == "google/veo-3.1"
    assert runtime.pinned is True
    assert "pinned" in reason


async def test_a_pin_that_has_gone_missing_fails_rather_than_substituting(
    monkeypatch, key
):
    """Auto is the setting for "choose for me". A pin is not that."""
    await _configure(
        video_source="openrouter", video_model="openrouter:openai/sora-2-pro"
    )
    _upstreams(monkeypatch, videos=OR_VIDEOS)

    runtime, reason = await _video()
    assert runtime is None
    assert "openai/sora-2-pro" in reason
    assert "choose Auto" in reason


async def test_a_missing_image_pin_fails_the_same_way(monkeypatch, key):
    await _configure(
        image_source="openrouter", image_model="openrouter:stability/sd-9"
    )
    _upstreams(monkeypatch, images=OR_IMAGES)

    runtime, reason = await _image()
    assert runtime is None
    assert "stability/sd-9" in reason


async def test_openrouter_video_constraints_come_from_the_catalogue(monkeypatch, key):
    """The catalogue is the declaration — that is why fail-closed does not apply."""
    await _configure(
        video_source="openrouter", video_model="openrouter:google/veo-3.1"
    )
    _upstreams(monkeypatch, videos=OR_VIDEOS)

    runtime, _ = await _video()
    assert runtime is not None
    limits = runtime.constraints
    assert limits.aspect_ratios == ("16:9", "9:16")
    assert (limits.min_duration_seconds, limits.max_duration_seconds) == (4.0, 8.0)
    assert limits.keyframes is True
    assert limits.emits_audio is True
    # Steps and a short edge are laios concepts and must not be inherited.
    assert limits.max_steps == 0
    assert limits.short_edge is None


async def test_a_model_listing_no_durations_is_unconstrained_not_h3(monkeypatch, key):
    """Absent means unconstrained. Inheriting H3's 4–15 would be a silent wrong."""
    await _configure(video_source="openrouter")
    _upstreams(
        monkeypatch,
        videos={"data": [{"id": "x/y", "name": "Y", "pricing_skus": {}}]},
    )

    runtime, _ = await _video()
    assert runtime is not None
    assert runtime.constraints.min_duration_seconds == 0.0
    assert runtime.constraints.max_duration_seconds == float("inf")
    assert runtime.constraints.aspect_ratios == ()
