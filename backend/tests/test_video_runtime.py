"""Whether a run gets video tools at all — and why not, when it doesn't.

Two gates: the agent's ``include_video`` flag, and a connected box serving a video
model **this build knows how to drive**. The second half is the interesting one, and
it is not the same question as "is it video-capable".

The request surface is per-model, not per-engine: MiniMax-H3 takes its own canonical
body while the generic SGLang video API takes `seconds`/`size`. Guessing wrong does
not fail loudly — the engine drops fields it does not recognise and generates at its
own defaults — so the caller pays minutes of GPU for a clip of the wrong length with
its conditioning frames ignored, and gets HTTP 200. That is why an undeclared model
yields **no tools** rather than a hopeful request, and why this suite is mostly about
refusing things.

Fail-closed throughout, which is the opposite of the chat picker's filter
(``non_chat_served_names``, which fails open): the picker hides on a guess and can
afford to guess generously.
"""

from __future__ import annotations

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import delete

from app.agents import video_runtime as runtime_mod
from app.agents.video_runtime import (
    SCHEMA_MINIMAX_H3,
    SCHEMA_SGLANG_VIDEO,
    load_video_runtime,
    reset_video_model_cache,
    resolve_video_target,
)
from app.db.models import LaiosConnection
from app.db.session import async_session_factory

CHAT_MODEL = {
    "id": "qwen3.6-27b-nvfp4",
    "capabilities": ["chat", "tools"],
    "served_model_name": "qwen3.6-27b-nvfp4",
    "running_instance": {"status": "running", "served_name": "qwen3.6-27b-nvfp4"},
}

# H3 as the box reports it *today*: video-capable, running, and no profile — the
# grandfathered case, since it predates the recipe block.
H3_UNPROFILED = {
    "id": "minimax-h3-fl2va",
    "recipe_id": "minimax-h3-fl2va",
    "model_id": "MiniMaxAI/MiniMax-H3",
    "capabilities": ["video"],
    "served_model_name": "minimax-h3",
    "running_instance": {"status": "running", "served_name": "minimax-h3"},
}

H3_PROFILE = {
    "request_schema": SCHEMA_MINIMAX_H3,
    "short_edge": 768,
    "aspect_ratios": ["16:9", "9:16", "1:1"],
    "sizes": {"16:9": "1344x768"},
    "duration_seconds": {"min": 4.0, "max": 15.0},
    "num_inference_steps": {"min": 4, "max": 50},
    "seconds_per_step": 44,
    "keyframes": True,
    "audio": True,
}

# A hypothetical second video model, declaring the generic request shape.
OTHER_VIDEO = {
    "id": "wan-t2v",
    "recipe_id": "wan-t2v",
    "model_id": "Wan-AI/Wan2.2-T2V",
    "capabilities": ["video"],
    "served_model_name": "wan-t2v",
    "running_instance": {"status": "running", "served_name": "wan-t2v"},
    "video_profile": {
        "request_schema": SCHEMA_SGLANG_VIDEO,
        "aspect_ratios": ["16:9"],
        "sizes": {"16:9": "1280x720"},
        "duration_seconds": {"min": 1.0, "max": 5.0},
        "num_inference_steps": {"min": 10, "max": 40},
        "seconds_per_step": 3,
        "keyframes": False,
        "audio": False,
    },
}


@pytest.fixture(autouse=True)
async def _fresh_state(client: AsyncClient):
    """A clean connections table and a cold cache for each case.

    The suite shares one SQLite file and ``init_db`` does not drop tables, so a
    connection left by an earlier case would be the one resolution picks (it orders
    by ``created_at``). The 5-minute served-model cache would leak across cases for
    the same reason.
    """
    reset_video_model_cache()
    async with async_session_factory() as session:
        await session.execute(delete(LaiosConnection))
        await session.commit()
    yield
    reset_video_model_cache()


# Captured before any patching. Taking ``httpx.AsyncClient`` *inside* the helper
# would capture a previous mock on the second call, and that mock overwrites the
# transport again on its way out — so the first inventory would keep winning and a
# test that changes what the box serves would silently assert the old state.
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


async def _resolve(*, include_video: bool = True):
    async with async_session_factory() as session:
        return await load_video_runtime(session, include_video=include_video)


async def _target():
    async with async_session_factory() as session:
        return await resolve_video_target(session)


# --- the gates ------------------------------------------------------------------


async def test_flag_off_resolves_without_touching_the_network(monkeypatch):
    """The default-off flag has to be free, or every other agent pays for it."""
    await _connect("never-asked")

    async def boom(conn):  # noqa: ANN001
        raise AssertionError("the flag is off; nothing should ask the box anything")

    monkeypatch.setattr(runtime_mod, "video_served_models", boom)
    assert await _resolve(include_video=False) is None


async def test_no_connection_means_no_tools():
    runtime, reason = await _target()
    assert runtime is None
    assert "no laios connection" in reason


async def test_box_serving_only_chat_models_means_no_tools(monkeypatch):
    await _connect("chat-only")
    _inventory(monkeypatch, [CHAT_MODEL])
    runtime, reason = await _target()
    assert runtime is None
    assert "no connected box is serving a video model" in reason


async def test_unclassifiable_box_fails_closed(monkeypatch):
    """A tunnelled box without ``expose_control`` 403s its inventory.

    The picker shows everything in that case; here we build nothing. A tool that
    400s on every call is worse than an absent one.
    """
    await _connect("closed-control")
    _inventory(monkeypatch, [H3_UNPROFILED], control_status=403)
    assert await _resolve() is None


async def test_model_that_is_installed_but_not_running_means_no_tools(monkeypatch):
    """95 GB of weights mid-load has an instance but no gateway route yet."""
    await _connect("loading")
    _inventory(monkeypatch, [{**H3_UNPROFILED, "running_instance": {"status": "starting"}}])
    assert await _resolve() is None

    reset_video_model_cache()
    _inventory(monkeypatch, [{**H3_UNPROFILED, "running_instance": None}])
    assert await _resolve() is None


# --- how the request shape is decided -------------------------------------------


async def test_a_declared_profile_drives_the_model(monkeypatch):
    """The point of the recipe block: constraints come from the model, not from us."""
    cid = await _connect("spark-head")
    _inventory(monkeypatch, [CHAT_MODEL, {**H3_UNPROFILED, "video_profile": H3_PROFILE}])

    runtime, reason = await _target()
    assert runtime is not None
    assert runtime.connection_id == cid
    assert runtime.model == "minimax-h3", "the recipe id would not route"
    assert runtime.request_schema == SCHEMA_MINIMAX_H3
    assert runtime.assumed is False, "declared, not guessed"
    assert SCHEMA_MINIMAX_H3 in reason
    limits = runtime.constraints
    assert (limits.min_duration_seconds, limits.max_duration_seconds) == (4.0, 15.0)
    assert (limits.min_steps, limits.max_steps) == (4, 50)
    assert limits.short_edge == 768
    assert limits.keyframes and limits.emits_audio


async def test_a_second_model_needs_no_code_change(monkeypatch):
    """A model that is not H3, driven from what its own profile declares."""
    await _connect("other-box")
    _inventory(monkeypatch, [OTHER_VIDEO])

    runtime, _ = await _target()
    assert runtime is not None
    assert runtime.model == "wan-t2v"
    assert runtime.request_schema == SCHEMA_SGLANG_VIDEO
    limits = runtime.constraints
    # Its numbers, not H3's — the whole point.
    assert (limits.min_duration_seconds, limits.max_duration_seconds) == (1.0, 5.0)
    assert (limits.min_steps, limits.max_steps) == (10, 40)
    assert limits.short_edge is None
    assert limits.keyframes is False
    assert limits.emits_audio is False
    assert limits.seconds_per_step == 3


async def test_h3_without_a_profile_is_grandfathered(monkeypatch):
    """H3 predates the profile and is the only video recipe in the wild.

    Requiring a declaration would turn a working box off on upgrade, so its identity
    is recognised — and the runtime says the shape was *assumed* rather than declared.
    """
    await _connect("legacy-h3")
    _inventory(monkeypatch, [H3_UNPROFILED])

    runtime, reason = await _target()
    assert runtime is not None
    assert runtime.request_schema == SCHEMA_MINIMAX_H3
    assert runtime.assumed is True
    assert "assumed" in reason
    # The measured H3 constraints, since there is no profile to read them from.
    assert runtime.constraints.short_edge == 768
    assert runtime.constraints.max_duration_seconds == 15.0


async def test_h3_is_recognised_by_served_name_when_the_repo_is_unknown(monkeypatch):
    """A locally-built or renamed H3 still has ``minimax-h3`` somewhere."""
    await _connect("renamed-h3")
    _inventory(
        monkeypatch,
        [{**H3_UNPROFILED, "model_id": "", "recipe_id": "minimax-h3-fl2va-fp8"}],
    )
    runtime, _ = await _target()
    assert runtime is not None and runtime.assumed is True


async def test_an_undeclared_unknown_video_model_gets_no_tools(monkeypatch):
    """The failure this design exists to prevent.

    Driving it with H3's body would not error: the engine would drop `task`/`target`,
    fall back to its own 4-second default, ignore any keyframe, and bill the GPU for
    a clip nobody asked for. No tools is the honest answer.
    """
    await _connect("mystery")
    _inventory(monkeypatch, [{k: v for k, v in OTHER_VIDEO.items() if k != "video_profile"}])

    runtime, reason = await _target()
    assert runtime is None
    assert "does not declare a request shape" in reason


async def test_a_profile_naming_a_schema_we_cannot_build_is_refused(monkeypatch):
    """Forward compatibility cuts both ways: a newer recipe may out-run this build."""
    await _connect("future")
    _inventory(
        monkeypatch,
        [
            {
                **OTHER_VIDEO,
                "video_profile": {"request_schema": "some.future.schema/v9"},
            }
        ],
    )
    runtime, reason = await _target()
    assert runtime is None
    assert "does not declare a request shape" in reason


async def test_a_profile_with_no_schema_is_refused(monkeypatch):
    """``request_schema`` is the one field with no sensible default."""
    await _connect("halfdeclared")
    _inventory(
        monkeypatch,
        [{**OTHER_VIDEO, "video_profile": {"short_edge": 768, "keyframes": True}}],
    )
    assert await _resolve() is None


async def test_a_declared_model_wins_over_an_undriveable_one(monkeypatch):
    """One unusable model on a box must not hide a usable one next to it."""
    await _connect("mixed")
    _inventory(
        monkeypatch,
        [
            {k: v for k, v in OTHER_VIDEO.items() if k != "video_profile"},
            {**H3_UNPROFILED, "video_profile": H3_PROFILE},
        ],
    )
    runtime, _ = await _target()
    assert runtime is not None and runtime.model == "minimax-h3"


async def test_a_partial_profile_leaves_knobs_unconstrained(monkeypatch):
    """Missing ranges must not silently inherit H3's, or a 5-second-max model would
    accept 15 and fail on the box."""
    await _connect("sparse")
    _inventory(
        monkeypatch,
        [{**OTHER_VIDEO, "video_profile": {"request_schema": SCHEMA_SGLANG_VIDEO}}],
    )
    runtime, _ = await _target()
    assert runtime is not None
    limits = runtime.constraints
    assert limits.min_duration_seconds == 0.0
    assert limits.max_duration_seconds == float("inf")
    assert limits.aspect_ratios == ()
    assert limits.sizes == {}
    assert limits.keyframes is False


async def test_a_malformed_range_is_ignored_rather_than_crashing(monkeypatch):
    """The profile is operator-written YAML that reached us over the network."""
    await _connect("typo")
    _inventory(
        monkeypatch,
        [
            {
                **OTHER_VIDEO,
                "video_profile": {
                    "request_schema": SCHEMA_SGLANG_VIDEO,
                    "duration_seconds": {"min": "four", "max": 15},
                    "num_inference_steps": {"max": 50},
                    "short_edge": "wide",
                    "aspect_ratios": "16:9",
                    "sizes": ["16:9"],
                    "seconds_per_step": "fast",
                },
            }
        ],
    )
    runtime, _ = await _target()
    assert runtime is not None
    limits = runtime.constraints
    assert limits.max_duration_seconds == float("inf")
    assert limits.short_edge is None
    assert limits.aspect_ratios == ()
    assert limits.sizes == {}
    assert limits.seconds_per_step == 44


async def test_the_answer_is_cached_between_turns(monkeypatch):
    """Resolution runs on every turn of a video-enabled agent, so it must not cost
    a control-plane round trip every time."""
    await _connect("cached")
    calls = {"n": 0}

    from app.api.laios import VideoServedModel

    async def counting(conn):  # noqa: ANN001
        calls["n"] += 1
        return [
            VideoServedModel(
                served_name="minimax-h3",
                model_id="MiniMaxAI/MiniMax-H3",
                recipe_id="minimax-h3-fl2va",
                profile=None,
            )
        ]

    monkeypatch.setattr(runtime_mod, "video_served_models", counting)
    assert (await _resolve()).model == "minimax-h3"
    assert (await _resolve()).model == "minimax-h3"
    assert calls["n"] == 1

    reset_video_model_cache()
    assert (await _resolve()).model == "minimax-h3"
    assert calls["n"] == 2


# --- the operator-facing probe ---------------------------------------------------


async def test_the_capability_endpoint_explains_itself(client: AsyncClient, monkeypatch):
    """A checkbox that silently does nothing is indistinguishable from a broken one."""
    r = await client.get("/video/capability")
    assert r.status_code == 200, r.text
    assert r.json() == {
        "available": False,
        # The source is the first thing the editor has to say, because a "no" that
        # does not name it reads as broken rather than as unconfigured.
        "source": None,
        "model": None,
        "connection_name": None,
        "assumed": False,
        "price": None,
        "pinned": False,
        "reason": "no laios connection is configured",
    }

    await _connect("spark-head")
    _inventory(monkeypatch, [{**H3_UNPROFILED, "video_profile": H3_PROFILE}])
    reset_video_model_cache()
    body = (await client.get("/video/capability")).json()
    assert body["available"] is True
    assert body["model"] == "minimax-h3"
    assert body["connection_name"] == "spark-head"
    assert body["assumed"] is False

    # The grandfathered case is reported as assumed, not hidden.
    reset_video_model_cache()
    _inventory(monkeypatch, [H3_UNPROFILED])
    assert (await client.get("/video/capability")).json()["assumed"] is True

    # And an undriveable box says so rather than claiming availability.
    reset_video_model_cache()
    _inventory(
        monkeypatch,
        [{k: v for k, v in OTHER_VIDEO.items() if k != "video_profile"}],
    )
    body = (await client.get("/video/capability")).json()
    assert body["available"] is False
    assert "does not declare a request shape" in body["reason"]
