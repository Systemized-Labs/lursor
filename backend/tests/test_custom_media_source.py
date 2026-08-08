"""A custom provider as the third media source, and what it is allowed to assume.

The interesting half of this feature is not the plumbing — a custom provider is an
OpenAI-compatible origin, so submit/poll/download are the laios code path with a
different client. It is the **classification**: an endpoint's ``/models`` says which
models exist and nothing about what they generate, so the modality is recovered
rather than read, and every layer that recovers it can be wrong in a different way.

So these tests are mostly about the ordering of those layers and about what happens
when they disagree — an endpoint that says ``chat`` must beat an id that says
``flux``, and a model nobody declared must still be offered, but visibly marked.
Getting that backwards is silent: the picker looks identical either way, and the
first sign of trouble is a 400 the user cannot connect to a cause.

The no-fallback invariant (``test_media_source.py``) is retested here for the third
source, because it is the property the whole feature rests on and adding a source is
exactly when it would break.
"""

from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import delete

from app.agents.image_runtime import reset_image_model_cache, resolve_image_target
from app.agents.video_runtime import (
    SCHEMA_SGLANG_VIDEO,
    reset_video_model_cache,
    resolve_video_target,
)
from app.config import get_settings
from app.db.models import (
    AppConfig,
    CustomProvider,
    ImageGeneration,
    LaiosConnection,
    VideoJob,
)
from app.db.session import async_session_factory
from app.media import custom as custom_media
from app.media import openrouter as openrouter_media
from app.media import refs

_REAL_ASYNC_CLIENT = httpx.AsyncClient


@pytest.fixture(autouse=True)
async def _fresh_state(client, tmp_path, monkeypatch):
    """Empty tables, cold caches and a throwaway media dir per case."""
    monkeypatch.setattr(get_settings(), "media_dir", tmp_path / "media")

    async def wipe():
        async with async_session_factory() as session:
            await session.execute(delete(ImageGeneration))
            await session.execute(delete(VideoJob))
            await session.execute(delete(CustomProvider))
            await session.execute(delete(LaiosConnection))
            await session.execute(delete(AppConfig))
            await session.commit()

    def cold():
        reset_image_model_cache()
        reset_video_model_cache()
        custom_media.reset_custom_media_cache()
        openrouter_media.reset_catalogues()

    cold()
    await wipe()
    yield
    await wipe()
    cold()


def _endpoint(
    monkeypatch,
    *,
    models: list[dict] | None = None,
    model_info: list[dict] | None = None,
    images: bool = True,
    videos: bool = True,
) -> None:
    """Fake one OpenAI-compatible endpoint, through the module's client seam.

    ``images``/``videos`` control whether the *route* exists at all — the probe the
    classifier runs before it trusts anything else — so a case can serve a
    convincing catalogue and still be told there is no images API, which is the
    combination a name heuristic alone would get wrong.
    """

    def handle(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "POST" and path.endswith("/images/generations"):
            return httpx.Response(400 if images else 404, json={})
        if request.method == "POST" and path.endswith("/videos"):
            return httpx.Response(400 if videos else 404, json={})
        if path.endswith("/model/info"):
            if model_info is None:
                return httpx.Response(404, json={})
            return httpx.Response(200, json={"data": model_info})
        if path.endswith("/models"):
            return httpx.Response(200, json={"data": models or []})
        return httpx.Response(404, json={})

    def fake_client(provider, timeout=None):
        return _REAL_ASYNC_CLIENT(
            base_url=custom_media.base_url(provider),
            transport=httpx.MockTransport(handle),
            timeout=timeout or httpx.Timeout(5.0),
        )

    monkeypatch.setattr(custom_media, "client", fake_client)


async def _provider(name: str = "workstation", manual: str = "") -> str:
    async with async_session_factory() as session:
        provider = CustomProvider(
            name=name, base_url="http://box.local:8000/v1", manual_models=manual
        )
        session.add(provider)
        await session.commit()
        return provider.id


async def _configure(**fields) -> None:
    async with async_session_factory() as session:
        session.add(AppConfig(**fields))
        await session.commit()


async def _image():
    async with async_session_factory() as session:
        return await resolve_image_target(session)


async def _video():
    async with async_session_factory() as session:
        return await resolve_video_target(session)


# --- The ref grammar ------------------------------------------------------------


def test_a_custom_ref_round_trips():
    ref = refs.parse_model_ref("custom:abc123:flux-dev")
    assert (ref.provider, ref.connection_id, ref.model) == (
        refs.CUSTOM,
        "abc123",
        "flux-dev",
    )
    assert str(ref) == "custom:abc123:flux-dev"
    assert str(ref.source) == "custom:abc123"
    assert refs.belongs_to(ref, refs.parse_source("custom:abc123"))
    # A bare ``custom`` means "any custom provider", so a specific one belongs to it
    # — the same widening ``laios`` has always had.
    assert refs.belongs_to(ref, refs.parse_source("custom"))
    assert not refs.belongs_to(ref, refs.parse_source("custom:other"))
    assert not refs.belongs_to(ref, refs.parse_source("laios:abc123"))


def test_a_model_id_with_no_provider_is_still_rejected():
    with pytest.raises(refs.RefError):
        refs.parse_model_ref("custom:flux-dev")
    with pytest.raises(refs.RefError):
        refs.parse_source("nonsense:1")


# --- Classification -------------------------------------------------------------


async def test_a_missing_images_route_beats_a_convincing_name(monkeypatch):
    """The gate in front of everything: no ``/images/generations``, no image models.

    The case this exists for is an Ollama install serving ``llava`` — a name that
    reads as an image model to any heuristic, on a server that cannot generate one.
    """
    _endpoint(monkeypatch, models=[{"id": "flux-dev"}], images=False)
    pid = await _provider()
    await _configure(image_source=f"custom:{pid}")

    runtime, reason = await _image()
    assert runtime is None
    assert "does not serve an images API" in reason


async def test_the_endpoint_outranks_the_name(monkeypatch):
    """``/model/info`` saying ``chat`` is the answer, even for a model called flux.

    A LiteLLM proxy in front of a text model named after a diffusion family is not
    hypothetical, and the layers exist in this order precisely so a declaration is
    never overruled by a guess.
    """
    _endpoint(
        monkeypatch,
        models=[{"id": "flux-router"}, {"id": "mystery-1"}],
        model_info=[
            {"model_name": "flux-router", "model_info": {"mode": "chat"}},
            {"model_name": "mystery-1", "model_info": {"mode": "image_generation"}},
        ],
    )
    pid = await _provider()
    await _configure(image_source=f"custom:{pid}")

    runtime, _ = await _image()
    assert runtime is not None
    assert [m.model for m in runtime.models] == ["mystery-1"]
    assert runtime.models[0].custom.declared is True


async def test_a_name_match_is_offered_but_marked(monkeypatch):
    """Layer 3 still counts — it is just never allowed to look like a declaration."""
    _endpoint(monkeypatch, models=[{"id": "sdxl-turbo"}, {"id": "llama3.1:8b"}])
    pid = await _provider()
    await _configure(image_source=f"custom:{pid}")

    runtime, _ = await _image()
    assert runtime is not None
    assert [m.model for m in runtime.models] == ["sdxl-turbo"]
    model = runtime.models[0]
    assert model.custom.declared is False
    assert "Matched by name" in model.note


async def test_declared_fields_on_the_models_entry_are_read(monkeypatch):
    """Layer 2: an OpenRouter-shaped proxy states its output modality inline."""
    _endpoint(
        monkeypatch,
        models=[
            {"id": "internal-42", "architecture": {"output_modalities": ["image"]}},
            {"id": "internal-43", "modality": "text->video"},
        ],
    )
    pid = await _provider()
    await _configure(image_source=f"custom:{pid}", video_source=f"custom:{pid}")

    images, _ = await _image()
    assert images is not None
    assert [m.model for m in images.models] == ["internal-42"]
    assert images.models[0].custom.declared is True

    video, _ = await _video()
    assert video is not None
    assert video.model == "internal-43"


async def test_an_untaggable_model_needs_the_manual_prefix(monkeypatch):
    """The escape hatch, and its containment.

    ``opaque-v3`` is what every layer misses: the endpoint declares nothing and the
    id says nothing. Tagging it is the only way through — and the tag must not leak
    into the chat picker, which reads the same field.
    """
    _endpoint(monkeypatch, models=[{"id": "opaque-v3"}])
    pid = await _provider(manual="image:opaque-v3, chat-only-model")
    await _configure(image_source=f"custom:{pid}")

    runtime, _ = await _image()
    assert runtime is not None
    assert [m.model for m in runtime.models] == ["opaque-v3"]
    assert runtime.models[0].custom.declared is True

    async with async_session_factory() as session:
        provider = await session.get(CustomProvider, pid)
    # The chat list is the same column, and must not have gained a diffusion model.
    assert provider.manual_model_ids() == ["chat-only-model"]
    assert provider.manual_media_models() == [("image", "opaque-v3")]


async def test_a_tag_outranks_a_missing_route(monkeypatch):
    """An explicit tag is a declaration, so it beats the probe rather than the
    other way round — the gate is there to stop heuristics, not operators."""
    _endpoint(monkeypatch, models=[], images=False)
    pid = await _provider(manual="image:opaque-v3")
    await _configure(image_source=f"custom:{pid}")

    runtime, _ = await _image()
    assert runtime is not None
    assert [m.model for m in runtime.models] == ["opaque-v3"]


# --- Video ----------------------------------------------------------------------


async def test_video_is_driven_as_sglang_with_nothing_constrained(monkeypatch):
    """A custom video model is drivable, unlike an undeclared laios one.

    And the price of that is that nothing may be validated against numbers from a
    different model: every constraint has to be open, or a request the endpoint
    would have accepted is refused locally on MiniMax-H3's behalf.
    """
    _endpoint(monkeypatch, models=[{"id": "wan2.2-t2v"}])
    pid = await _provider()
    await _configure(video_source=f"custom:{pid}")

    runtime, reason = await _video()
    assert runtime is not None
    assert runtime.provider == refs.CUSTOM
    assert runtime.request_schema == SCHEMA_SGLANG_VIDEO
    assert runtime.ref == f"custom:{pid}:wan2.2-t2v"
    # Matched by name, so it says so — in the runtime and in the sentence.
    assert runtime.assumed is True
    assert "matched by name" in reason

    limits = runtime.constraints
    assert limits.short_edge is None
    assert limits.aspect_ratios == ()
    assert limits.sizes == {}
    assert limits.min_duration_seconds == 0.0
    assert limits.max_duration_seconds == float("inf")
    assert limits.seconds_per_step == 0


async def test_a_missing_videos_route_offers_no_video_tools(monkeypatch):
    _endpoint(monkeypatch, models=[{"id": "wan2.2-t2v"}], videos=False)
    pid = await _provider()
    await _configure(video_source=f"custom:{pid}")

    runtime, reason = await _video()
    assert runtime is None
    assert "does not serve a video API" in reason


# --- The invariant: the source never falls back ---------------------------------


async def test_a_custom_source_never_reaches_a_box_or_openrouter(monkeypatch):
    """Configured custom, everything else working, and still nothing crosses.

    A box is connected and OpenRouter has a key, so "resolved to nothing" here is a
    refusal rather than an absence of alternatives.
    """
    _endpoint(monkeypatch, models=[{"id": "text-only"}])
    pid = await _provider()
    async with async_session_factory() as session:
        session.add(
            LaiosConnection(name="box", base_url="http://box:7420", master_key="sk")
        )
        await session.commit()
    await _configure(image_source=f"custom:{pid}", video_source=f"custom:{pid}")

    image, image_reason = await _image()
    video, video_reason = await _video()
    assert image is None and video is None
    assert "workstation" in image_reason
    assert "workstation" in video_reason


async def test_a_laios_source_never_reaches_a_custom_provider(monkeypatch):
    """And the other direction: a serving custom endpoint is invisible to laios."""
    _endpoint(monkeypatch, models=[{"id": "sdxl-turbo"}])
    await _provider()
    await _configure(image_source=refs.LAIOS)

    runtime, reason = await _image()
    assert runtime is None
    assert "no laios connection is configured" in reason


async def test_a_pinned_custom_model_that_vanished_fails_rather_than_substituting(
    monkeypatch,
):
    """The pin is a decision about what a result should look like. "Auto" exists."""
    _endpoint(monkeypatch, models=[{"id": "sdxl-turbo"}])
    pid = await _provider()
    await _configure(
        image_source=f"custom:{pid}", image_model=f"custom:{pid}:flux-dev"
    )

    runtime, reason = await _image()
    assert runtime is None
    assert "is not available from custom" in reason
    assert "sdxl-turbo" in reason


async def test_a_deleted_provider_says_so_rather_than_going_quiet(monkeypatch):
    _endpoint(monkeypatch, models=[{"id": "sdxl-turbo"}])
    await _configure(image_source="custom:gone")

    runtime, reason = await _image()
    assert runtime is None
    assert "no longer exists" in reason


async def test_a_laios_managed_provider_is_not_offered_as_a_custom_source(
    monkeypatch,
):
    """The box's own gateway provider is hidden, or every model would list twice.

    Once under "LAIOS box" and once under a provider the user never created — and
    the two would spend the same GPU by different routes.
    """
    _endpoint(monkeypatch, models=[{"id": "sdxl-turbo"}])
    pid = await _provider()
    async with async_session_factory() as session:
        session.add(
            LaiosConnection(
                name="box",
                base_url="http://box:7420",
                master_key="sk",
                linked_provider_id=pid,
            )
        )
        await session.commit()
    await _configure(image_source=refs.CUSTOM)

    runtime, reason = await _image()
    assert runtime is None
    assert "none is configured" in reason


# --- Generating, end to end -----------------------------------------------------

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


async def test_an_image_generates_against_a_custom_endpoint(
    client: AsyncClient, monkeypatch
):
    """The whole path: submit, background task, bytes on the row.

    Also pins the two overrides the module forces on every OpenAI-compatible
    upstream — ``response_format`` and ``n`` — because the custom path is a second
    place they could be forgotten, and forgetting them is silent: the generation
    still succeeds and the image is simply gone with the container.
    """
    captured: dict = {}

    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/images/generations"):
            captured["body"] = request.content
            captured["auth"] = request.headers.get("authorization")
            return httpx.Response(
                200,
                json={
                    "id": "img_9",
                    "data": [{"b64_json": base64.b64encode(PNG).decode()}],
                    "inference_time_s": 4.2,
                },
            )
        return httpx.Response(404, json={})

    def fake_image_client(provider):
        return httpx.AsyncClient(
            transport=httpx.MockTransport(handle),
            base_url=custom_media.base_url(provider),
            headers={"Authorization": f"Bearer {provider.api_key}"},
        )

    monkeypatch.setattr(custom_media, "image_client", fake_image_client)

    async with async_session_factory() as session:
        provider = CustomProvider(
            name="workstation", base_url="http://box.local:8000/v1", api_key="sk-local"
        )
        session.add(provider)
        await session.commit()
        pid = provider.id

    r = await client.post(
        "/media/images",
        json={
            "source": f"custom:{pid}",
            "model": "sdxl-turbo",
            "prompt": "a paper boat on a puddle",
            "size": "1024x1024",
        },
    )
    assert r.status_code == 201, r.text
    run = r.json()
    assert run["provider"] == "custom"
    assert run["connection_id"] == pid
    assert run["status"] == "running"

    from app.api import images as images_mod

    task = images_mod._active.get(run["id"])
    if task is not None:
        await asyncio.wait_for(asyncio.shield(task), timeout=10)

    body = json.loads(captured["body"])
    assert body["response_format"] == "b64_json"
    assert body["n"] == 1
    assert body["model"] == "sdxl-turbo"
    assert captured["auth"] == "Bearer sk-local"

    fresh = (await client.get(f"/media/images/{run['id']}")).json()
    assert fresh["status"] == "completed", fresh["error"]
    assert fresh["media_id"]
    assert fresh["inference_time_s"] == 4.2

    content = await client.get(f"/media/images/{run['id']}/content")
    assert content.status_code == 200
    assert content.headers["content-type"] == "image/png"


async def test_a_full_model_ref_carries_its_own_source(
    client: AsyncClient, monkeypatch
):
    """Submitting ``custom:{id}:{model}`` needs no ``source`` alongside it.

    Which is what lets a caller hand back the exact string Settings stored, rather
    than taking it apart and hoping the two halves are reassembled the same way.
    """
    monkeypatch.setattr(
        custom_media,
        "image_client",
        lambda provider: httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _r: httpx.Response(
                    200, json={"data": [{"b64_json": base64.b64encode(PNG).decode()}]}
                )
            ),
            base_url=custom_media.base_url(provider),
        ),
    )
    pid = await _provider()

    r = await client.post(
        "/media/images",
        json={"model": f"custom:{pid}:sdxl-turbo", "prompt": "a kite"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["provider"] == "custom"
    assert r.json()["model"] == "sdxl-turbo"


async def test_submitting_to_a_deleted_provider_is_a_400_not_a_stuck_row(
    client: AsyncClient,
):
    """Checked before the row is written, like the laios connection check.

    The history exists to record attempts that reached an upstream; filling it with
    ones that never left the building would make it useless for the thing it is
    for.
    """
    r = await client.post(
        "/media/images",
        json={"model": "custom:gone:sdxl-turbo", "prompt": "a kite"},
    )
    assert r.status_code == 400
    assert "no custom provider" in r.json()["detail"]
    assert (await client.get("/media/images")).json() == []
