"""Browser QA — the capability that lets an executing agent see and test its app.

Covers the four pieces that carry the logic: the dev-server URL resolver, the
builder gating that attaches the capability only to executing top-level runs, the
real-browser round trip (launch → console/network capture → model-visible
screenshot), and the goal-evaluator visual wrapper's graceful degradation. The
vision model is stubbed throughout — these tests never hit the network for it.
"""

from __future__ import annotations

import asyncio
import functools
import http.server
import socketserver
import threading

import pytest

import app.agents.browser_qa as bq
import app.agents.builder as builder
from app.agents.browser_qa import (
    BrowserQACapability,
    screenshot_url,
    wrap_evaluate_with_visual_qa,
)
from app.agents.preview_service import PreviewService, _Process, _WorkspaceState
from app.db.models import Agent

# --- dev-server URL resolution ----------------------------------------------


def _proc(key: str, url: str | None, ready: bool) -> _Process:
    return _Process(
        key=key,
        backend_id="be",
        shell_id=key,
        command="npm run dev",
        started_at=1.0,
        url=url,
        ready=ready,
    )


def test_current_preview_url_prefers_ready_then_latest():
    svc = PreviewService()
    # Unknown workspace → None.
    assert svc.current_preview_url("nope") is None

    state = _WorkspaceState()
    svc._ws["ws"] = state

    # A ready server wins over a not-yet-ready one.
    state.procs = {
        "a": _proc("a", "http://localhost:3000", ready=False),
        "b": _proc("b", "http://localhost:3001", ready=True),
    }
    assert svc.current_preview_url("ws") == "http://localhost:3001"

    # With none ready, fall back to a known URL.
    state.procs = {"a": _proc("a", "http://localhost:3000", ready=False)}
    assert svc.current_preview_url("ws") == "http://localhost:3000"

    # No URLs known yet → None.
    state.procs = {"a": _proc("a", None, ready=False)}
    assert svc.current_preview_url("ws") is None


# --- builder gating ----------------------------------------------------------


def _capture_capabilities(monkeypatch) -> list:
    """Patch create_deep_agent to record the capabilities it was built with."""
    captured: list = []

    def _fake(*args, **kwargs):
        captured.extend(kwargs.get("capabilities") or [])
        return object()

    monkeypatch.setattr(builder, "create_deep_agent", _fake)
    return captured


def _has_browser_qa(caps: list) -> bool:
    return any(isinstance(c, BrowserQACapability) for c in caps)


def test_builder_attaches_browser_qa_for_executing_run(tmp_path, monkeypatch):
    monkeypatch.setattr(builder.settings, "browser_qa_enabled", True)
    caps = _capture_capabilities(monkeypatch)
    builder.build_deep_agent(Agent(name="A"), str(tmp_path), workspace_id="ws1")
    assert _has_browser_qa(caps)


def test_builder_omits_browser_qa_in_readonly(tmp_path, monkeypatch):
    monkeypatch.setattr(builder.settings, "browser_qa_enabled", True)
    caps = _capture_capabilities(monkeypatch)
    builder.build_deep_agent(
        Agent(name="A"), str(tmp_path), workspace_id="ws1", read_only=True
    )
    assert not _has_browser_qa(caps)


def test_builder_omits_browser_qa_without_workspace_id(tmp_path, monkeypatch):
    # Subagents build without a workspace_id → no browser (and no dev-server URL to
    # resolve anyway).
    monkeypatch.setattr(builder.settings, "browser_qa_enabled", True)
    caps = _capture_capabilities(monkeypatch)
    builder.build_deep_agent(Agent(name="A"), str(tmp_path))
    assert not _has_browser_qa(caps)


def test_builder_omits_browser_qa_when_disabled(tmp_path, monkeypatch):
    monkeypatch.setattr(builder.settings, "browser_qa_enabled", False)
    caps = _capture_capabilities(monkeypatch)
    builder.build_deep_agent(Agent(name="A"), str(tmp_path), workspace_id="ws1")
    assert not _has_browser_qa(caps)


# --- real-browser round trip -------------------------------------------------


@pytest.fixture
def served_page(tmp_path):
    """Serve a page that logs a console error and requests a missing resource."""
    (tmp_path / "index.html").write_text(
        "<html><body><h1>Hello QA</h1>"
        '<script>console.error("boom-error"); fetch("/missing.json");</script>'
        "</body></html>"
    )
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(tmp_path)
    )
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    httpd.RequestHandlerClass.log_message = lambda *a, **k: None  # quiet
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://localhost:{port}/"
    finally:
        httpd.shutdown()


async def test_screenshot_url_returns_png(served_page):
    png = await screenshot_url(served_page)
    assert png is not None and png[:8] == b"\x89PNG\r\n\x1a\n"


async def test_screenshot_url_none_on_bad_target():
    # Nothing listening on this loopback port → best-effort returns None, not raise.
    assert await screenshot_url("http://localhost:1/", timeout_ms=1500) is None


async def test_capability_captures_telemetry_and_screenshots(
    served_page, tmp_path, monkeypatch
):
    # Stub the vision model so view_app needs no API key / network.
    async def _fake_desc(raw, mime, question):
        assert mime == "image/png" and isinstance(raw, (bytes, bytearray))
        return f"VISION_OK({len(raw)} bytes)"

    monkeypatch.setattr(bq, "describe_image_bytes", _fake_desc)
    # open_app with no url resolves the preview URL from the service.
    from app.agents import preview_service as psmod

    monkeypatch.setattr(
        psmod.preview_service, "current_preview_url", lambda wid: served_page
    )

    cap = BrowserQACapability(
        workspace_id="ws-test", media_dir=tmp_path, headless=True
    )
    tools = cap._toolset.tools
    results: dict = {}

    async def handler():
        results["open"] = await tools["open_app"].function(None)
        results["view"] = await tools["view_app"].function(None)
        await asyncio.sleep(0.3)  # let async console/network events flush
        results["console"] = await tools["get_console_logs"].function(None)
        results["network"] = await tools["get_network_errors"].function(None)
        return "DONE"

    out = await cap.wrap_run(None, handler=handler)

    assert out == "DONE"
    assert "Opened http://localhost:" in results["open"]
    # view_app routed real PNG bytes through the vision path.
    assert "VISION_OK(" in results["view"]
    assert "Screenshot saved:" in results["view"]
    # Console capture caught the explicit error AND the failed-resource error.
    assert "boom-error" in results["console"]
    # Network capture caught the 404.
    assert "404" in results["network"] and "/missing.json" in results["network"]
    # A screenshot file was actually written under the media dir.
    shots = list((tmp_path / "qa" / "ws-test").glob("*.png"))
    assert shots and shots[0].read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    # Teardown released the page.
    assert cap._state.page is None


async def test_open_app_reports_when_no_server(tmp_path, monkeypatch):
    from app.agents import preview_service as psmod

    monkeypatch.setattr(psmod.preview_service, "current_preview_url", lambda wid: None)
    cap = BrowserQACapability(workspace_id="ws-x", media_dir=tmp_path, headless=True)
    tools = cap._toolset.tools

    async def handler():
        return await tools["open_app"].function(None)

    msg = await cap.wrap_run(None, handler=handler)
    assert "no running dev server" in msg.lower()


# --- goal-evaluator visual wrapper ------------------------------------------


async def test_visual_evaluate_degrades_without_server(monkeypatch):
    from app.agents import preview_service as psmod

    monkeypatch.setattr(psmod.preview_service, "current_preview_url", lambda wid: None)

    seen: dict = {}

    async def _base(condition, messages):
        seen["condition"] = condition
        seen["messages"] = messages
        return "verdict"

    evaluate = wrap_evaluate_with_visual_qa(_base, "ws1")
    original = ["m1", "m2"]
    result = await evaluate("done?", original)

    # No server → no screenshot appended; the base evaluator sees the transcript
    # unchanged and its result is returned verbatim.
    assert result == "verdict"
    assert seen["messages"] == original


async def test_visual_evaluate_appends_screenshot_note(served_page, monkeypatch):
    from app.agents import preview_service as psmod

    monkeypatch.setattr(
        psmod.preview_service, "current_preview_url", lambda wid: served_page
    )

    async def _fake_desc(raw, mime, question):
        return "the page shows a heading"

    monkeypatch.setattr(bq, "describe_image_bytes", _fake_desc)

    captured: dict = {}

    async def _base(condition, messages):
        captured["messages"] = messages
        return "verdict"

    evaluate = wrap_evaluate_with_visual_qa(_base, "ws1")
    await evaluate("heading present?", ["m1"])

    # The evaluator now sees an extra message carrying the visual description.
    msgs = captured["messages"]
    assert len(msgs) == 2
    text = "".join(
        part.content
        for part in msgs[-1].parts
        if getattr(part, "content", None)
    )
    assert "[Visual QA]" in text and "the page shows a heading" in text
