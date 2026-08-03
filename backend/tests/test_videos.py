"""Tests for the video generation surface.

Two things are actually worth pinning down here, and they are both about
*where the request goes*:

1. Gateway-base derivation, which differs between a directly-reachable box and
   one behind a lastway tunnel. Getting this wrong sends every call to a port
   that nothing listens on.
2. The job lifecycle the gateway hands us — submit binds an id, follow-ups route
   on that id alone, and a forgotten id is a state to record rather than a crash.

The gateway is an httpx MockTransport, so no box (and no clip) is needed.
"""

from __future__ import annotations

import httpx
from httpx import AsyncClient

from app.db.models import LaiosConnection

# DB / workspace isolation and the ``client`` fixture live in ``conftest.py``.


async def _make_connection(client: AsyncClient, **overrides) -> dict:
    body = {
        "name": "video-box",
        "base_url": "http://127.0.0.1:7420",
        "master_key": "sk-laios-secret",
        **overrides,
    }
    r = await client.post("/laios/connections", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def test_gateway_base_direct_uses_derived_port():
    """A direct connection keeps host + the gateway's own port."""
    from app.api.laios import _derive_gateway_base

    conn = LaiosConnection(name="d", base_url="http://127.0.0.1:7420", master_key="k")
    # The daemon isn't running, so /v1/route fails and the default 4000 stands.
    assert await _derive_gateway_base(conn) == "http://127.0.0.1:4000/v1"


async def test_explicit_gateway_url_decouples_the_two_planes():
    """``gateway_url`` wins outright, and nothing is inferred from ``base_url``.

    This is the shape that matters in practice: management stays on the LAN while
    model traffic goes over a lastway tunnel. The two are unrelated addresses, so
    deriving one from the other would be wrong.
    """
    from app.api.laios import _derive_gateway_base

    conn = LaiosConnection(
        name="head-node",
        base_url="http://192.168.68.67:7420",
        gateway_url="https://spark-1bf6.lastway.lursor.com",
        master_key="k",
    )
    assert (
        await _derive_gateway_base(conn)
        == "https://spark-1bf6.lastway.lursor.com/v1"
    )

    # `/v1` already present, and a trailing slash, are the same endpoint — both
    # are things a person types for it.
    for raw in (
        "https://spark-1bf6.lastway.lursor.com/v1",
        "https://spark-1bf6.lastway.lursor.com/v1/",
        "https://spark-1bf6.lastway.lursor.com/",
    ):
        conn.gateway_url = raw
        assert (
            await _derive_gateway_base(conn)
            == "https://spark-1bf6.lastway.lursor.com/v1"
        )

    # Blank falls back to derivation rather than producing a bare "/v1".
    conn.gateway_url = "   "
    assert await _derive_gateway_base(conn) == "http://192.168.68.67:4000/v1"


async def test_gateway_base_tunnel_strips_control_prefix():
    """A tunnelled connection's gateway is the same origin, minus ``/control``.

    lastway publishes both origins on one hostname split by path, so there is no
    reachable ``:4000`` out here — deriving a port would break every call. The
    https scheme has to survive too.
    """
    from app.api.laios import _derive_gateway_base

    for base in (
        "https://spark-a.tunnel.example.com/control",
        "https://spark-a.tunnel.example.com/control/",
    ):
        conn = LaiosConnection(name="t", base_url=base, master_key="k")
        assert (
            await _derive_gateway_base(conn)
            == "https://spark-a.tunnel.example.com/v1"
        )


async def test_submit_poll_and_play(client: AsyncClient, monkeypatch):
    """The full lifecycle: submit binds a job, polling advances it, the clip is
    stored once and served back."""
    conn = await _make_connection(client)
    cid = conn["id"]
    captured: dict = {}
    polls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/videos" and request.method == "POST":
            captured["auth"] = request.headers.get("authorization")
            captured["body"] = request.content
            return httpx.Response(200, json={"id": "vid_1", "status": "queued"})
        if path == "/v1/videos/vid_1" and request.method == "GET":
            polls["n"] += 1
            if polls["n"] == 1:
                return httpx.Response(
                    200, json={"status": "in_progress", "progress": 0.5}
                )
            return httpx.Response(200, json={"status": "completed", "progress": 1.0})
        if path == "/v1/videos/vid_1/content":
            captured["variant"] = request.url.params.get("variant")
            return httpx.Response(
                200, content=b"\x00\x00\x00\x18ftypmp42", headers={"content-type": "video/mp4"}
            )
        return httpx.Response(404, json={"error": {"code": "not_found", "message": "x"}})

    _patch_gateway(monkeypatch, handler)

    # Submit. The body is relayed as sent and the master_key travels as Bearer.
    r = await client.post(
        f"/laios/connections/{cid}/videos",
        json={
            "model": "minimax-h3",
            "prompt": "a paper boat drifting across a puddle at dusk",
            "task": "t2va",
            "num_inference_steps": 8,
        },
    )
    assert r.status_code == 201, r.text
    job = r.json()
    assert job["job_id"] == "vid_1"
    assert job["status"] == "queued"
    assert captured["auth"] == "Bearer sk-laios-secret"
    assert b"paper boat" in captured["body"]

    # The list is served from our table, so the job survives independently of
    # the gateway's in-memory map.
    listed = (await client.get(f"/laios/connections/{cid}/videos")).json()
    assert [j["job_id"] for j in listed] == ["vid_1"]

    # Polling folds the gateway's status into the row.
    r = await client.get(f"/laios/connections/{cid}/videos/vid_1")
    assert r.json()["status"] == "in_progress"
    assert r.json()["progress"] == 0.5

    r = await client.get(f"/laios/connections/{cid}/videos/vid_1")
    assert r.json()["status"] == "completed"

    # A terminal job is answered from the row without touching the network.
    before = polls["n"]
    r = await client.get(f"/laios/connections/{cid}/videos/vid_1")
    assert r.json()["status"] == "completed"
    assert polls["n"] == before, "a finished job should not be re-polled"

    # The clip downloads, is stored, and the row records its media_id.
    r = await client.get(f"/laios/connections/{cid}/videos/vid_1/content")
    assert r.status_code == 200, r.text
    assert r.content.startswith(b"\x00\x00\x00\x18ftyp")
    assert captured["variant"] == "0"

    listed = (await client.get(f"/laios/connections/{cid}/videos")).json()
    assert listed[0]["media_id"], "the stored clip should be recorded on the row"


async def test_forgotten_job_is_recorded_not_raised(client: AsyncClient, monkeypatch):
    """A 404 on poll means the gateway lost the binding (its map is bounded and
    in-memory). That is a terminal state for the row, not a 404 to the UI —
    otherwise the page polls a job that will never advance, forever."""
    conn = await _make_connection(client, name="forgetful", base_url="http://f:7420")
    cid = conn["id"]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/videos" and request.method == "POST":
            return httpx.Response(200, json={"id": "vid_gone", "status": "queued"})
        return httpx.Response(
            404, json={"error": {"code": "not_found", "message": "unknown job"}}
        )

    _patch_gateway(monkeypatch, handler)

    await client.post(
        f"/laios/connections/{cid}/videos",
        json={"model": "minimax-h3", "prompt": "x"},
    )
    r = await client.get(f"/laios/connections/{cid}/videos/vid_gone")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "failed"
    assert "no longer knows" in r.json()["error"]


async def test_submit_requires_a_model(client: AsyncClient):
    """Only the submission names a model, so an empty one is rejected here rather
    than becoming an opaque gateway error."""
    conn = await _make_connection(client, name="nomodel", base_url="http://n:7420")
    r = await client.post(
        f"/laios/connections/{conn['id']}/videos", json={"prompt": "x"}
    )
    assert r.status_code == 400
    assert "model is required" in r.json()["detail"]


async def test_unreachable_gateway_is_502(client: AsyncClient, monkeypatch):
    conn = await _make_connection(client, name="down", base_url="http://down:7420")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    _patch_gateway(monkeypatch, handler)

    r = await client.post(
        f"/laios/connections/{conn['id']}/videos",
        json={"model": "minimax-h3", "prompt": "x"},
    )
    assert r.status_code == 502, r.text


def _patch_gateway(monkeypatch, handler) -> None:
    """Point the video module's gateway client at ``handler``.

    Also stubs base derivation: it would otherwise try to reach the daemon's
    ``/v1/route``, which is a different concern and is tested directly above.
    """
    from app.api import videos as videos_mod

    async def fake_base(conn):  # noqa: ANN001
        return "http://gateway.test/v1"

    async def fake_gateway(conn, timeout=None):  # noqa: ANN001
        return httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="http://gateway.test/v1",
            headers={"Authorization": f"Bearer {conn.master_key}"},
        )

    monkeypatch.setattr(videos_mod, "gateway_base", fake_base)
    monkeypatch.setattr(videos_mod, "_gateway", fake_gateway)
