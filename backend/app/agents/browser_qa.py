"""Browser QA — let an executing agent *see* and test the app it builds.

The vendored ``pydantic_deep`` :class:`BrowserCapability` gives an agent a real
Playwright browser (navigate/click/type/…), but for QA it has two gaps: its
``screenshot`` tool returns a base64 *text* string the model can't actually see,
and it captures no console/network errors — which is where most real UI bugs
surface. This module fills both without forking the third-party dependency.

:class:`BrowserQACapability` composes the vendored driving toolset (so
navigate/click/type/get_text/scroll/execute_js are reused verbatim) but owns the
browser lifecycle itself, so it can:

- attach console + network listeners at page creation (captured from the very
  first load, not just from when a tool is next called), and
- add lursor tools that share the same page: ``open_app`` (navigate to the
  auto-detected dev-server URL), ``view_app`` (screenshot → the vision model →
  a description the agent can act on, via :func:`app.agents.vision`),
  ``get_console_logs`` and ``get_network_errors``.

The browser is headless, scoped to loopback addresses (it only ever opens the
local app), launched lazily on the first browser-tool call, and torn down when
the run ends. Chromium is installed on first use, so end users set up nothing.

:func:`screenshot_url` is a standalone one-shot capture used by the goal-mode
evaluator (see :func:`wrap_evaluate_with_visual_qa`) to verify completion against
what actually rendered.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import sys
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from pydantic_ai import AgentRunResult, RunContext
from pydantic_ai.capabilities import AbstractCapability, WrapRunHandler
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.tools import ToolDefinition
from pydantic_ai.toolsets import AbstractToolset

# Reuse the vendored driving toolset + shared state verbatim; only the lifecycle
# and the extra QA tools are ours. These are the same symbols the vendored
# capability imports, so they track the dependency.
from pydantic_deep.features.browser.toolset import (
    BrowserToolset,
    _BrowserState,
    _check_allowed_domain,
    _require_browser,
)

from app.agents.vision import describe_image_bytes
from app.config import get_settings

try:
    from playwright.async_api import async_playwright
except ImportError:  # pragma: no cover - browser extra not installed
    async_playwright = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

# The QA browser only ever opens the local app. Restricting navigation to
# loopback is the security boundary (an agent-driven browser + execute_js must
# not reach arbitrary sites) and it matches what preview auto-detection surfaces.
LOOPBACK_HOSTS: list[str] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]

# Bounded telemetry buffers — enough to diagnose a page without unbounded growth.
_MAX_CONSOLE = 300
_MAX_NETWORK = 150

# Vendored tools our own QA tools replace, removed from the roster in
# ``prepare_tools`` rather than left as a trap the model can walk into.
#
# ``screenshot`` returns ``f"data:image/png;base64,{b64}"`` as a *string*: the
# model cannot see it, and the blob lands in the transcript as text and stays
# there (tool results are never evicted). A plain 1280x800 page measures ~100k
# base64 characters — roughly 25-35k tokens for one call that conveys nothing,
# billed again on every later request in the turn. ``view_app`` is the working
# version (screenshot → vision model → a description the agent can act on) and is
# what ``BROWSER_QA_INSTRUCTIONS`` tells the model to use; leaving the base64 one
# registered only invited models with a "take a screenshot" prior to torch the
# context window.
_SUPERSEDED_TOOLS = frozenset({"screenshot"})

# Default question for view_app: framed for QA so the vision model reports defects,
# not just a neutral description.
_DEFAULT_VIEW_QUESTION = (
    "You are QA-reviewing a web app. Describe the current rendered state in "
    "detail: layout, visible text, and interactive elements. Explicitly call out "
    "anything that looks broken — error messages, blank/white screens, overlapping "
    "or cut-off elements, unstyled content, or missing images."
)

BROWSER_QA_INSTRUCTIONS = """\
# Visual QA — see and test the running app

You have a real headless browser to QA the web app you build. Use it to verify
your work looks and behaves correctly, instead of assuming it does.

- `open_app(url?)` — open the app in the browser. Omit `url` to open the running
  dev server automatically (start it with `run_in_background` first and wait for
  it to be ready). Pass a path/url to open a specific route.
- `view_app(question?)` — take a screenshot and get a visual description back.
  This is how you actually *see* the page. Ask a specific `question` to check a
  detail (e.g. "Is the login form centered?", "What does the error banner say?").
- `get_console_logs()` / `get_network_errors()` — read runtime JS errors and
  failed/slow requests. Check these whenever a page looks wrong or blank.
- `click(selector)`, `type_text(selector, text)`, `get_text(selector?)`,
  `scroll(direction)`, `execute_js(script)` — drive the page to test flows.

Typical loop: start the dev server → `open_app()` → `view_app()` and
`get_console_logs()` → fix what's broken → re-check. The browser only opens the
local app.
"""


async def _auto_install_chromium() -> bool:
    """Run ``playwright install chromium`` in this interpreter; True on success."""
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "playwright",
            "install",
            "chromium",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            logger.warning(
                "playwright install chromium failed (exit %s): %s",
                proc.returncode,
                stderr.decode(errors="replace").strip(),
            )
            return False
        logger.info("Chromium installed successfully.")
        return True
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Failed to run playwright install: %s", exc)
        return False


async def _launch_chromium(pw: Any, *, headless: bool) -> Any | None:
    """Launch Chromium, auto-installing the binary once if it is missing."""
    try:
        return await pw.chromium.launch(headless=headless)
    except Exception as first_exc:
        logger.info(
            "Chromium not found (%s); attempting `playwright install chromium`…",
            first_exc,
        )
        if await _auto_install_chromium():
            with contextlib.suppress(Exception):
                return await pw.chromium.launch(headless=headless)
        logger.warning("Browser unavailable — Chromium could not be launched.")
        return None


async def screenshot_url(
    url: str,
    *,
    headless: bool = True,
    full_page: bool = False,
    timeout_ms: int = 15_000,
) -> bytes | None:
    """One-shot: open ``url`` in a throwaway browser and return a PNG, or None.

    Standalone (own browser, no agent run) so the goal-mode evaluator can capture
    the live app out-of-band. Best-effort — returns ``None`` on any failure
    (playwright missing, Chromium unavailable, navigation error) so the caller
    can degrade to a transcript-only judgement rather than crashing the loop.
    """
    if async_playwright is None:
        return None
    try:
        async with async_playwright() as pw:
            browser = await _launch_chromium(pw, headless=headless)
            if browser is None:
                return None
            try:
                page = await browser.new_page()
                await page.goto(url, timeout=timeout_ms)
                with contextlib.suppress(Exception):
                    await page.wait_for_load_state("networkidle", timeout=timeout_ms)
                return await page.screenshot(full_page=full_page)
            finally:
                await browser.close()
    except Exception as exc:  # noqa: BLE001 - best-effort capture
        logger.warning("screenshot_url(%s) failed: %s", url, exc)
        return None


@dataclass
class BrowserQACapability(AbstractCapability[Any]):
    """A headless QA browser for an executing agent, scoped to the local app.

    Owns the Playwright lifecycle so it can capture console/network telemetry and
    serve model-visible screenshots, while reusing the vendored
    :class:`BrowserToolset` for the page-driving tools. Construct a *fresh*
    instance per agent run: state (page, telemetry) is per-instance and single
    page, so one instance must not be shared across concurrent runs.

    Args:
        workspace_id: Workspace whose dev-server URL ``open_app``/``view_app``
            default to (looked up live from the preview service).
        media_dir: Root under which screenshots are saved (``<media_dir>/qa/…``).
        headless: Run without a visible window (default True).
        timeout_ms: Default Playwright navigation timeout.
    """

    workspace_id: str
    media_dir: Path
    headless: bool = True
    timeout_ms: int = 30_000

    _state: _BrowserState = field(default_factory=_BrowserState, init=False, repr=False)
    _toolset: BrowserToolset | None = field(default=None, init=False, repr=False)
    _console: deque = field(
        default_factory=lambda: deque(maxlen=_MAX_CONSOLE), init=False, repr=False
    )
    _network: deque = field(
        default_factory=lambda: deque(maxlen=_MAX_NETWORK), init=False, repr=False
    )
    _shot_seq: int = field(default=0, init=False, repr=False)
    _tool_names: frozenset[str] = field(default=frozenset(), init=False, repr=False)

    def __post_init__(self) -> None:
        self._state = _BrowserState()
        self._console = deque(maxlen=_MAX_CONSOLE)
        self._network = deque(maxlen=_MAX_NETWORK)
        toolset = BrowserToolset(
            state=self._state,
            allowed_domains=LOOPBACK_HOSTS,
            timeout_ms=self.timeout_ms,
        )
        self._register_qa_tools(toolset)
        self._toolset = toolset
        # Vendored driving tools + our QA tools; used to demote approval + hide on
        # launch failure. Read off the toolset so it never drifts from reality.
        self._tool_names = frozenset(toolset.tools.keys())

    # --- capability protocol -------------------------------------------------

    def get_toolset(self) -> AbstractToolset[Any] | None:
        return self._toolset

    def get_instructions(self) -> Any:
        def _instructions(ctx: RunContext[Any]) -> str | None:
            if self._state.launch_error:
                return None
            return BROWSER_QA_INSTRUCTIONS

        return _instructions

    async def prepare_tools(
        self, ctx: RunContext[Any], tool_defs: list[ToolDefinition]
    ) -> list[ToolDefinition]:
        """Hide browser tools if the browser can't launch; skip approval otherwise.

        Also drops the vendored ``screenshot`` tool unconditionally — see
        :data:`_SUPERSEDED_TOOLS`.
        """
        if self._state.launch_error:
            return [td for td in tool_defs if td.name not in self._tool_names]
        result: list[ToolDefinition] = []
        for td in tool_defs:
            if td.name in _SUPERSEDED_TOOLS:
                continue
            if td.name in self._tool_names and td.kind == "unapproved":
                result.append(replace(td, kind="function"))
            else:
                result.append(td)
        return result

    async def wrap_run(
        self, ctx: RunContext[Any], *, handler: WrapRunHandler
    ) -> AgentRunResult[Any]:
        """Install a lazy launcher that attaches telemetry; tear down on exit.

        Mirrors the vendored ``BrowserCapability.wrap_run`` (lazy launch on first
        tool call, guaranteed ``finally`` cleanup) but additionally wires console
        and network listeners onto the page at creation and enforces the loopback
        allowlist. Runs that never touch a browser tool spawn no browser.
        """
        _require_browser()
        assert async_playwright is not None
        _start = async_playwright
        _pw_ctx: Any = None

        async def _launch() -> None:
            nonlocal _pw_ctx
            _pw_ctx = _start()
            pw = await _pw_ctx.__aenter__()
            self._state.playwright_instance = pw
            browser = await _launch_chromium(pw, headless=self.headless)
            if browser is None:
                self._state.launch_error = (
                    "Chromium is not installed. Run `playwright install chromium` "
                    "to enable the QA browser."
                )
                return
            page = await browser.new_page()
            self._attach_listeners(page)

            async def _route_guard(route: Any, request: Any) -> None:
                if (
                    request.is_navigation_request()
                    and request.frame == page.main_frame
                    and not _check_allowed_domain(request.url, LOOPBACK_HOSTS)
                ):
                    await route.abort()
                    return
                await route.continue_()

            await page.route("**/*", _route_guard)
            self._state.browser = browser
            self._state.page = page

        self._state._lazy_launcher = _launch
        try:
            return await handler()
        finally:
            self._state._lazy_launcher = None
            self._state.playwright_instance = None
            if self._state.browser is not None:
                browser = self._state.browser
                self._state.page = None
                self._state.browser = None
                with contextlib.suppress(Exception):
                    await browser.close()
            else:
                self._state.page = None
            if _pw_ctx is not None:
                with contextlib.suppress(Exception):
                    await _pw_ctx.__aexit__(None, None, None)

    # --- telemetry -----------------------------------------------------------

    def _attach_listeners(self, page: Any) -> None:
        """Record console messages, uncaught errors, and failed/error responses."""

        def _on_console(msg: Any) -> None:
            with contextlib.suppress(Exception):
                self._console.append({"type": msg.type, "text": msg.text})

        def _on_pageerror(exc: Any) -> None:
            with contextlib.suppress(Exception):
                self._console.append({"type": "error", "text": str(exc)})

        def _on_response(resp: Any) -> None:
            with contextlib.suppress(Exception):
                if resp.status >= 400:
                    self._network.append(f"{resp.status} {resp.request.method} {resp.url}")

        def _on_requestfailed(req: Any) -> None:
            with contextlib.suppress(Exception):
                self._network.append(f"FAILED {req.method} {req.url} ({req.failure})")

        page.on("console", _on_console)
        page.on("pageerror", _on_pageerror)
        page.on("response", _on_response)
        page.on("requestfailed", _on_requestfailed)

    def _console_summary(self, limit: int = 10) -> str:
        errs = [c for c in self._console if c["type"] in ("error", "warning")]
        if not errs:
            return ""
        lines = "\n".join(f"- [{c['type']}] {c['text']}" for c in list(errs)[-limit:])
        return f"\n\nConsole errors/warnings:\n{lines}"

    def _save_screenshot(self, png: bytes) -> Path:
        self._shot_seq += 1
        target_dir = Path(self.media_dir) / "qa" / self.workspace_id
        target_dir.mkdir(parents=True, exist_ok=True)
        path = target_dir / f"shot-{int(time.time())}-{self._shot_seq}.png"
        path.write_bytes(png)
        return path

    # --- QA tools ------------------------------------------------------------

    def _register_qa_tools(self, toolset: BrowserToolset) -> None:
        """Add lursor QA tools that share the vendored toolset's page/state."""

        @toolset.tool(
            description=(
                "Open the running web app in the QA browser. Omit `url` to open "
                "the auto-detected dev server (start it in the background and wait "
                "for it to be ready first). Pass a url/path to open a route."
            )
        )
        async def open_app(ctx: RunContext[Any], url: str | None = None) -> str:
            """Open the app in the browser. Defaults to the running dev server."""
            # Imported lazily to avoid a module import cycle (preview_service is
            # free of agent imports; this keeps it that way).
            from app.agents.preview_service import preview_service

            target = url or preview_service.current_preview_url(self.workspace_id)
            if not target:
                return (
                    "Error: no running dev server detected. Start it with "
                    "run_in_background, wait until it is ready, then call open_app "
                    "again — or pass an explicit url."
                )
            if not _check_allowed_domain(target, LOOPBACK_HOSTS):
                return (
                    f"Error: {target} is not a local address. The QA browser only "
                    "opens the local app (localhost / 127.0.0.1)."
                )
            page = await self._state.ensure_page()
            try:
                await page.goto(target, timeout=self.timeout_ms)
                await page.wait_for_load_state("domcontentloaded")
            except Exception as exc:  # noqa: BLE001
                return f"Error opening {target}: {exc}{self._console_summary()}"
            title = await page.title()
            return (
                f"Opened {page.url}\nTitle: {title}\n"
                "Use view_app to see it, get_console_logs / get_network_errors for "
                "runtime errors, and click/type_text/get_text to interact."
                f"{self._console_summary()}"
            )

        @toolset.tool(
            description=(
                "Take a screenshot of the current page and return a visual "
                "description from a vision model — this is how you SEE the app. "
                "Ask a specific `question` to check a detail. Call open_app first."
            )
        )
        async def view_app(
            ctx: RunContext[Any],
            question: str = _DEFAULT_VIEW_QUESTION,
            full_page: bool = False,
        ) -> str:
            """Screenshot the current page and describe it via the vision model."""
            page = await self._state.ensure_page()
            try:
                png = await page.screenshot(full_page=full_page)
            except Exception as exc:  # noqa: BLE001
                return f"Error taking screenshot: {exc}"
            try:
                path = self._save_screenshot(png)
                saved = f"Screenshot saved: {path}\n"
            except Exception as exc:  # noqa: BLE001 - saving is best-effort
                logger.warning("view_app: could not save screenshot: %s", exc)
                saved = ""
            analysis = await describe_image_bytes(png, "image/png", question)
            return (
                f"URL: {page.url}\n{saved}\nVisual analysis:\n{analysis}"
                f"{self._console_summary()}"
            )

        @toolset.tool(
            description=(
                "Read captured browser console output for the current page. "
                "Set errors_only=False to include logs/info too."
            )
        )
        async def get_console_logs(
            ctx: RunContext[Any], errors_only: bool = True
        ) -> str:
            """Return captured console messages (errors/warnings by default)."""
            logs = list(self._console)
            if errors_only:
                logs = [c for c in logs if c["type"] in ("error", "warning")]
            if not logs:
                return (
                    "No console errors or warnings captured."
                    if errors_only
                    else "No console messages captured."
                )
            return "\n".join(f"[{c['type']}] {c['text']}" for c in logs[-100:])

        @toolset.tool(
            description=(
                "List network requests on the current page that failed or "
                "returned a 4xx/5xx status."
            )
        )
        async def get_network_errors(ctx: RunContext[Any]) -> str:
            """Return failed / error-status network requests captured so far."""
            if not self._network:
                return "No failed or error-status network requests captured."
            return "\n".join(list(self._network)[-100:])


def wrap_evaluate_with_visual_qa(
    base_evaluate: Callable[[str, list[ModelMessage]], Awaitable[Any]],
    workspace_id: str,
) -> Callable[[str, list[ModelMessage]], Awaitable[Any]]:
    """Wrap a goal evaluator so it also judges the *rendered* app.

    Before delegating to ``base_evaluate``, this captures a live screenshot of the
    workspace's dev server, has the vision model describe it against the goal
    condition, and appends that description to the transcript the evaluator sees —
    so completion is judged on what actually rendered, not only the agent's
    self-report. Fully best-effort: if browser QA is disabled, no server is up, or
    any capture step fails, it falls back to the plain transcript evaluation, and
    ``base_evaluate``'s own error handling (and the caller's circuit breaker) are
    preserved untouched.
    """

    async def evaluate(condition: str, messages: list[ModelMessage]) -> Any:
        augmented = messages
        try:
            settings = get_settings()
            if settings.browser_qa_enabled:
                from app.agents.preview_service import preview_service

                url = preview_service.current_preview_url(workspace_id)
                if url:
                    png = await screenshot_url(
                        url, headless=settings.browser_qa_headless
                    )
                    if png:
                        desc = await describe_image_bytes(
                            png,
                            "image/png",
                            "You are QA-reviewing a web app to verify this goal: "
                            f"{condition!r}. Describe the current rendered state in "
                            "detail and state clearly whether it appears to satisfy "
                            "the goal, calling out anything broken or missing.",
                        )
                        note = f"[Visual QA] Live screenshot of {url}:\n{desc}"
                        augmented = list(messages) + [
                            ModelResponse(parts=[TextPart(content=note)])
                        ]
        except Exception as exc:  # noqa: BLE001 - never let QA break evaluation
            logger.warning("visual QA evaluation step failed: %s", exc)
            augmented = messages
        return await base_evaluate(condition, augmented)

    return evaluate
