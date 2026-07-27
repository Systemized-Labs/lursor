"""Tests for manually-listed provider models.

Some OpenAI-compatible endpoints serve ``/chat/completions`` while their
``/models`` route is auth-gated or absent (e.g. an inference server reached
through a gateway that only proxies the completion routes). Discovery alone
would drop such a provider from the picker entirely, so ``manual_models`` acts
as a fallback catalogue. These tests pin that fallback, and that a readable
``/models`` still wins over it.

The endpoints build their own ``httpx.AsyncClient``, so requests are intercepted
by swapping the constructor for one wired to a ``MockTransport``.
"""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest
from httpx import AsyncClient

MODEL_ID = "moonshotai/Kimi-K3"
BASE_URL = "https://example-endpoint.test/v1"


def _patch_httpx(monkeypatch: pytest.MonkeyPatch, handler: Callable) -> None:
    """Route every ``httpx.AsyncClient`` built during the test at ``handler``."""
    real = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.pop("timeout", None)
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)


def _handler(provider_models: httpx.Response) -> Callable:
    """Serve ``provider_models`` for the provider, 502 for OpenRouter."""

    def handle(request: httpx.Request) -> httpx.Response:
        if "example-endpoint.test" in request.url.host:
            return provider_models
        # OpenRouter: unreachable, so only custom groups come back.
        return httpx.Response(502, json={"error": "nope"})

    return handle


async def _make_provider(client: AsyncClient, name: str, **overrides) -> dict:
    body = {
        "name": name,
        "base_url": BASE_URL,
        "api_key": "token",
        "manual_models": MODEL_ID,
        **overrides,
    }
    r = await client.post("/providers", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def test_manual_models_surface_when_discovery_is_unauthorized(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    provider = await _make_provider(client, "gated-unauthorized")
    _patch_httpx(monkeypatch, _handler(httpx.Response(401, json={"error": "nope"})))

    groups = (await client.get("/models")).json()
    group = next(g for g in groups if g["label"] == "gated-unauthorized")
    assert [m["id"] for m in group["models"]] == [MODEL_ID]
    # The value is what gets persisted on an agent and routed in builder.py.
    assert group["models"][0]["value"] == f"custom:{provider['id']}:{MODEL_ID}"


async def test_manual_models_accept_commas_and_newlines(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    await _make_provider(
        client, "gated-separators", manual_models=f" {MODEL_ID}, \nqwen/Qwen3-Coder,\n"
    )
    _patch_httpx(monkeypatch, _handler(httpx.Response(404)))

    groups = (await client.get("/models")).json()
    group = next(g for g in groups if g["label"] == "gated-separators")
    assert [m["id"] for m in group["models"]] == [MODEL_ID, "qwen/Qwen3-Coder"]


async def test_discovery_wins_over_manual_list(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """A provider whose catalogue *is* readable keeps updating itself."""
    await _make_provider(client, "gated-discovery-wins")
    discovered = httpx.Response(200, json={"data": [{"id": "served-by-endpoint"}]})
    _patch_httpx(monkeypatch, _handler(discovered))

    groups = (await client.get("/models")).json()
    group = next(g for g in groups if g["label"] == "gated-discovery-wins")
    assert [m["id"] for m in group["models"]] == ["served-by-endpoint"]


async def test_provider_without_manual_models_is_still_dropped(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    await _make_provider(client, "dead-endpoint", manual_models="")
    _patch_httpx(monkeypatch, _handler(httpx.Response(401, json={"error": "nope"})))

    groups = (await client.get("/models")).json()
    assert all(g["label"] != "dead-endpoint" for g in groups)


async def test_health_reports_ok_with_note_when_falling_back(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    _patch_httpx(monkeypatch, _handler(httpx.Response(401, json={"error": "nope"})))

    r = await client.post(
        "/providers/test",
        json={
            "name": "Gated endpoint",
            "base_url": BASE_URL,
            "api_key": "token",
            "manual_models": MODEL_ID,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok"
    assert body["model_count"] == 1
    assert "manually-listed" in body["note"]
    assert body["error"] is None


async def test_health_still_errors_without_manual_models(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    _patch_httpx(monkeypatch, _handler(httpx.Response(401, json={"error": "nope"})))

    r = await client.post(
        "/providers/test",
        json={"name": "Gated endpoint", "base_url": BASE_URL, "api_key": "bad"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "error"
    assert "Authentication failed" in body["error"]
    assert body["note"] is None
