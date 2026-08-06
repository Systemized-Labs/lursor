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

import json

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
        "/media/videos",
        json={
            "source": f"laios:{cid}",
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
    # the gateway's in-memory map — and it reconciles the active rows on the way
    # out (see ``_refresh_active``), which is what advances a job whose submitter
    # went away. That reconcile is this listing's poll.
    listed = (await client.get(f"/media/videos?source=laios:{cid}")).json()
    assert [j["job_id"] for j in listed] == ["vid_1"]
    assert listed[0]["status"] == "in_progress"
    assert listed[0]["progress"] == 0.5

    # Polling folds the gateway's status into the row.
    r = await client.get("/media/videos/vid_1")
    assert r.json()["status"] == "completed"

    # A terminal job is answered from the row without touching the network.
    before = polls["n"]
    r = await client.get("/media/videos/vid_1")
    assert r.json()["status"] == "completed"
    assert polls["n"] == before, "a finished job should not be re-polled"

    # The clip downloads, is stored, and the row records its media_id.
    r = await client.get("/media/videos/vid_1/content")
    assert r.status_code == 200, r.text
    assert r.content.startswith(b"\x00\x00\x00\x18ftyp")
    assert captured["variant"] == "0"

    listed = (await client.get(f"/media/videos?source=laios:{cid}")).json()
    assert listed[0]["media_id"], "the stored clip should be recorded on the row"


async def test_forgotten_job_is_recorded_not_raised(client: AsyncClient, monkeypatch):
    """A 404 on poll means the gateway lost the binding (its map is bounded and
    in-memory). That is a terminal state for the row, not a 404 to the UI —
    otherwise the page polls a job that will never advance, forever."""
    conn = await _make_connection(client, name="forgetful", base_url="http://f:7420")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/videos" and request.method == "POST":
            return httpx.Response(200, json={"id": "vid_gone", "status": "queued"})
        return httpx.Response(
            404, json={"error": {"code": "not_found", "message": "unknown job"}}
        )

    _patch_gateway(monkeypatch, handler)

    await client.post(
        "/media/videos",
        json={"model": "minimax-h3", "prompt": "x", "source": f"laios:{conn['id']}"},
    )
    r = await client.get("/media/videos/vid_gone")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "failed"
    assert "no longer knows" in r.json()["error"]


async def test_submit_requires_a_model(client: AsyncClient):
    """Only the submission names a model, so an empty one is rejected here rather
    than becoming an opaque gateway error."""
    await _make_connection(client, name="nomodel", base_url="http://n:7420")
    r = await client.post(
        "/media/videos", json={"prompt": "x"}
    )
    assert r.status_code == 400
    assert "model is required" in r.json()["detail"]


async def test_unreachable_gateway_is_502(client: AsyncClient, monkeypatch):
    conn = await _make_connection(client, name="down", base_url="http://down:7420")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    _patch_gateway(monkeypatch, handler)

    r = await client.post(
        "/media/videos",
        json={"model": "minimax-h3", "prompt": "x", "source": f"laios:{conn['id']}"},
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


async def test_engine_validation_message_reaches_the_client(
    client: AsyncClient, monkeypatch
):
    """A rejected knob must say which knob and what value would work.

    The gateway speaks two error shapes: its own OpenAI-style
    ``{"error": {...}}``, and FastAPI's ``{"detail": ...}`` for the engine's
    per-model request validation. Only the first was unwrapped, so every
    constraint violation — the common case, since limits like
    ``short_edge must be 768`` are not published anywhere the UI can read —
    collapsed to a bare "gateway returned HTTP 400".
    """
    conn = await _make_connection(client, name="strict", base_url="http://s:7420")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={"detail": "target.short_edge must be 768 for minimax_h3, got 1080"},
        )

    _patch_gateway(monkeypatch, handler)

    r = await client.post(
        "/media/videos",
        json={"model": "minimax-h3", "prompt": "x", "source": f"laios:{conn['id']}"},
    )
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == (
        "target.short_edge must be 768 for minimax_h3, got 1080"
    )


async def test_pydantic_style_validation_list_is_flattened(
    client: AsyncClient, monkeypatch
):
    """``detail`` may be a list of per-field errors; joining beats a Python repr."""
    conn = await _make_connection(client, name="listerr", base_url="http://l:7420")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            422,
            json={
                "detail": [
                    {
                        "loc": ["body", "target", "duration_seconds"],
                        "msg": "must be in [4, 15]",
                    }
                ]
            },
        )

    _patch_gateway(monkeypatch, handler)

    r = await client.post(
        "/media/videos",
        json={"model": "minimax-h3", "prompt": "x", "source": f"laios:{conn['id']}"},
    )
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "target.duration_seconds: must be in [4, 15]"


async def test_openai_shaped_error_still_unwraps(client: AsyncClient, monkeypatch):
    """The pre-existing shape must keep working alongside the new one."""
    conn = await _make_connection(client, name="oai", base_url="http://o:7420")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            404,
            json={"error": {"code": "video_not_found", "message": "no such job"}},
        )

    _patch_gateway(monkeypatch, handler)

    r = await client.post(
        "/media/videos",
        json={"model": "minimax-h3", "prompt": "x", "source": f"laios:{conn['id']}"},
    )
    assert r.status_code == 404, r.text
    assert r.json()["detail"] == "no such job (video_not_found)"


async def test_fl2va_keyframes_relay_as_json_and_are_not_stored_inline(
    client: AsyncClient, monkeypatch
):
    """First/last-frame conditioning goes over the ordinary JSON path.

    The engine resolves a condition's ``uri`` as a local path, an http(s) URL *or*
    an inline base64 payload, so an off-box Lursor needs no multipart branch — it
    inlines the frame. What must not happen is the megabyte of base64 landing in the
    row: ``request`` is read back by the history list on every poll, and the pixels
    are the one part of the submission nothing here needs to keep.
    """
    conn = await _make_connection(client, name="frames", base_url="http://f:7420")
    cid = conn["id"]
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["content_type"] = request.headers.get("content-type")
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"id": "vid_fl", "status": "queued"})

    _patch_gateway(monkeypatch, handler)

    inline = "data:image/png;base64," + ("A" * 4096)
    body = {
        "source": f"laios:{cid}",
        "model": "minimax-h3",
        "prompt": "the frame continues with calm, natural motion",
        "task": "fl2va",
        "conditions": [
            {"type": "image", "uri": inline, "role": "keyframe", "frame_index": 0}
        ],
        "target": {
            "short_edge": 768,
            "aspect_ratio": "auto",
            "duration_seconds": 5.0,
        },
        "num_inference_steps": 8,
    }
    r = await client.post("/media/videos", json=body)
    assert r.status_code == 201, r.text

    # Relayed verbatim, JSON, keyframe intact: the engine gets the pixels.
    assert captured["content_type"] == "application/json"
    assert captured["body"]["conditions"][0]["uri"] == inline
    assert captured["body"]["task"] == "fl2va"

    # Stored with the payload elided but the entry — and its frame_index — kept, so
    # the history still says what was asked for.
    stored = r.json()["request"]["conditions"][0]
    assert stored["frame_index"] == 0
    assert stored["role"] == "keyframe"
    assert "AAAA" not in stored["uri"]
    assert "image/png" in stored["uri"]
    assert r.json()["task"] == "fl2va"


async def test_listing_reconciles_a_job_nobody_is_polling(
    client: AsyncClient, monkeypatch
):
    """An orphaned job must not sit at ``queued`` forever.

    Nothing advances a job server-side: the browser polls per active job, and the
    backend refreshes a row only when asked. An agent that submitted and was then
    stopped leaves a row queued while the box happily finishes the render — a silent
    stall. Opening the history is what reconciles it.
    """
    conn = await _make_connection(client, name="orphan", base_url="http://orp:7420")
    cid = conn["id"]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"id": "vid_orphan", "status": "queued"})
        return httpx.Response(200, json={"status": "completed", "progress": 1.0})

    _patch_gateway(monkeypatch, handler)

    r = await client.post(
        "/media/videos",
        json={
            "source": f"laios:{cid}",
            "model": "minimax-h3",
            "prompt": "x",
            "num_inference_steps": 8,
        },
    )
    assert r.json()["status"] == "queued"

    listed = (await client.get(f"/media/videos?source=laios:{cid}")).json()
    assert listed[0]["status"] == "completed"
    assert listed[0]["progress"] == 1.0


async def test_listing_survives_an_unreachable_box(client: AsyncClient, monkeypatch):
    """The reconcile is best-effort: a box that is down leaves the rows alone.

    The history is exactly the surface an operator opens when a box is misbehaving,
    so it must not be the thing that 502s.
    """
    conn = await _make_connection(client, name="listdown", base_url="http://ld:7420")
    cid = conn["id"]

    def submit(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": "vid_down", "status": "queued"})

    _patch_gateway(monkeypatch, submit)
    await client.post(
        "/media/videos",
        json={"model": "minimax-h3", "prompt": "x", "source": f"laios:{cid}"},
    )

    def dead(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    _patch_gateway(monkeypatch, dead)
    r = await client.get(f"/media/videos?source=laios:{cid}")
    assert r.status_code == 200, r.text
    assert r.json()[0]["status"] == "queued"
