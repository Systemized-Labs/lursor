"""Whether a run gets the image tool at all, which model it defaults to, and why not.

Two gates, like video: the agent's ``include_image`` flag, and a connected box
serving an image model. The second half is where this suite stops resembling
``test_video_runtime.py``, and the divergence is the point of most of these cases.

Video refuses to drive a model whose recipe does not declare its request shape,
because guessing returns HTTP 200 with a silently wrong clip. Images have no such
failure mode — every recipe is on the same ``/v1/images/generations`` surface and
takes the same fields — so an unrecognised model **still gets the tool**, with
conservative defaults and no time estimate. Half of what follows is asserting that
the fail-open path actually stays open.

The other half is the default. The runtime carries every serving model and picks the
cheapest measured one, because ``z-image-turbo`` and ``qwen-image-2512`` differ by
roughly 20x in wall clock and defaulting to the slow one would be a tax on every
agent that did not think to ask.
"""

from __future__ import annotations

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import delete

from app.agents import image_runtime as runtime_mod
from app.agents.image_runtime import (
    GENERIC_PROFILE,
    load_image_runtime,
    profile_for,
    reset_image_model_cache,
    resolve_image_target,
)
from app.db.models import LaiosConnection
from app.db.session import async_session_factory

CHAT_MODEL = {
    "id": "qwen3.6-27b-nvfp4",
    "capabilities": ["chat", "tools"],
    "served_model_name": "qwen3.6-27b-nvfp4",
    "running_instance": {"status": "running", "served_name": "qwen3.6-27b-nvfp4"},
}

Z_IMAGE = {
    "id": "z-image-turbo",
    "recipe_id": "z-image-turbo",
    "model_id": "Tongyi-MAI/Z-Image-Turbo",
    "capabilities": ["image"],
    "served_model_name": "z-image-turbo",
    "running_instance": {"status": "running", "served_name": "z-image-turbo"},
}

QWEN_IMAGE = {
    "id": "qwen-image-2512",
    "recipe_id": "qwen-image-2512",
    "model_id": "Qwen/Qwen-Image-2512",
    "capabilities": ["image"],
    "served_model_name": "qwen-image-2512",
    "running_instance": {"status": "running", "served_name": "qwen-image-2512"},
}

# A recipe this build predates. The whole fail-open argument in one fixture.
UNKNOWN_IMAGE = {
    "id": "some-future-diffuser",
    "recipe_id": "some-future-diffuser",
    "model_id": "Someone/Future-Diffuser-8B",
    "capabilities": ["image"],
    "served_model_name": "future-diffuser",
    "running_instance": {"status": "running", "served_name": "future-diffuser"},
}

# Video-capable and running, but this is the image resolver: it must not appear.
H3_VIDEO = {
    "id": "minimax-h3-fl2va",
    "recipe_id": "minimax-h3-fl2va",
    "model_id": "MiniMaxAI/MiniMax-H3",
    "capabilities": ["video"],
    "served_model_name": "minimax-h3",
    "running_instance": {"status": "running", "served_name": "minimax-h3"},
}


@pytest.fixture(autouse=True)
async def _fresh_state(client: AsyncClient):
    """A clean connections table and a cold cache for each case.

    The suite shares one SQLite file and ``init_db`` does not drop tables, so a
    connection left by an earlier case would be the one resolution picks (it orders
    by ``created_at``). The 5-minute served-model cache would leak for the same
    reason.
    """
    reset_image_model_cache()
    async with async_session_factory() as session:
        await session.execute(delete(LaiosConnection))
        await session.commit()
    yield
    reset_image_model_cache()


# Captured before any patching — see ``test_video_runtime`` for why taking this
# inside the helper silently pins the first inventory.
_REAL_ASYNC_CLIENT = httpx.AsyncClient


def _inventory(monkeypatch, models, *, control_status: int = 200) -> None:
    """Point every httpx client at a fake laios control plane."""

    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/models":
            if control_status >= 400:
                return httpx.Response(
                    control_status,
                    json={"error": {"code": "forbidden", "message": "nope"}},
                )
            return httpx.Response(200, json=models)
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


async def _resolve(*, include_image: bool = True):
    async with async_session_factory() as session:
        return await load_image_runtime(session, include_image=include_image)


async def _target():
    async with async_session_factory() as session:
        return await resolve_image_target(session)


# --- the gates -------------------------------------------------------------------


async def test_flag_off_resolves_without_touching_the_network(monkeypatch):
    """The default-off flag has to be free, or every other agent pays for it."""
    await _connect("never-asked")

    async def boom(conn):  # noqa: ANN001
        raise AssertionError("the flag is off; nothing should ask the box anything")

    monkeypatch.setattr(runtime_mod, "image_served_models", boom)
    assert await _resolve(include_image=False) is None


async def test_no_connection_means_no_tool():
    runtime, reason = await _target()
    assert runtime is None
    assert "no laios connection" in reason


async def test_box_serving_only_chat_models_means_no_tool(monkeypatch):
    await _connect("chat-only")
    _inventory(monkeypatch, [CHAT_MODEL])
    runtime, reason = await _target()
    assert runtime is None
    assert "no connected box is serving an image model" in reason


async def test_a_video_model_is_not_an_image_model(monkeypatch):
    """The capability filter is the whole join; H3 must not leak in here."""
    await _connect("video-only")
    _inventory(monkeypatch, [CHAT_MODEL, H3_VIDEO])
    runtime, _ = await _target()
    assert runtime is None


async def test_a_loading_instance_is_not_serving(monkeypatch):
    """An instance exists long before there is a gateway route to it."""
    await _connect("still-loading")
    loading = {**Z_IMAGE, "running_instance": {"status": "starting", "served_name": "z"}}
    _inventory(monkeypatch, [loading])
    runtime, reason = await _target()
    assert runtime is None
    assert "no connected box is serving an image model" in reason


async def test_unreachable_control_plane_means_no_tool(monkeypatch):
    """Fails closed on *reachability*, which is not the same as failing closed on
    an unrecognised model — see the module docstring."""
    await _connect("tunnelled")
    _inventory(monkeypatch, [Z_IMAGE], control_status=403)
    runtime, _ = await _target()
    assert runtime is None


# --- fail open -------------------------------------------------------------------


async def test_an_unrecognised_image_model_still_gets_the_tool(monkeypatch):
    """The mirror image of video's ``test_unclassifiable_box_fails_closed``.

    Video refuses a model it cannot classify because the request shape is
    per-model. Here it is shared, so refusing would turn off a box that works.
    """
    await _connect("future")
    _inventory(monkeypatch, [UNKNOWN_IMAGE])
    runtime, reason = await _target()
    assert runtime is not None
    assert runtime.default.model == "future-diffuser"
    assert runtime.default.profile is GENERIC_PROFILE
    assert runtime.default.recognised is False
    assert runtime.assumed is True
    # And it says so, rather than presenting an unmeasured model as a measured one.
    assert "no measurements" in reason


async def test_an_unrecognised_model_carries_no_time_estimate(monkeypatch):
    """No estimate is honest; a made-up one would be trusted."""
    await _connect("future")
    _inventory(monkeypatch, [UNKNOWN_IMAGE])
    runtime, _ = await _target()
    assert runtime is not None
    assert runtime.default.estimate_seconds(20, guidance=False) is None


async def test_a_recognised_model_is_not_flagged_as_assumed(monkeypatch):
    await _connect("known")
    _inventory(monkeypatch, [Z_IMAGE])
    runtime, reason = await _target()
    assert runtime is not None
    assert runtime.assumed is False
    assert runtime.default.recognised is True
    assert "no measurements" not in reason


# --- picking the default ----------------------------------------------------------


async def test_the_default_is_the_fastest_model_serving(monkeypatch):
    """z-image is ~6.5s and qwen ~58s; defaulting to qwen taxes every agent."""
    await _connect("both")
    _inventory(monkeypatch, [QWEN_IMAGE, Z_IMAGE, CHAT_MODEL])
    runtime, reason = await _target()
    assert runtime is not None
    assert runtime.default.model == "z-image-turbo"
    assert [m.model for m in runtime.models] == ["z-image-turbo", "qwen-image-2512"]
    assert "+1 more" in reason


async def test_a_measured_model_outranks_an_unmeasured_one(monkeypatch):
    """Unknown cost sorts last rather than free — otherwise the untested path
    quietly becomes the common one."""
    await _connect("mixed")
    _inventory(monkeypatch, [UNKNOWN_IMAGE, QWEN_IMAGE])
    runtime, _ = await _target()
    assert runtime is not None
    assert runtime.default.model == "qwen-image-2512"
    # One of them is measured, so the runtime as a whole is not "assumed".
    assert runtime.assumed is False


async def test_models_from_several_connections_are_all_offered(monkeypatch):
    await _connect("box-a")
    await _connect("box-b")
    _inventory(monkeypatch, [Z_IMAGE])
    runtime, _ = await _target()
    assert runtime is not None
    assert len(runtime.models) == 2
    assert {m.connection_name for m in runtime.models} == {"box-a", "box-b"}


async def test_find_matches_exactly_then_by_unique_substring(monkeypatch):
    await _connect("both")
    _inventory(monkeypatch, [QWEN_IMAGE, Z_IMAGE])
    runtime, _ = await _target()
    assert runtime is not None
    assert runtime.find(None) is runtime.default
    assert runtime.find("qwen-image-2512").model == "qwen-image-2512"
    # An operator serving "qwen-image-2512" should not punish an agent that asked
    # for "qwen-image".
    assert runtime.find("qwen-image").model == "qwen-image-2512"
    assert runtime.find("QWEN-IMAGE-2512").model == "qwen-image-2512"
    assert runtime.find("nonesuch") is None


async def test_an_ambiguous_substring_resolves_to_nothing(monkeypatch):
    """Two candidates and a guess is worse than an error naming both."""
    await _connect("two-qwens")
    second = {
        **QWEN_IMAGE,
        "served_model_name": "qwen-image-2601",
        "running_instance": {"status": "running", "served_name": "qwen-image-2601"},
    }
    _inventory(monkeypatch, [QWEN_IMAGE, second])
    runtime, _ = await _target()
    assert runtime is not None
    assert runtime.find("qwen-image") is None


# --- the profile table -------------------------------------------------------------


def test_profile_matching_is_a_substring_of_the_served_name():
    assert profile_for("z-image-turbo").label == "Z-Image-Turbo"
    assert profile_for("my-box/Z-Image-Turbo").label == "Z-Image-Turbo"
    assert profile_for("qwen-image-2512").label == "Qwen-Image-2512"
    assert profile_for("something-else") is GENERIC_PROFILE
    assert profile_for("") is GENERIC_PROFILE


def test_guidance_halves_the_estimate_where_the_model_supports_it():
    """Guidance runs the transformer twice per step, so turning it off is ~half."""
    from app.agents.image_runtime import ImageModel

    qwen = ImageModel("c", "box", "qwen-image-2512", profile_for("qwen-image-2512"))
    with_cfg = qwen.estimate_seconds(25, guidance=True)
    without = qwen.estimate_seconds(25, guidance=False)
    assert with_cfg is not None and without is not None
    assert without < with_cfg < 2 * without + 1


# --- what a hosted row costs ---------------------------------------------------------


def _hosted(slug: str, *, rate=None, observed=None):
    """One OpenRouter row, with either kind of price attached, or neither."""
    from app.agents.image_runtime import ImageModel
    from app.media import refs
    from app.media.openrouter import ORImageModel

    return ImageModel(
        connection_id="",
        connection_name="OpenRouter",
        model=slug,
        provider=refs.OPENROUTER,
        catalogue=ORImageModel(slug=slug, label=slug, price=rate),
        observed_cost=observed,
    )


def test_a_published_rate_wins_over_what_this_install_has_paid():
    """The rate is a quote and the average is a rear-view mirror."""
    from app.media.openrouter import PriceQuote

    model = _hosted("x/y", rate=PriceQuote(0.03, "image"), observed=0.05)
    assert model.price == PriceQuote(0.03, "image")
    assert model.price_source == "catalogue"


def test_a_token_priced_model_falls_back_to_the_measured_average():
    model = _hosted("x/y", observed=0.05)
    quote = model.price
    assert quote is not None
    assert quote.amount == pytest.approx(0.05)
    assert quote.unit == "image"
    assert quote.approximate is True  # a mean of past runs, never a quote
    assert model.price_source == "observed"


def test_a_model_with_neither_is_unpriced_rather_than_free():
    model = _hosted("x/y")
    assert model.price is None
    assert model.price_source == ""


# --- caching -----------------------------------------------------------------------


async def test_the_served_model_answer_is_cached_per_connection(monkeypatch):
    """Resolution runs every turn of an image-enabled agent; an unreachable box
    would otherwise add its timeout to each one."""
    await _connect("cached")
    calls = 0
    real = runtime_mod.image_served_models

    async def counting(conn):  # noqa: ANN001
        nonlocal calls
        calls += 1
        return await real(conn)

    monkeypatch.setattr(runtime_mod, "image_served_models", counting)
    _inventory(monkeypatch, [Z_IMAGE])

    assert await _resolve() is not None
    assert await _resolve() is not None
    assert calls == 1

    reset_image_model_cache()
    assert await _resolve() is not None
    assert calls == 2


# --- the capability probe ------------------------------------------------------------


async def test_capability_probe_reports_the_default_and_the_alternatives(
    client: AsyncClient, monkeypatch
):
    """What the agent editor renders. A checkbox that silently does nothing is
    indistinguishable from a broken one, which is the whole reason this exists."""
    await _connect("spark-head")
    _inventory(monkeypatch, [QWEN_IMAGE, Z_IMAGE])

    body = (await client.get("/image/capability")).json()

    assert body["available"] is True
    assert body["model"] == "z-image-turbo"
    assert body["connection_name"] == "spark-head"
    assert body["models"] == ["z-image-turbo", "qwen-image-2512"]
    assert body["unrecognised"] is False
    assert "z-image-turbo on spark-head" in body["reason"]


async def test_capability_probe_says_why_when_nothing_serves(
    client: AsyncClient, monkeypatch
):
    await _connect("chat-only")
    _inventory(monkeypatch, [CHAT_MODEL])

    body = (await client.get("/image/capability")).json()

    assert body["available"] is False
    assert body["model"] is None
    assert body["models"] == []
    assert "no connected box is serving an image model" in body["reason"]


async def test_capability_probe_flags_an_unmeasured_model_as_usable(
    client: AsyncClient, monkeypatch
):
    """``unrecognised`` is not video's ``assumed``: this model genuinely works, it
    just gets conservative defaults and no estimate."""
    await _connect("future")
    _inventory(monkeypatch, [UNKNOWN_IMAGE])

    body = (await client.get("/image/capability")).json()

    assert body["available"] is True
    assert body["unrecognised"] is True
    assert body["model"] == "future-diffuser"
