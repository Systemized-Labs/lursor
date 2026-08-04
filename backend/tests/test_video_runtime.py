"""Resolving whether a run gets video tools at all — and failing closed.

The gate is two conditions: the agent's ``include_video`` flag, and a laios
connection actually *serving* a video-capable model. Either missing means the tools
are never built, which is the opposite policy from the chat picker's capability
filter (``non_chat_served_names``, which fails open). Both are right: the picker
hides on a guess and can afford to guess generously, while a generation tool built
against a box we cannot classify would 400 on every call, and the agent would be
left concluding it has a capability it does not.
"""

from __future__ import annotations

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import delete

from app.agents import video_runtime as runtime_mod
from app.agents.video_runtime import load_video_runtime, reset_video_model_cache
from app.db.models import LaiosConnection
from app.db.session import async_session_factory

CHAT_MODEL = {
    "id": "qwen3.6-27b-nvfp4",
    "capabilities": ["chat", "tools"],
    "served_model_name": "qwen3.6-27b-nvfp4",
    "running_instance": {"status": "running", "served_name": "qwen3.6-27b-nvfp4"},
}
VIDEO_MODEL = {
    "id": "minimax-h3-fl2va",
    "capabilities": ["video"],
    "served_model_name": "minimax-h3",
    "running_instance": {"status": "running", "served_name": "minimax-h3"},
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


def _inventory(monkeypatch, models, *, control_status: int = 200) -> None:
    """Point every httpx client at a fake laios control plane."""
    original = httpx.AsyncClient

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
        return original(*args, **kwargs)

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


async def test_flag_off_resolves_without_touching_the_network(monkeypatch):
    """The default-off flag has to be free, or every other agent pays for it."""
    await _connect("never-asked")

    async def boom(conn):  # noqa: ANN001
        raise AssertionError("the flag is off; nothing should ask the box anything")

    monkeypatch.setattr(runtime_mod, "video_served_names", boom)
    assert await _resolve(include_video=False) is None


async def test_no_connection_means_no_tools():
    assert await _resolve() is None


async def test_box_serving_only_chat_models_means_no_tools(monkeypatch):
    await _connect("chat-only")
    _inventory(monkeypatch, [CHAT_MODEL])
    assert await _resolve() is None


async def test_unclassifiable_box_fails_closed(monkeypatch):
    """A tunnelled box without ``expose_control`` 403s its inventory.

    The picker shows everything in that case; here we build nothing. A tool that
    400s on every call is worse than an absent one.
    """
    await _connect("closed-control")
    _inventory(monkeypatch, [VIDEO_MODEL], control_status=403)
    assert await _resolve() is None


async def test_model_that_is_installed_but_not_running_means_no_tools(monkeypatch):
    """95 GB of weights mid-load has an instance but no gateway route yet."""
    await _connect("loading")
    loading = {**VIDEO_MODEL, "running_instance": {"status": "starting"}}
    _inventory(monkeypatch, [loading])
    assert await _resolve() is None

    _inventory(monkeypatch, [{**VIDEO_MODEL, "running_instance": None}])
    reset_video_model_cache()
    assert await _resolve() is None


async def test_serving_box_resolves_to_its_served_name(monkeypatch):
    """The served name is what the gateway routes on — never the recipe id."""
    cid = await _connect("spark-head")
    _inventory(monkeypatch, [CHAT_MODEL, VIDEO_MODEL])

    resolved = await _resolve()
    assert resolved is not None
    assert resolved.connection_id == cid
    assert resolved.connection_name == "spark-head"
    assert resolved.model == "minimax-h3", "the recipe id would not route"
    # The constraints travel with the runtime so the tools can reject locally.
    assert resolved.constraints.short_edge == 768
    assert resolved.constraints.max_duration_seconds == 15.0


async def test_the_answer_is_cached_between_turns(monkeypatch):
    """Resolution runs on every turn of a video-enabled agent, so it must not cost
    a control-plane round trip every time."""
    await _connect("cached")
    calls = {"n": 0}

    async def counting(conn):  # noqa: ANN001
        calls["n"] += 1
        return {"minimax-h3"}

    monkeypatch.setattr(runtime_mod, "video_served_names", counting)
    assert (await _resolve()).model == "minimax-h3"
    assert (await _resolve()).model == "minimax-h3"
    assert calls["n"] == 1

    reset_video_model_cache()
    assert (await _resolve()).model == "minimax-h3"
    assert calls["n"] == 2
