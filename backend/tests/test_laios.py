"""Tests for the laios control-plane proxy module.

CRUD + status probing run against the real ASGI app + temp DB. The daemon proxy
is exercised with an httpx MockTransport injected via ``_client`` so no real
daemon is needed.
"""

from __future__ import annotations

import httpx
from httpx import AsyncClient

# DB / workspace isolation, LAIOS env cleanup, and the ``client`` fixture live in
# ``conftest.py``; laios tests therefore start from an empty connections table.


async def _make_connection(client: AsyncClient, **overrides) -> dict:
    body = {
        "name": "local",
        "base_url": "http://127.0.0.1:7420",
        "master_key": "sk-laios-secret",
        **overrides,
    }
    r = await client.post("/laios/connections", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def test_connection_crud_hides_master_key(client: AsyncClient):
    created = await _make_connection(client)
    # The raw key is never returned — only whether one is set.
    assert "master_key" not in created
    assert created["has_master_key"] is True
    cid = created["id"]

    listed = (await client.get("/laios/connections")).json()
    assert [c["id"] for c in listed] == [cid]
    assert all("master_key" not in c for c in listed)

    # Update the name without touching the key.
    r = await client.patch(f"/laios/connections/{cid}", json={"name": "renamed"})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "renamed"
    assert r.json()["has_master_key"] is True

    # A connection created without a key reports has_master_key False.
    keyless = await _make_connection(
        client, name="keyless", base_url="http://host:7420", master_key=None
    )
    assert keyless["has_master_key"] is False

    assert (await client.delete(f"/laios/connections/{cid}")).status_code == 204
    assert (await client.get(f"/laios/connections/{cid}")).status_code == 404


async def test_status_unreachable(client: AsyncClient):
    # An unroutable port yields a graceful error status, not a 500.
    conn = await _make_connection(client, base_url="http://127.0.0.1:1")
    r = await client.get(f"/laios/connections/{conn['id']}/status")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "error"
    assert body["reachable"] is False


async def test_proxy_forwards_and_maps_errors(client: AsyncClient, monkeypatch):
    conn = await _make_connection(client)
    captured: dict = {}

    instances_payload = [
        {"id": "abc", "served_name": "llama3.2-ollama", "status": "running"}
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        if request.url.path == "/v1/instances":
            return httpx.Response(200, json=instances_payload)
        if request.url.path == "/v1/serve":
            # Daemon rejects with its standard error envelope.
            return httpx.Response(
                409,
                json={
                    "error": {
                        "code": "insufficient_vram",
                        "message": "insufficient VRAM: need 3000 MiB",
                    }
                },
            )
        return httpx.Response(404, json={"error": {"code": "not_found", "message": "x"}})

    from app.api import laios as laios_mod

    def fake_client(conn, timeout=None):  # noqa: ANN001
        return httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url=conn.base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {conn.master_key}"},
        )

    monkeypatch.setattr(laios_mod, "_client", fake_client)

    # Happy path: instances proxy through verbatim, with the Bearer key attached.
    r = await client.get(f"/laios/connections/{conn['id']}/instances")
    assert r.status_code == 200, r.text
    assert r.json() == instances_payload
    assert captured["auth"] == "Bearer sk-laios-secret"

    # Error path: daemon 409 + envelope maps to a 409 with the daemon's message.
    r = await client.post(
        f"/laios/connections/{conn['id']}/serve", json={"recipe": "x", "solo": True}
    )
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert "insufficient VRAM" in detail and "insufficient_vram" in detail


async def test_proxy_404_for_unknown_connection(client: AsyncClient):
    r = await client.get("/laios/connections/nope/instances")
    assert r.status_code == 404


async def test_auto_link_surfaces_models_and_hides_from_providers(
    client: AsyncClient, monkeypatch
):
    """Creating a connection mirrors its gateway as a managed provider: the
    served models appear in the picker but the provider is hidden from the
    manual Providers tab."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/route":
            return httpx.Response(200, json={"gateway_listen": "0.0.0.0:4000"})
        if request.url.path == "/v1/models":
            # The daemon gateway's model list (what the picker surfaces).
            return httpx.Response(
                200, json={"data": [{"id": "llama3.2-ollama"}, {"id": "qwen"}]}
            )
        if request.url.path.endswith("/models"):
            # OpenRouter catalogue — empty so the picker degrades to [] cleanly.
            return httpx.Response(200, json={"data": []})
        return httpx.Response(404, json={})

    # Inject a MockTransport into every httpx client (daemon derivation + the
    # picker's provider probe) while preserving base_url/headers.
    orig_async_client = httpx.AsyncClient

    def mock_async_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return orig_async_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", mock_async_client)

    # Unique name/host so assertions are independent of other tests' leftovers
    # (the suite shares one DB).
    name = "autolink-probe"
    conn = await _make_connection(
        client, name=name, base_url="http://autolink-daemon:7420"
    )

    # No manually-added providers are created by these tests, and the managed
    # one is hidden from the Providers tab.
    assert all(p["name"] != name for p in (await client.get("/providers")).json())

    # The picker includes the connection's gateway models under its name.
    groups = (await client.get("/models")).json()
    laios_group = next((g for g in groups if g["label"] == name), None)
    assert laios_group is not None, groups
    labels = {m["label"] for m in laios_group["models"]}
    assert "llama3.2-ollama" in labels
    assert all(m["value"].startswith("custom:") for m in laios_group["models"])

    # Deleting the connection removes the managed provider (no orphan group).
    assert (await client.delete(f"/laios/connections/{conn['id']}")).status_code == 204
    groups = (await client.get("/models")).json()
    assert all(g["label"] != name for g in groups)


async def test_daemon_lifecycle_proxy(client: AsyncClient, monkeypatch):
    """version/update/update-log forward verbatim; restart tolerates the daemon
    dropping the connection as it shuts down (surfaced as 202, not an error)."""
    conn = await _make_connection(client)
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/daemon/version":
            captured["check"] = request.url.params.get("check")
            return httpx.Response(
                200,
                json={
                    "version": "0.1.1",
                    "git_sha": "abc1234",
                    "management_mode": "standalone",
                    "repo_dir": None,
                    "update": {"checked": False},
                },
            )
        if path == "/v1/daemon/update":
            return httpx.Response(
                202, json={"started": True, "log": "daemon-update-x.log"}
            )
        if path == "/v1/daemon/update/log":
            captured["log"] = request.url.params.get("log")
            return httpx.Response(200, json={"logs": "building…", "active": True})
        if path == "/v1/daemon/restart":
            # Simulate the daemon dying before it can reply.
            raise httpx.ConnectError("connection reset", request=request)
        return httpx.Response(404, json={"error": {"code": "not_found", "message": "x"}})

    from app.api import laios as laios_mod

    def fake_client(conn, timeout=None):  # noqa: ANN001
        return httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url=conn.base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {conn.master_key}"},
        )

    monkeypatch.setattr(laios_mod, "_client", fake_client)

    cid = conn["id"]

    r = await client.get(f"/laios/connections/{cid}/daemon/version?check=true")
    assert r.status_code == 200, r.text
    assert r.json()["git_sha"] == "abc1234"
    assert captured["check"] == "true"

    r = await client.post(f"/laios/connections/{cid}/daemon/update")
    assert r.status_code == 202, r.text
    assert r.json()["log"] == "daemon-update-x.log"

    r = await client.get(
        f"/laios/connections/{cid}/daemon/update/log?log=daemon-update-x.log&tail=50"
    )
    assert r.status_code == 200, r.text
    assert r.json()["active"] is True
    assert captured["log"] == "daemon-update-x.log"

    # Restart: the daemon drops the connection mid-shutdown → 202 "restarting".
    r = await client.post(f"/laios/connections/{cid}/daemon/restart")
    assert r.status_code == 202, r.text
    assert r.json()["restarting"] is True
