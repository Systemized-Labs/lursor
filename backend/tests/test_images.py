"""Tests for the image generation surface.

What is worth pinning down here is different from the video suite's concerns,
because the engine's API is different. There is no job to bind, no id to route
follow-ups on and nothing to poll, so the interesting behaviour is all in the
consequences of making a *synchronous* API durable:

1. **The submit returns before the image does.** The row is created ``running``
   and a background task fills it in, so a client never holds a 2-minute request.
2. **The two overrides stick.** ``response_format: "b64_json"`` (or the bytes do
   not survive the container) and ``n: 1`` (or a row's single ``media_id`` is a
   lie), whatever the caller asked for.
3. **A failure lands on the row, not on the floor.** Nobody is awaiting the task,
   so an error that does not reach a terminal status is an orphan nothing repairs.
4. **Orphans are reaped.** A ``running`` row with no task behind it — a restart
   mid-generation — is failed on the next read rather than spinning forever.
5. **The stored type is the real type**, sniffed from the bytes rather than taken
   from the ``output_format`` the engine was free to ignore.

The gateway is an httpx MockTransport, so no box (and no GPU) is needed.
"""

from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest
from httpx import AsyncClient

from app.config import get_settings

# DB / workspace isolation and the ``client`` fixture live in ``conftest.py``.

# Smallest bytes that are unambiguously each format, for the mime sniffer.
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 16
WEBP = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 16


@pytest.fixture(autouse=True)
async def _isolate(tmp_path, monkeypatch, client):
    """Keep generated images off the real media dir, and the DB as we found it.

    The cleanup is not decoration. The test database is shared across modules and
    at least one other suite asserts on the *entire* connections table
    (``test_laios``), so a module that leaves connections behind breaks whichever
    suite sorts after it — a failure that only appears in a full run and points at
    innocent code. Cheaper to not litter.
    """
    monkeypatch.setattr(get_settings(), "media_dir", tmp_path / "media")
    yield
    for conn in (await client.get("/laios/connections")).json():
        await client.delete(f"/laios/connections/{conn['id']}")


async def _make_connection(client: AsyncClient, **overrides) -> dict:
    body = {
        "name": "image-box",
        "base_url": "http://127.0.0.1:7420",
        "master_key": "sk-laios-secret",
        **overrides,
    }
    r = await client.post("/laios/connections", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _patch_gateway(monkeypatch, handler) -> None:
    """Point the image module's gateway client at ``handler``.

    Also stubs base derivation, which would otherwise try to reach the daemon's
    ``/v1/route`` — a different concern, tested in ``test_videos``.
    """
    from app.api import images as images_mod

    async def fake_base(conn):  # noqa: ANN001
        return "http://gateway.test/v1"

    async def fake_gateway(conn, timeout=None):  # noqa: ANN001
        return httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="http://gateway.test/v1",
            headers={"Authorization": f"Bearer {conn.master_key}"},
        )

    monkeypatch.setattr(images_mod, "gateway_base", fake_base)
    monkeypatch.setattr(images_mod, "_gateway", fake_gateway)


def _generations(
    captured: dict, *, image: bytes = JPEG, **extra
):
    """A handler that answers ``/images/generations`` with ``image`` as b64."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/images/generations" and request.method == "POST":
            captured["auth"] = request.headers.get("authorization")
            captured["body"] = request.content
            return httpx.Response(
                200,
                json={
                    "id": "img_1",
                    "created": 1,
                    "data": [{"b64_json": base64.b64encode(image).decode()}],
                    "inference_time_s": 6.5,
                    "peak_memory_mb": 24522.0,
                    **extra,
                },
            )
        return httpx.Response(404, json={"error": {"code": "nope", "message": "x"}})

    return handler


async def _settle(run_id: str) -> None:
    """Wait for the background generation task, if it is still running.

    The route deliberately returns before the image exists, so every assertion
    about a *finished* generation has to join the task first. Reading the module's
    ``_active`` map is also what proves the row is tracked — an untracked running
    row is precisely the orphan case below.
    """
    from app.api import images as images_mod

    task = images_mod._active.get(run_id)
    if task is not None:
        await asyncio.wait_for(asyncio.shield(task), timeout=10)


async def test_submit_returns_before_the_image_and_then_completes(
    client: AsyncClient, monkeypatch
):
    """The whole point of the background task: a submit is fast, the row fills in.

    A synchronous relay would have held this POST open for the entire denoise —
    up to two minutes on ``qwen-image-2512`` — and lost the result to any reload.
    """
    conn = await _make_connection(client)
    cid = conn["id"]
    captured: dict = {}
    _patch_gateway(monkeypatch, _generations(captured))

    r = await client.post(
        "/media/images",
        json={
            "model": "z-image-turbo",
            "prompt": "a paper boat drifting across a puddle at dusk",
            "size": "1024x1024",
            "num_inference_steps": 9,
        },
    )
    assert r.status_code == 201, r.text
    run = r.json()
    # Returned before the gateway was ever asked for pixels.
    assert run["status"] == "running"
    assert run["media_id"] is None

    await _settle(run["id"])

    # The master_key travelled as Bearer, and the prompt was relayed.
    assert captured["auth"] == "Bearer sk-laios-secret"
    assert b"paper boat" in captured["body"]

    r = await client.get("/media/images/" + run["id"])
    assert r.status_code == 200, r.text
    done = r.json()
    assert done["status"] == "completed"
    assert done["media_id"], "the stored image should be recorded on the row"
    assert done["upstream_id"] == "img_1"
    # The engine's own measurements, which are the reason the page exists.
    assert done["inference_time_s"] == 6.5
    assert done["peak_memory_mb"] == 24522.0
    assert done["error"] is None

    # And the bytes serve back.
    r = await client.get("/media/images/" + run["id"] + "/content")
    assert r.status_code == 200, r.text
    assert r.content == JPEG
    assert r.headers["content-type"] == "image/jpeg"

    listed = (await client.get(f"/media/images?source=laios:{cid}")).json()
    assert [item["id"] for item in listed] == [run["id"]]


async def test_response_format_and_n_are_forced(client: AsyncClient, monkeypatch):
    """The two overrides hold even when the caller asks for the opposite.

    ``url`` would leave the bytes in the container's output directory, where they
    do not survive the instance being recreated — so a durable history is
    impossible on that path. ``n > 1`` would return images a single ``media_id``
    column cannot hold.
    """
    await _make_connection(client, name="forced", base_url="http://f:7420")
    captured: dict = {}
    _patch_gateway(monkeypatch, _generations(captured))

    r = await client.post(
        "/media/images",
        json={
            "model": "z-image-turbo",
            "prompt": "x",
            "response_format": "url",
            "n": 4,
        },
    )
    run = r.json()
    await _settle(run["id"])

    sent = json.loads(captured["body"])
    assert sent["response_format"] == "b64_json"
    assert sent["n"] == 1

    # And the row records what was really sent, not what was asked for — the
    # request is what "reuse" reloads.
    stored = (await client.get("/media/images/" + run["id"])).json()
    assert stored["request"]["response_format"] == "b64_json"
    assert stored["request"]["n"] == 1


async def test_engine_validation_message_lands_on_the_row(
    client: AsyncClient, monkeypatch
):
    """A rejected knob must say which knob, and it has to reach the row.

    Nobody is awaiting the background task, so an error that is not written down
    is an error nobody ever sees. The engine's per-model validation arrives as
    FastAPI's ``{"detail": [...]}``, which is the shape that used to collapse to
    a bare "HTTP 400" before ``gateway_error_detail`` unwrapped both.
    """
    await _make_connection(client, name="strict", base_url="http://s:7420")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "detail": [
                    {
                        "loc": ["body", "size"],
                        "msg": "size must be a multiple of 64",
                    }
                ]
            },
        )

    _patch_gateway(monkeypatch, handler)

    r = await client.post(
        "/media/images",
        json={"model": "z-image-turbo", "prompt": "x", "size": "1000x1000"},
    )
    # Accepted: the request was well-formed as far as this end could tell.
    assert r.status_code == 201, r.text
    run = r.json()
    await _settle(run["id"])

    failed = (await client.get("/media/images/" + run["id"])).json()
    assert failed["status"] == "failed"
    assert "multiple of 64" in failed["error"]
    assert "size" in failed["error"]
    assert failed["media_id"] is None


async def test_unreachable_gateway_fails_the_row(client: AsyncClient, monkeypatch):
    """A box that is down is a failed run with a reason, not a silent spinner."""
    await _make_connection(client, name="down", base_url="http://down:7420")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    _patch_gateway(monkeypatch, handler)

    run = (
        await client.post(
            "/media/images",
            json={"model": "z-image-turbo", "prompt": "x"},
        )
    ).json()
    await _settle(run["id"])

    failed = (await client.get("/media/images/" + run["id"])).json()
    assert failed["status"] == "failed"
    assert "could not reach" in failed["error"]


async def test_orphaned_running_row_is_reaped(client: AsyncClient, monkeypatch):
    """A ``running`` row with no live task is failed, not left spinning.

    This is the state a restart mid-generation leaves behind: the task died with
    the process, the row did not. Simulated by dropping the task from the
    tracking map, which is exactly what losing the process does.
    """
    await _make_connection(client, name="orphan", base_url="http://o:7420")
    captured: dict = {}

    # A gateway that never answers, so the row stays running while we orphan it.
    async def never(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(30)
        return httpx.Response(200, json={})

    _patch_gateway(monkeypatch, never)

    run = (
        await client.post(
            "/media/images",
            json={"model": "z-image-turbo", "prompt": "x"},
        )
    ).json()
    assert run["status"] == "running"

    from app.api import images as images_mod

    # Lose the task the way a restart would.
    task = images_mod._active.pop(run["id"])
    task.cancel()

    listed = (await client.get("/media/images")).json()
    assert listed[0]["status"] == "failed"
    assert "restarted" in listed[0]["error"]
    assert captured == {}


async def test_url_response_falls_back_to_the_content_endpoint(
    client: AsyncClient, monkeypatch
):
    """A response with no ``b64_json`` is fetched by id instead of being dropped.

    We ask for b64, but the engine's own default is ``url`` and a differently
    configured serve could answer that way regardless. The id is what the gateway
    routes on, so the path is constructed from it rather than trusting a URL the
    docs describe as relative.
    """
    await _make_connection(client, name="urlish", base_url="http://u:7420")
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/images/generations":
            return httpx.Response(
                200,
                json={
                    "id": "img_url",
                    "data": [{"url": "/v1/images/img_url/content"}],
                },
            )
        if request.url.path == "/v1/images/img_url/content":
            seen["fetched"] = True
            return httpx.Response(
                200, content=PNG, headers={"content-type": "image/png"}
            )
        return httpx.Response(404, json={"error": {"message": "no"}})

    _patch_gateway(monkeypatch, handler)

    run = (
        await client.post(
            "/media/images",
            json={"model": "z-image-turbo", "prompt": "x"},
        )
    ).json()
    await _settle(run["id"])

    done = (await client.get("/media/images/" + run["id"])).json()
    assert seen.get("fetched"), "the id should have been used to fetch the bytes"
    assert done["status"] == "completed"

    r = await client.get("/media/images/" + run["id"] + "/content")
    assert r.content == PNG
    assert r.headers["content-type"] == "image/png"


@pytest.mark.parametrize(
    ("image", "asked_for", "expected"),
    [
        # The engine ignored output_format and sent PNG anyway: the stored type
        # has to follow the bytes, or the browser is told a PNG is a JPEG.
        (PNG, "jpeg", "image/png"),
        (JPEG, "png", "image/jpeg"),
        (WEBP, "jpeg", "image/webp"),
    ],
)
async def test_stored_type_is_sniffed_not_assumed(
    client: AsyncClient, monkeypatch, image: bytes, asked_for: str, expected: str
):
    """``output_format`` is a request, not a promise, and b64 carries no mime."""
    await _make_connection(
        client, name=f"sniff-{asked_for}-{expected[6:]}", base_url="http://sn:7420"
    )
    _patch_gateway(monkeypatch, _generations({}, image=image))

    run = (
        await client.post(
            "/media/images",
            json={
                "model": "z-image-turbo",
                "prompt": "x",
                "output_format": asked_for,
            },
        )
    ).json()
    await _settle(run["id"])

    r = await client.get("/media/images/" + run["id"] + "/content")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == expected


async def test_submit_requires_a_model_and_a_prompt(client: AsyncClient):
    """Both are rejected here rather than becoming an opaque gateway error — and
    without leaving a row behind for a request that never left the building."""
    conn = await _make_connection(client, name="bare", base_url="http://b:7420")
    cid = conn["id"]

    r = await client.post("/media/images", json={"prompt": "x"})
    assert r.status_code == 400
    assert "model is required" in r.json()["detail"]

    r = await client.post(
        "/media/images", json={"model": "z-image-turbo"}
    )
    assert r.status_code == 400
    assert "prompt is required" in r.json()["detail"]

    # Scoped to this test's own box: the list is no longer connection-keyed, so
    # "no row was left behind" has to be asked about this connection specifically.
    assert (await client.get(f"/media/images?source=laios:{cid}")).json() == []


async def test_delete_removes_the_run(client: AsyncClient, monkeypatch):
    """Delete is the history's eraser. It is deliberately not a cancel: the image
    API has none, so a generation already on a GPU keeps it either way."""
    conn = await _make_connection(client, name="deleter", base_url="http://d:7420")
    cid = conn["id"]
    _patch_gateway(monkeypatch, _generations({}))

    run = (
        await client.post(
            "/media/images",
            json={"model": "z-image-turbo", "prompt": "x"},
        )
    ).json()
    await _settle(run["id"])

    r = await client.delete("/media/images/" + run["id"])
    assert r.status_code == 200, r.text
    assert (await client.get(f"/media/images?source=laios:{cid}")).json() == []
    assert (
        await client.get("/media/images/" + run["id"])
    ).status_code == 404


async def test_content_is_404_while_still_running(client: AsyncClient, monkeypatch):
    """Asking for pixels that do not exist yet says so, rather than 500ing."""
    await _make_connection(client, name="early", base_url="http://e:7420")

    async def never(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(30)
        return httpx.Response(200, json={})

    _patch_gateway(monkeypatch, never)

    run = (
        await client.post(
            "/media/images",
            json={"model": "z-image-turbo", "prompt": "x"},
        )
    ).json()

    r = await client.get("/media/images/" + run["id"] + "/content")
    assert r.status_code == 404
    assert "no image" in r.json()["detail"]

    from app.api import images as images_mod

    if task := images_mod._active.pop(run["id"], None):
        task.cancel()


async def test_the_list_filters_by_source_but_defaults_to_everything(
    client: AsyncClient, monkeypatch
):
    """``?source=`` narrows the history; omitting it returns all of it.

    Deliberately different from the old connection-keyed list. A run id is a uuid
    and is now readable on its own, and the gallery has to keep showing images made
    before a source change — a history that emptied itself when someone switched
    from a box to OpenRouter would read as data loss.
    """
    a = await _make_connection(client, name="box-a", base_url="http://a:7420")
    b = await _make_connection(client, name="box-b", base_url="http://b2:7420")
    _patch_gateway(monkeypatch, _generations({}))

    run = (
        await client.post(
            "/media/images",
            json={
                "source": f"laios:{a['id']}",
                "model": "z-image-turbo",
                "prompt": "only on a",
            },
        )
    ).json()
    await _settle(run["id"])

    assert len((await client.get(f"/media/images?source=laios:{a['id']}")).json()) == 1
    assert (await client.get(f"/media/images?source=laios:{b['id']}")).json() == []
    assert (await client.get("/media/images?source=openrouter")).json() == []
    # Unfiltered means every source. Asserted by membership rather than by count:
    # this module shares its database with the rest of the suite.
    unfiltered = (await client.get("/media/images")).json()
    assert run["id"] in {item["id"] for item in unfiltered}
    # The run is readable by id alone — there is no connection in the path.
    assert (await client.get(f"/media/images/{run['id']}")).status_code == 200


async def test_an_unparseable_source_is_rejected(client: AsyncClient):
    assert (await client.get("/media/images?source=comfyui")).status_code == 400


async def test_a_new_run_is_tracked_before_the_route_returns(
    client: AsyncClient, monkeypatch
):
    """``_active`` is populated synchronously, and things depend on it.

    ``create_image`` registers the task with no ``await`` between the
    ``create_task`` and the assignment, which is what makes ``_reap_orphans``
    exact: a ``running`` row absent from the map means "nothing is generating
    this". Slip an await in there and the very next read — the page's poll, or
    ``agents/image_tools``' wait, which starts polling immediately — reaps a live
    generation into a ``failed`` row blaming a restart that never happened.

    Asserted the moment the response lands, before anything is settled.
    """
    from app.api import images as images_mod

    await _make_connection(client)
    _patch_gateway(monkeypatch, _generations({}))

    run = (
        await client.post(
            "/media/images",
            json={"model": "z-image-turbo", "prompt": "tracked"},
        )
    ).json()

    assert run["status"] == "running"
    assert run["id"] in images_mod._active, (
        "a running row that is not in _active is the orphan case, and would be "
        "reaped on the next read"
    )

    # And reading it right now must not fail it.
    still = (
        await client.get(f"/media/images/{run['id']}")
    ).json()
    assert still["status"] in {"running", "completed"}
    await _settle(run["id"])
