"""Generating through OpenRouter: the API paths and what the tools tell the agent.

The API half is the provider branch in ``api/images.py`` and ``api/videos.py``.
Most of both modules is shared — the detached task, orphan reaping, the media
store, the row vocabulary — so what is worth pinning down is only where the two
sources genuinely diverge:

* the exact ``usage.cost`` lands on the row, because it is the only price this app
  can ever show for a hosted image;
* a finished clip is downloaded **on the poll that first sees it**, since
  ``unsigned_urls`` expire and a clip somebody paid for must not become unreachable
  because they closed the tab;
* cancelling says plainly that nothing was cancelled.

The tools half is about what the agent is *told*. A tool docstring is the agent's
model of the world, and the video one used to assert MiniMax-H3's economics
unconditionally ("about 44 seconds per step", "draft at steps=8"). Handed to a
model pointed at Veo that is not merely stale, it is instructions to use a knob
that does not exist.
"""

from __future__ import annotations

import base64

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import delete

from app.agents.image_runtime import ImageModel, ImageRuntime
from app.agents.image_tools import make_image_tools
from app.agents.video_runtime import (
    SCHEMA_OPENROUTER_VIDEO,
    VideoRuntime,
    constraints_from_openrouter,
)
from app.agents.video_tools import make_video_tools
from app.config import get_settings
from app.db.models import AppConfig, ImageGeneration, LaiosConnection, VideoJob
from app.db.session import async_session_factory
from app.media import openrouter as openrouter_media
from app.media import refs
from app.media.openrouter import ORImageModel, ORVideoModel, PriceQuote

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16

GPT_IMAGE = ORImageModel(
    slug="openai/gpt-image-2",
    label="GPT Image 2",
    note="A hosted image model.",
    aspect_ratios=("1:1", "16:9"),
    qualities=("low", "high"),
    formats=("png", "jpeg"),
    seed=False,
)
VEO = ORVideoModel(
    slug="google/veo-3.1",
    label="Veo 3.1",
    note="A hosted video model.",
    resolutions=("720p", "1080p"),
    aspect_ratios=("16:9", "9:16"),
    durations=(4.0, 8.0),
    frame_images=("first_frame",),
    audio=True,
    seed=True,
    price=PriceQuote(amount=0.40, unit="second"),
)


@pytest.fixture(autouse=True)
async def _isolate(tmp_path, monkeypatch, client: AsyncClient):
    monkeypatch.setattr(get_settings(), "media_dir", tmp_path / "media")
    monkeypatch.setattr(get_settings(), "openrouter_api_key", "sk-or-test")
    openrouter_media.reset_catalogues()
    yield
    async with async_session_factory() as session:
        await session.execute(delete(ImageGeneration))
        await session.execute(delete(VideoJob))
        await session.execute(delete(LaiosConnection))
        await session.execute(delete(AppConfig))
        await session.commit()
    openrouter_media.reset_catalogues()


_REAL_ASYNC_CLIENT = httpx.AsyncClient


def _upstream(monkeypatch, handler) -> list[httpx.Request]:
    """Point every client at ``handler`` and record what it was asked."""
    seen: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    def mock_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(wrapped)
        return _REAL_ASYNC_CLIENT(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", mock_client)
    return seen


async def _settle(run_id: str) -> None:
    import asyncio

    from app.api import images as images_mod

    task = images_mod._active.get(run_id)
    if task is not None:
        await asyncio.wait_for(asyncio.shield(task), timeout=10)


# --- Images through the API -----------------------------------------------------


async def test_a_hosted_image_lands_with_its_exact_cost(
    client: AsyncClient, monkeypatch
):
    """``usage.cost`` is a real charge, not an estimate — the reason it has a column."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "created": 1,
                "data": [{"b64_json": base64.b64encode(PNG).decode()}],
                "usage": {"cost": 0.031},
            },
        )

    seen = _upstream(monkeypatch, handler)

    r = await client.post(
        "/media/images",
        json={"source": "openrouter", "model": "openai/gpt-image-2", "prompt": "a cat"},
    )
    assert r.status_code == 201, r.text
    run = r.json()
    assert run["provider"] == "openrouter"
    assert run["connection_id"] == ""

    await _settle(run["id"])
    done = (await client.get(f"/media/images/{run['id']}")).json()
    assert done["status"] == "completed"
    assert done["cost_usd"] == pytest.approx(0.031)
    assert done["media_id"]

    # And the bytes serve back, sniffed as PNG regardless of what was claimed.
    content = await client.get(f"/media/images/{run['id']}/content")
    assert content.status_code == 200
    assert content.headers["content-type"] == "image/png"
    assert [req.url.path for req in seen] == ["/api/v1/images"]


async def test_the_laios_only_overrides_are_not_sent_to_openrouter(
    client: AsyncClient, monkeypatch
):
    """``response_format``/``n`` are the engine's vocabulary; OpenRouter rejects them."""
    bodies: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(request.content)
        return httpx.Response(
            200,
            json={"data": [{"b64_json": base64.b64encode(PNG).decode()}], "usage": {}},
        )

    _upstream(monkeypatch, handler)
    run = (
        await client.post(
            "/media/images",
            json={"source": "openrouter", "model": "x/y", "prompt": "a cat"},
        )
    ).json()
    await _settle(run["id"])

    assert b"response_format" not in bodies[0]
    assert b'"n"' not in bodies[0]


async def test_a_full_model_ref_picks_its_own_source(client: AsyncClient, monkeypatch):
    """The string Settings stored can be submitted unchanged."""
    _upstream(
        monkeypatch,
        lambda r: httpx.Response(
            200,
            json={"data": [{"b64_json": base64.b64encode(PNG).decode()}], "usage": {}},
        ),
    )
    run = (
        await client.post(
            "/media/images",
            json={"model": "openrouter:openai/gpt-image-2", "prompt": "a cat"},
        )
    ).json()
    assert run["provider"] == "openrouter"
    assert run["model"] == "openai/gpt-image-2"
    await _settle(run["id"])


async def test_no_key_is_refused_before_a_row_is_written(
    client: AsyncClient, monkeypatch
):
    monkeypatch.setattr(get_settings(), "openrouter_api_key", None)
    r = await client.post(
        "/media/images",
        json={"source": "openrouter", "model": "x/y", "prompt": "a cat"},
    )
    assert r.status_code == 400
    assert "OpenRouter API key" in r.json()["detail"]
    assert (await client.get("/media/images?source=openrouter")).json() == []


async def test_an_upstream_rejection_lands_on_the_row(client: AsyncClient, monkeypatch):
    """Nobody awaits the task, so a failure that misses the row is an orphan."""
    _upstream(
        monkeypatch,
        lambda r: httpx.Response(
            400, json={"error": {"code": "bad_size", "message": "unsupported ratio"}}
        ),
    )
    run = (
        await client.post(
            "/media/images",
            json={"source": "openrouter", "model": "x/y", "prompt": "a cat"},
        )
    ).json()
    await _settle(run["id"])

    failed = (await client.get(f"/media/images/{run['id']}")).json()
    assert failed["status"] == "failed"
    assert "unsupported ratio" in failed["error"]


# --- Video through the API ------------------------------------------------------


async def test_a_hosted_clip_is_downloaded_the_moment_it_completes(
    client: AsyncClient, monkeypatch
):
    """``unsigned_urls`` expire, so waiting for someone to press play loses clips."""
    state = {"status": "pending"}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "POST" and path.endswith("/videos"):
            return httpx.Response(202, json={"id": "vid_or", "status": "pending"})
        if path.endswith("/videos/vid_or"):
            if state["status"] == "completed":
                return httpx.Response(
                    200,
                    json={
                        "id": "vid_or",
                        "status": "completed",
                        "unsigned_urls": ["https://openrouter.ai/clip.mp4"],
                        "usage": {"cost": 1.6},
                    },
                )
            return httpx.Response(200, json={"id": "vid_or", "status": "in_progress"})
        if path.endswith("/clip.mp4"):
            return httpx.Response(
                200, content=b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 32,
                headers={"content-type": "video/mp4"},
            )
        return httpx.Response(404, json={})

    _upstream(monkeypatch, handler)

    r = await client.post(
        "/media/videos",
        json={"source": "openrouter", "model": "google/veo-3.1", "prompt": "a cat"},
    )
    assert r.status_code == 201, r.text
    job = r.json()
    assert job["provider"] == "openrouter"
    assert job["job_id"] == "vid_or"
    assert job["status"] == "pending"

    mid = (await client.get("/media/videos/vid_or")).json()
    assert mid["status"] == "in_progress"
    assert mid["media_id"] is None

    state["status"] = "completed"
    done = (await client.get("/media/videos/vid_or")).json()
    assert done["status"] == "completed"
    assert done["cost_usd"] == pytest.approx(1.6)
    assert done["media_id"], "the clip must be pulled on the completing poll"

    # And it plays from disk, with no second fetch of an expiring URL.
    played = await client.get("/media/videos/vid_or/content")
    assert played.status_code == 200


async def test_a_failed_hosted_job_records_the_reported_reason(
    client: AsyncClient, monkeypatch
):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"id": "vid_bad", "status": "pending"})
        return httpx.Response(
            200,
            json={
                "id": "vid_bad",
                "status": "failed",
                "error": {"message": "content policy"},
            },
        )

    _upstream(monkeypatch, handler)
    await client.post(
        "/media/videos",
        json={"source": "openrouter", "model": "google/veo-3.1", "prompt": "x"},
    )
    done = (await client.get("/media/videos/vid_bad")).json()
    assert done["status"] == "failed"
    assert done["error"] == "content policy"


async def test_cancelling_a_hosted_job_says_it_did_not_cancel(
    client: AsyncClient, monkeypatch
):
    """Reporting a cancel that did not happen is the more expensive lie."""
    seen = _upstream(
        monkeypatch,
        lambda r: httpx.Response(202, json={"id": "vid_c", "status": "pending"}),
    )
    await client.post(
        "/media/videos",
        json={"source": "openrouter", "model": "google/veo-3.1", "prompt": "x"},
    )
    before = len(seen)

    r = await client.delete("/media/videos/vid_c")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "cancelled"
    assert "still be billed" in body["error"]
    assert len(seen) == before, "there is nothing upstream to call"


# --- What the tools tell the agent ----------------------------------------------


def _image_runtime() -> ImageRuntime:
    model = ImageModel(
        connection_id="",
        connection_name="OpenRouter",
        model=GPT_IMAGE.slug,
        provider=refs.OPENROUTER,
        catalogue=GPT_IMAGE,
        observed_cost=0.03,
    )
    return ImageRuntime(
        models=(model,), default=model, provider=refs.OPENROUTER
    )


def _video_runtime() -> VideoRuntime:
    return VideoRuntime(
        connection_id="",
        connection_name="OpenRouter",
        model=VEO.slug,
        request_schema=SCHEMA_OPENROUTER_VIDEO,
        constraints=constraints_from_openrouter(VEO),
        provider=refs.OPENROUTER,
        price=VEO.price,
        catalogue=VEO,
    )


def test_the_image_menu_names_the_source_and_what_it_has_cost():
    doc = make_image_tools(_image_runtime(), "/tmp/ws")[0].__doc__ or ""
    assert "Models available OpenRouter" in doc
    assert "$0.030 an image" in doc
    assert "billed per image" in doc
    assert "{menu}" not in doc


def test_the_image_menu_offers_no_price_it_has_not_measured():
    model = ImageModel(
        connection_id="",
        connection_name="OpenRouter",
        model=GPT_IMAGE.slug,
        provider=refs.OPENROUTER,
        catalogue=GPT_IMAGE,
    )
    runtime = ImageRuntime(models=(model,), default=model, provider=refs.OPENROUTER)
    doc = make_image_tools(runtime, "/tmp/ws")[0].__doc__ or ""
    assert "$" not in doc.split("billed per image")[0]


async def test_a_hosted_image_drops_the_knobs_it_does_not_have(tmp_path, monkeypatch):
    """A note, not an error: the request is still exactly what was asked for."""
    bodies: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(request.content)
        return httpx.Response(
            200,
            json={"data": [{"b64_json": base64.b64encode(PNG).decode()}], "usage": {}},
        )

    _upstream(monkeypatch, handler)
    tool = make_image_tools(_image_runtime(), tmp_path)[0]

    result = await tool("a cat", size="16:9", steps=40, negative_prompt="blurry")
    assert not result.startswith("Error:")
    assert "steps" in result and "negative_prompt" in result
    assert b"num_inference_steps" not in bodies[0]
    assert b'"aspect_ratio":"16:9"' in bodies[0].replace(b", ", b",").replace(b": ", b":")


async def test_an_unsupported_ratio_is_refused_before_it_costs_anything(tmp_path):
    tool = make_image_tools(_image_runtime(), tmp_path)[0]
    result = await tool("a cat", size="4:3")
    assert result.startswith("Error:")
    assert "1:1, 16:9" in result


def test_the_video_docstring_carries_no_h3_economics():
    """The regression this guards: H3's numbers handed to a hosted model."""
    doc = make_video_tools(_video_runtime(), "/tmp/ws")[0].__doc__ or ""
    assert "44 seconds per step" not in doc
    assert "steps=8" not in doc
    assert "{menu}" not in doc

    assert "google/veo-3.1 on OpenRouter" in doc
    assert "steps: not a knob on this model" in doc
    assert "duration_seconds: 4 to 8" in doc
    assert "$0.40 a second" in doc
    assert "no cancel on OpenRouter" in doc


def test_the_laios_docstring_keeps_its_measured_economics():
    """The generated menu must not have flattened the box's own numbers away."""
    runtime = VideoRuntime(
        connection_id="c1", connection_name="spark", model="minimax-h3"
    )
    doc = make_video_tools(runtime, "/tmp/ws")[0].__doc__ or ""
    assert "44s per step" in doc
    assert "steps: 4 to 50" in doc
    assert "Clips are capped at 15 seconds" in doc


async def test_a_hosted_clip_ignores_steps_and_sends_a_duration(
    tmp_path, monkeypatch, client: AsyncClient
):
    bodies: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(request.content)
        return httpx.Response(202, json={"id": "vid_t", "status": "pending"})

    _upstream(monkeypatch, handler)
    tool = make_video_tools(_video_runtime(), tmp_path)[0]

    result = await tool("a cat", aspect_ratio="16:9", duration_seconds=8, steps=8)
    assert not result.startswith("Error:"), result
    assert "steps does not apply" in result
    # The price is quoted before it is spent: 8s at $0.40.
    assert "$3.20" in result
    body = bodies[0].replace(b", ", b",").replace(b": ", b":")
    assert b'"duration":8' in body
    assert b"num_inference_steps" not in body


async def test_a_duration_outside_the_catalogue_is_refused_locally(tmp_path):
    tool = make_video_tools(_video_runtime(), tmp_path)[0]
    result = await tool("a cat", duration_seconds=30)
    assert result.startswith("Error:")
    assert "[4, 8]" in result
