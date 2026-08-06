"""``/api/settings/media`` — which source generates images and clips.

The endpoint stores two independent choices (a source and an optional pinned
model, per modality) and reports back what those choices actually resolve to.
Three properties matter here:

* **Defaults are today's behaviour.** An install that never opens the section
  reads back "laios, auto", because that is what the resolver did before the
  setting existed.
* **Partial saves are really partial.** The image and video cards save on change,
  independently, so a PUT carrying only the image source must not clear a pinned
  video model.
* **A pin cannot name the other source.** Storing one would force the resolver to
  choose between crossing a source the user did not select and ignoring the pin
  silently, and neither is a state worth being able to reach.

The ``available``/``reason`` fields come from the real resolvers, and there is no
laios box and no reachable catalogue in the test environment — so they report
unavailability, which is exactly the state the UI has to render.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from app.media import refs


@pytest.fixture(autouse=True)
async def restore_source():
    """Put the source back to "unset" after every test in this file.

    The suite shares one SQLite file, and the media source is now a *global* that
    ``image_runtime`` and ``video_runtime`` read on every resolve. A test here that
    left ``video_source = 'openrouter'`` behind would silently re-point every later
    video test at a source with no key — which fails as a wall of unrelated
    assertion errors in files that never mention OpenRouter.
    """
    yield
    from sqlmodel import select

    from app.db.models import AppConfig
    from app.db.session import async_session_factory

    async with async_session_factory() as session:
        cfg = (await session.execute(select(AppConfig))).scalars().first()
        if cfg is not None:
            cfg.image_source = cfg.video_source = None
            cfg.image_model = cfg.video_model = None
            session.add(cfg)
            await session.commit()


async def _media(client: AsyncClient) -> dict:
    resp = await client.get("/settings/media")
    assert resp.status_code == 200
    return resp.json()


async def test_defaults_are_laios_and_auto(client: AsyncClient):
    body = await _media(client)
    for kind in ("image", "video"):
        assert body[kind]["source"] == refs.LAIOS
        assert body[kind]["model"] is None
        assert body[kind]["model_source"] == "auto"


async def test_reason_is_always_a_sentence(client: AsyncClient):
    """A card that says "unavailable" with no why is indistinguishable from a bug."""
    body = await _media(client)
    for kind in ("image", "video"):
        assert not body[kind]["available"]
        assert body[kind]["reason"].strip()


async def test_source_saves_and_reads_back(client: AsyncClient):
    resp = await client.put("/settings/media", json={"image_source": "openrouter"})
    assert resp.status_code == 200
    assert resp.json()["image"]["source"] == "openrouter"
    assert (await _media(client))["image"]["source"] == "openrouter"


async def test_saving_one_modality_leaves_the_other_alone(client: AsyncClient):
    await client.put(
        "/settings/media",
        json={"video_source": "openrouter", "video_model": "openrouter:google/veo-3.1"},
    )
    await client.put("/settings/media", json={"image_source": "openrouter"})

    body = await _media(client)
    assert body["video"]["model"] == "openrouter:google/veo-3.1"
    assert body["image"]["source"] == "openrouter"


async def test_a_blank_model_clears_the_pin(client: AsyncClient):
    await client.put(
        "/settings/media",
        json={"image_source": "openrouter", "image_model": "openrouter:openai/gpt-image-2"},
    )
    assert (await _media(client))["image"]["model_source"] == "database"

    await client.put("/settings/media", json={"image_model": ""})
    body = await _media(client)
    assert body["image"]["model"] is None
    assert body["image"]["model_source"] == "auto"


async def test_a_pin_on_the_other_source_is_rejected(client: AsyncClient):
    resp = await client.put(
        "/settings/media",
        json={"image_source": "laios", "image_model": "openrouter:openai/gpt-image-2"},
    )
    assert resp.status_code == 400
    assert "not on the selected" in resp.json()["detail"]
    # And nothing was stored: a rejected save must not half-apply.
    assert (await _media(client))["image"]["model"] is None


async def test_an_unparseable_pin_is_rejected(client: AsyncClient):
    resp = await client.put("/settings/media", json={"image_model": "gpt-image-2"})
    assert resp.status_code == 400


async def test_an_unknown_source_is_rejected(client: AsyncClient):
    resp = await client.put("/settings/media", json={"image_source": "comfyui"})
    assert resp.status_code in (400, 422)


async def test_openrouter_configured_tracks_the_key(client: AsyncClient, monkeypatch):
    from app.config import get_settings

    assert (await _media(client))["openrouter_configured"] is True
    monkeypatch.setattr(get_settings(), "openrouter_api_key", None)
    assert (await _media(client))["openrouter_configured"] is False


# --- The ref grammar ----------------------------------------------------------


def test_a_blank_ref_is_auto_not_an_error():
    assert refs.parse_model_ref(None) is None
    assert refs.parse_model_ref("  ") is None


def test_refs_round_trip():
    for raw in (
        "openrouter:google/gemini-2.5-flash-image",
        "laios:conn-1:z-image-turbo",
    ):
        assert str(refs.parse_model_ref(raw)) == raw


def test_a_slug_with_slashes_survives():
    ref = refs.parse_model_ref("openrouter:bytedance-seed/seedream-4.5")
    assert ref is not None
    assert ref.model == "bytedance-seed/seedream-4.5"


def test_a_bare_laios_source_matches_any_box():
    """A pin made while two boxes were connected keeps working after one leaves."""
    ref = refs.parse_model_ref("laios:conn-1:z-image-turbo")
    assert ref is not None
    assert refs.belongs_to(ref, refs.parse_source("laios"))
    assert refs.belongs_to(ref, refs.parse_source("laios:conn-1"))
    assert not refs.belongs_to(ref, refs.parse_source("laios:conn-2"))
    assert not refs.belongs_to(ref, refs.parse_source("openrouter"))


def test_a_model_ref_is_not_a_source_ref():
    """Silently widening ``openrouter:slug`` to "all of OpenRouter" would hide a bug."""
    with pytest.raises(refs.RefError):
        refs.parse_source("openrouter:openai/gpt-image-2")


def test_a_laios_ref_without_a_model_is_rejected():
    with pytest.raises(refs.RefError):
        refs.parse_model_ref("laios:conn-1")
