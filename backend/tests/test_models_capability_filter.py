"""The chat picker must not offer a model that cannot chat.

A laios box's inference gateway advertises a flat OpenAI ``/v1/models`` list with
no capability field, so a generative-media model (MiniMax-H3, which speaks
``/v1/videos``) looks exactly like an LLM there. The control plane's inventory is
what knows better, and these tests pin the join — including that it fails *open*,
since hiding every model on a box we cannot classify is worse than showing one
that will not chat.
"""

from __future__ import annotations

import httpx
from httpx import AsyncClient

# DB / workspace isolation and the ``client`` fixture live in ``conftest.py``.

# One chat model and one video generator, as the control plane reports them.
INVENTORY = [
    {
        "id": "qwen3.6-27b-nvfp4",
        "capabilities": ["chat", "tools"],
        "served_model_name": "qwen3.6-27b-nvfp4",
        "running_instance": {
            "status": "running",
            "served_name": "qwen3.6-27b-nvfp4",
        },
    },
    {
        "id": "minimax-h3-fl2va",
        "capabilities": ["video"],
        "served_model_name": "minimax-h3",
        "running_instance": {"status": "running", "served_name": "minimax-h3"},
    },
]

# What the gateway itself advertises: both, indistinguishable. Defaults to the
# served names in INVENTORY, since the gateway list and the inventory describe
# the same box and a test where they disagree is testing nothing real.
GATEWAY_SERVED = ["qwen3.6-27b-nvfp4", "minimax-h3"]


def _handler(inventory, served, *, control_status: int = 200):
    """Mock transport standing in for one laios box + OpenRouter."""

    def handle(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/route":
            return httpx.Response(200, json={"gateway_listen": "0.0.0.0:4000"})
        # The control plane's inventory (carries capabilities). Distinguished
        # from the gateway's list by port: 7420 vs 4000.
        if path == "/v1/models" and request.url.port == 7420:
            if control_status >= 400:
                return httpx.Response(
                    control_status,
                    json={"error": {"code": "forbidden", "message": "nope"}},
                )
            return httpx.Response(200, json=inventory)
        if path == "/v1/models":
            return httpx.Response(
                200, json={"data": [{"id": name} for name in served]}
            )
        if path.endswith("/models"):
            return httpx.Response(200, json={"data": []})  # OpenRouter
        return httpx.Response(404, json={})

    return handle


async def _group_for(
    client: AsyncClient,
    monkeypatch,
    name: str,
    inventory,
    served: list[str] | None = None,
    **kwargs,
) -> dict | None:
    orig = httpx.AsyncClient
    gateway_served = GATEWAY_SERVED if served is None else served

    def mock_client(*args, **kw):
        kw["transport"] = httpx.MockTransport(
            _handler(inventory, gateway_served, **kwargs)
        )
        return orig(*args, **kw)

    monkeypatch.setattr(httpx, "AsyncClient", mock_client)

    r = await client.post(
        "/laios/connections",
        json={
            "name": name,
            "base_url": f"http://{name}:7420",
            "master_key": "sk-test",
        },
    )
    assert r.status_code == 201, r.text

    groups = (await client.get("/models")).json()
    return next((g for g in groups if g["label"] == name), None)


async def test_video_model_is_hidden_from_the_chat_picker(
    client: AsyncClient, monkeypatch
):
    """The generator is dropped; the chat model on the same box survives."""
    group = await _group_for(client, monkeypatch, "cap-filter", INVENTORY)
    assert group is not None, "the chat model should still produce a group"
    labels = {m["label"] for m in group["models"]}
    assert "qwen3.6-27b-nvfp4" in labels
    assert "minimax-h3" not in labels, "a video generator must not be chattable"


async def test_box_serving_only_a_generator_yields_no_group(
    client: AsyncClient, monkeypatch
):
    """Better no group than one unusable entry — which is the state the head node
    was actually in, serving nothing but MiniMax-H3."""
    only_video = [INVENTORY[1]]
    group = await _group_for(
        client, monkeypatch, "video-only", only_video, served=["minimax-h3"]
    )
    assert group is None


async def test_unreachable_control_plane_fails_open(client: AsyncClient, monkeypatch):
    """A tunnelled box without ``expose_control`` 403s the inventory. Hiding
    everything there would be a worse failure than showing a video model."""
    group = await _group_for(
        client, monkeypatch, "closed-control", INVENTORY, control_status=403
    )
    assert group is not None
    labels = {m["label"] for m in group["models"]}
    assert labels == {"qwen3.6-27b-nvfp4", "minimax-h3"}


async def test_model_declaring_both_chat_and_video_stays(
    client: AsyncClient, monkeypatch
):
    """The rule is "has no chat capability", not "mentions video" — so a
    hypothetical dual-surface model remains selectable."""
    dual = [
        {
            "id": "dual",
            "capabilities": ["chat", "video"],
            "served_model_name": "minimax-h3",
            "running_instance": {"status": "running", "served_name": "minimax-h3"},
        }
    ]
    group = await _group_for(client, monkeypatch, "dual-cap", dual)
    assert group is not None
    assert {m["label"] for m in group["models"]} == {
        "qwen3.6-27b-nvfp4",
        "minimax-h3",
    }


async def test_unstated_capabilities_are_not_hidden(client: AsyncClient, monkeypatch):
    """An older daemon that reports no capabilities at all must not have its
    models silently vanish."""
    no_caps = [
        {
            "id": "legacy",
            "capabilities": [],
            "served_model_name": "minimax-h3",
            "running_instance": {"status": "running", "served_name": "minimax-h3"},
        }
    ]
    group = await _group_for(client, monkeypatch, "legacy-caps", no_caps)
    assert group is not None
    assert "minimax-h3" in {m["label"] for m in group["models"]}
