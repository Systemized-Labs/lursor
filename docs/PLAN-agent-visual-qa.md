# PLAN: Agent Visual QA — letting agents "see" and test the running app

Status: IMPLEMENTED (Phases 0–4; Phase 5 UI deferred)
Owner: jon
Date: 2026-07-20

## Implementation status (2026-07-20)

Phases 0–4 are built, tested (103 backend tests pass, incl. 11 new real-browser
tests), and lint-clean. A key design change from the original plan: the vendored
`BrowserCapability` is *composed*, not used directly — its `screenshot` returns
text-only base64 (G1) and it captures no console/network (G2), and
`pydantic-deep` is a third-party dep we cannot patch. So `app/agents/browser_qa.py`
reuses the vendored driving toolset (navigate/click/type/…) but owns the browser
lifecycle to add model-visible screenshots (via the existing vision path) and
console/network capture.

What shipped:
- `app/agents/browser_qa.py` — `BrowserQACapability` (per-run, headless,
  loopback-only) with tools `open_app`, `view_app` (screenshot → vision model),
  `get_console_logs`, `get_network_errors`, plus reused driving tools;
  `screenshot_url` (standalone) and `wrap_evaluate_with_visual_qa` (goal
  evaluator augmentation).
- `app/agents/vision.py` — extracted `describe_image_bytes` (shared by
  `view_image` and `view_app`).
- `app/agents/preview_service.py` — `current_preview_url(workspace_id)`.
- `app/agents/builder.py` — `workspace_id` param; attaches the capability to
  executing top-level agents when enabled; adds `BROWSER_QA_DIRECTIVE`.
- `app/api/chat.py` — passes `workspace_id`; wraps the goal evaluator with visual
  QA so completion is judged on the rendered app.
- `app/config.py` — `browser_qa_enabled`, `browser_qa_headless`.
- `pyproject.toml` — `pydantic-deep[browser]` (playwright + html2text); Chromium
  auto-installs on first use.

Deferred: Phase 5 (surface browser activity/screenshots in the UI), and the
open questions R2 (concurrent-browser cap) and R6 (authenticated-flow seeding).

---

## Problem

Agents build web apps but QA them poorly. Today the only "verification" is the
agent self-reporting text evidence (test output, curl results, logs), and the
goal-mode evaluator judges completion **from the chat transcript alone** — no
browser, no rendered page, no ground truth. The agent can claim "the login page
works" without anything ever having looked at it.

We want agents to be able to **see and drive the running app** to QA it, with
**zero setup for end users** (self-hosters run the backend; they should not have
to install Node, a browser, or configure an MCP server).

## Decisions (locked with jon)

1. **Scope: full loop.** Give agents browser tools AND wire visual verification
   into the goal-mode evaluator so completion is judged on what actually rendered.
2. **Enablement: always-on for execution agents.** Every non-readonly agent gets
   the capability automatically. No per-agent config. True out-of-the-box.
3. **Chromium provisioning: lazy install on first use** via
   `python -m playwright install chromium`. No startup cost; first QA is slower once.

## Why NOT `@playwright/mcp`

The obvious industry-default (Playwright MCP over `npx @playwright/mcp@latest`)
is the wrong fit for lursor's constraints:

- It needs a **Node runtime + `npx` on the backend host**. The backend is
  Python-only (`backend/pyproject.toml`), there is no Dockerfile, and Node is not
  a declared dependency. Shipping it "out of the box" would force every
  self-hoster to install and maintain a Node toolchain.
- The Electron desktop shell can't help: it doesn't bundle the backend and
  doesn't expose its Chromium over CDP (`frontend/electron/main.cjs:5-6,41-43`),
  and the backend may not even run on the same machine.

## Chosen foundation: the engine's native `BrowserCapability`

`pydantic_deep` (vendored) already ships a Playwright-backed capability that is
purpose-built for this:

- **Python Playwright** (pip dep, no Node), auto-installs Chromium on first use
  via `python -m playwright install chromium` (`auto_install=True` default).
- Consumed through the existing agent constructor:
  `create_deep_agent(..., capabilities=[BrowserCapability(...)])`
  (`pydantic_deep/agent.py:624`). No new engine surface needed.
- Lazy launch per run (no browser subprocess unless a browser tool is called);
  guaranteed teardown in `wrap_run` finally.

### What `BrowserCapability` gives us for free (9 agent tools)

`navigate(url)`, `click(selector|"x,y")`, `type_text(selector, text)`,
`get_text(selector?)`, `scroll(dir)`, `go_back()`, `go_forward()`,
`execute_js(script)`, and `screenshot(full_page?)`. Page content is returned as
HTML→Markdown (truncated to a token budget). This covers the dominant,
cheap "drive the DOM as text" QA pattern.

### What it does NOT do (the gaps we must fill)

These are the crux of the plan — the native capability alone is not enough for
real visual QA:

- **G1 — Screenshots are not model-visible.** `screenshot` returns a
  `data:image/png;base64,...` **text string**, not an image content part. Most
  model adapters will treat that as opaque tokens, so the agent cannot actually
  "see" the page from this tool. We must bridge screenshots into a real vision
  path.
- **G2 — No console/network capture.** No `page.on("console")`, no response
  logging. Research shows runtime telemetry (console errors, failed requests) is
  where most real bugs surface. We need to add it.
- **G3 — No base URL / start page.** Navigation is fully agent-driven; there is
  no way to point the browser at a URL programmatically via the constructor. We
  must inject the auto-detected preview URL another way.
- **G4 — Single-run instance.** `_state` is shared across runs of one instance
  and `launch_error` is not reset. We must construct a **fresh
  `BrowserCapability` per agent run** for FastAPI concurrency safety.

## What lursor already has (reuse, don't rebuild)

- **Preview URL + port + readiness per workspace** — `preview_service.py` +
  `preview_detect.py` already parse the dev-server URL and probe readiness.
- **A vision model + sink** — `view_image` (`backend/app/agents/vision.py:40`)
  base64s an image file and calls a vision model
  (`config.py` `vision_model = google/gemini-2.5-flash-lite`), returning text.
- **Goal-loop evaluation seam** — `drive_goal_loop` (`goal_loop.py:290`) with an
  `evaluate=` callback; `_run_goal_execution` (`chat.py:586`).
- **Dev-server directive** injected into every executing agent (`builder.py:64`).

## Architecture

```
                    ┌─────────────────────────────────────────┐
   agent run  ──►   │  BrowserCapability (per-run, headless)   │  drive + DOM text
                    │  navigate/click/type/get_text/execute_js │
                    └───────────────┬─────────────────────────┘
                                    │ shares the launched page
                    ┌───────────────▼─────────────────────────┐
   lursor bridge ►  │  console/network listeners (G2)          │  telemetry tools
                    │  screenshot→file→vision (G1)             │  model-visible sight
                    └───────────────┬─────────────────────────┘
                                    │
   preview_service ─── preview URL ─┘  injected into instructions + allowed_domains (G3)

   goal evaluator ──►  standalone Playwright screenshot of preview URL ──► vision judge
                       (ground-truth visual verification of completion)
```

Two consumers of the browser:
1. **The agent**, mid-run, via capability tools + lursor bridge tools.
2. **The goal evaluator**, out-of-band, via a standalone screenshot helper (the
   capability is run-scoped and agent-driven, so the evaluator needs its own
   path).

## Implementation phases

### Phase 0 — Dependency + provisioning
- Add the browser extra to the backend: `pydantic-deep[browser]` (pulls
  `playwright` + `html2text`) in `backend/pyproject.toml`. (Currently
  `playwright` is NOT installed.)
- Keep `auto_install=True` (lazy). Document `python -m playwright install
  chromium` as an optional pre-warm step for operators who want instant first QA.
- Sanity: confirm `uv sync` resolves the extra; run `python -m playwright
  install chromium` once locally.

### Phase 1 — Attach browser tools to execution agents (G3, G4)
- In `builder.py`, for non-readonly agents, build a **fresh**
  `BrowserCapability(headless=True, allowed_domains=[<preview host>])` per run
  and pass via `create_deep_agent(..., capabilities=[...])`.
- Scope `allowed_domains` to `localhost`/`127.0.0.1` (+ configured preview host)
  so the agent's browser can't wander the internet.
- Inject the auto-detected preview URL (from `preview_service`) into the agent
  instructions / dev-server directive so the model knows where to `navigate`.
  Handle the race where the server isn't ready yet (fall back to a directive that
  says "start the dev server, then navigate to its URL").
- Readonly ("ask") mode: keep browser tools OUT for now (they can `execute_js`,
  which mutates). Revisit exposing read-only nav/get_text/screenshot later.
- Concurrency: verify one capability instance per run; confirm teardown on
  cancel/disconnect (chat runs are detached — `chat_run_manager.py`).

### Phase 2 — Make the agent actually SEE (G1)
The native `screenshot` tool is text-only. Add a lursor-owned bridge tool
(e.g. `view_app` / `screenshot_app`) that:
1. Captures a PNG of the current page (or a given preview URL) to the workspace
   media dir.
2. Routes it through the existing vision path (`view_image` / `vision.py`) so the
   model receives a real analysis, OR returns a model-visible image content part
   if the active model natively supports vision (`vision.py:141
   model_supports_vision`).
- Register it alongside `make_view_image_tool` in `builder.py:577`.
- Decision to confirm during build: reuse the run's `BrowserCapability` page vs a
  standalone screenshot. Reusing keeps the agent's current navigation state
  (preferred) but requires access to the capability's page; a standalone shot is
  simpler but loses context. **Recommend: reuse the page.**

### Phase 3 — Runtime telemetry (G2)
- Attach `page.on("console")` and response listeners to capture console
  errors/warnings and failed/slow network requests.
- Expose `get_console_logs()` / `get_network_errors()` bridge tools (truncated,
  de-duplicated to control tokens — mirror how browser-tools-mcp caps output).
- Prefer adding this in a lursor-owned wrapper rather than editing vendored
  `pydantic_deep` (unless we own that dep — confirm). If we must touch the
  toolset, do it via subclass/composition.

### Phase 4 — Goal-mode visual verification (the highest-value change)
- Add a standalone async Playwright screenshot helper that captures the detected
  preview URL to a PNG (independent of the agent-run capability).
- In the evaluation seam (`goal_loop.py:290` `drive_goal_loop`, `evaluate=`
  callback; `chat.py:640` `on_evaluation`), when a preview URL exists: capture a
  screenshot, pass it to a **vision-capable** judge alongside the goal condition,
  so completion is judged on what rendered — not the transcript.
- Preserve existing resilience (`_evaluate_resiliently`, circuit breaker) —
  screenshot/vision failure must degrade to "not met" or transcript-only, never
  crash the loop.
- Config: `goal_evaluator_model` must be vision-capable when this is on; add a
  fallback.

### Phase 5 — Surface it in the UI (optional but valuable)
- Show browser activity / screenshots the agent took in the chat or a QA panel.
- NOTE (memory): new stream event types must be wired into BOTH the live-send and
  reconnect paths (AG-UI dual transport) — see `[[agui-event-dual-transport]]`.

## Config / flags
- `browser_qa_enabled` (default on for execution agents) — global kill switch.
- `browser_headless` (default true).
- Reuse `vision_model`; add `goal_evaluator_vision_model` or require the
  evaluator model be vision-capable when visual verification is on.
- `playwright_auto_install` (default true).

## Risks / open questions
- **R1 (G1 visibility):** confirm the exact mechanism to get a model-visible
  image with the current OpenRouter/Pydantic AI adapter — image content part vs
  the `view_image` tool round-trip. This is the make-or-break detail; validate
  early with a spike.
- **R2 (concurrency):** many concurrent agent runs each launch a headless
  Chromium (~memory heavy). Consider a cap / lazy-only (already lazy) / recycling.
- **R3 (first-run download):** ~150MB Chromium on first QA. Acceptable per
  decision; surface a "provisioning browser…" status so it doesn't look hung.
- **R4 (owning vendored code):** Phase 2/3 are cleaner if we own/patch
  `pydantic_deep`. Confirm whether we can contribute upstream to it or must wrap.
- **R5 (security):** agent-driven browser + `execute_js` on localhost only via
  `allowed_domains`; confirm the allowlist truly blocks external navigation.
- **R6 (auth flows):** headless fresh browser has no login state; QA of
  authenticated pages needs a seeding story (later).

## Rollout
1. Phase 0–1 behind `browser_qa_enabled`, dogfood on a sample project.
2. Phase 2 spike for R1, then enable.
3. Phase 3 telemetry.
4. Phase 4 evaluator integration — measure QA quality lift on goal-mode runs.
5. Phase 5 UI.

## Key files
- `backend/app/agents/builder.py:577,640-655` — tool/capability registration,
  dev-server directive.
- `backend/app/agents/vision.py:40,141` — vision sink + capability check.
- `backend/app/agents/preview_service.py`, `preview_detect.py` — preview URL.
- `backend/app/agents/goal_loop.py:182,266,290` — evaluator + seam.
- `backend/app/api/chat.py:586,640` — goal orchestration, `on_evaluation`.
- `backend/pyproject.toml` — add `pydantic-deep[browser]`.
- Engine ref: `pydantic_deep/features/browser/capability.py`,
  `pydantic_deep/agent.py:624`.
