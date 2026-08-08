# AGENTS.md

Working notes for anyone — human or agent — changing this repo. This file is the
**index and the rules**: what the project is, how to build it, the conventions that
are not negotiable, and the invariants that have already cost a debugging session.
The per-subsystem design record lives in [`docs/architecture/`](docs/architecture/)
and is linked from §6.

Per-feature plan docs are deleted once shipped, with the durable decisions folded
into `docs/architecture/`. `git log --diff-filter=A -- docs/` finds the original
for any feature if you need the full reasoning.

For end-user and ops docs see [`README.md`](README.md),
[`docs/INSTALL.md`](docs/INSTALL.md), [`docs/ELECTRON.md`](docs/ELECTRON.md),
[`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) and
[`docs/REMOTE.md`](docs/REMOTE.md).

---

## 1. What this is

A self-hosted **agent harness**. You create agents (and subagents, skills, tools),
point them at **workspaces** (directories on disk), and chat with them — with a
live terminal, file browser, git review and dev-server preview alongside every
conversation.

The agent engine is **not ours**: [`pydantic-deepagents`](https://github.com/vstorm-co/pydantic-deepagents)
(`pydantic_deep`), pinned to a commit in `backend/pyproject.toml`, itself built on
Pydantic AI. Chat streams over the **AG-UI** protocol via Pydantic AI's
first-party adapter. That shapes almost every design decision below: when the
library's behaviour is wrong for us we **compose or wrap**, never patch — see
`agents/browser_qa.py`, `agents/context_budget.py`, `agents/deduping_backend.py`,
and the `task`-tool roster rewrite in `builder.py`.

## 2. Repo map

```
backend/          FastAPI + pydantic-deepagents + SQLite      (backend/README.md)
  app/api/        REST routers + the AG-UI chat endpoint (chat.py)
  app/agents/     agent construction and the run engine
  app/assistant/  the control-plane toolset and its isolation boundary
  app/skills/     skill discovery, scope resolution, script exec
  app/media/      image/video sources (laios, OpenRouter, custom)
  app/envvars/    env-var layer resolution
  app/db/         SQLModel tables, async session, migrations
  tests/          pytest, offline (no API key needed)
frontend/         Vite + React 19 + Tailwind v4 + shadcn/ui  (frontend/README.md)
  src/agui/       transport + chat store + engine
  src/api/        typed REST client + TanStack Query hooks, one file per resource
  src/components/ chat/, panes/ (the pane layer), layout/ (shell + sidebar),
                  settings/ (the settings dialog), shell/ (pane bodies), ui/
  src/pages/      one dir per destination
  electron/       desktop main + preload
docs/             INSTALL / ELECTRON / DISTRIBUTION / REMOTE  (user + ops)
  architecture/   the design record, one file per subsystem group (§6)
  upstream/       fixes for dependencies, prepared as diffs and never PR'd
  *-AUDIT.md      point-in-time audits, cited from code and tests
packaging/        Homebrew cask template (rendered by CI)
scripts/          dev.sh, install.sh, update.sh, install-server.sh
```

## 3. Commands

```bash
./scripts/dev.sh                      # backend + frontend
./scripts/dev.sh --electron [--debug] # ... in the Electron shell

cd backend
uv sync --extra dev                   # add --extra hindsight for the memory provider
uv run uvicorn app.main:app --reload --port 8791
uv run lursor-service install         # ... or as a supervised service (docs/REMOTE.md)
uv run pytest                         # offline; no API key needed
uv run ruff check app tests

cd frontend
bun install                           # NOT pnpm — pnpm deadlocks in this environment
bun run dev                           # :8888
bun run build                         # tsc -b && vite build
bun run lint                          # oxlint
```

There is **no frontend test runner**. Frontend changes are verified with
`tsc -b`, `oxlint`, and a manual pass. The bar for a backend change is
`uv run pytest` green *without editing existing tests* — if an existing test needs
changing, that is a signal the change altered behaviour it shouldn't have.

## 4. Hard conventions

**UI (non-negotiable, from the global rules):**
- Every text element carries `text-foreground` or `text-muted-foreground`.
- Never absolute colours (`text-white`, `bg-gray-*`). 87 theme blocks in
  `index.css` define the full semantic token set; use it. Adding a new
  `--custom` token means 87 edits — derive from existing tokens instead
  (the sessions sidebar does this: `bg-sidebar-accent/40`).
- Never the `container` class. Copy the surrounding page's padding
  (`px-4 py-6 sm:px-0`).
- No emoji anywhere.

**Code:**
- No `any` in TypeScript unless genuinely unavoidable.
- Backend: ruff, line length 100, `select = ["E","F","I","UP","B"]`.
- Prefer an official SDK over a hand-rolled client.

**Migrations:** SQLite + `create_all` for new tables, plus hand-rolled idempotent
blocks in `db/session.py::_apply_lightweight_migrations` (guarded by
`PRAGMA table_info`). **No Alembic.** New tables need no `ALTER` work; new columns
need one guarded block. Every migration must be idempotent across restarts, and
must be tested against a *copy* of a populated DB — see
`tests/test_*_migration.py`.

**Mobile:** one breakpoint, `md` (768px), matching `useIsMobile`. Fluid layouts —
no fixed `w-[…]`/`min-w-[…]` that can force horizontal scroll. QA anchors
360/390/430px portrait; those are anchors, not minimums. Dialogs become bottom
sheets below `md`. Respect safe-area insets (`pb-safe` etc.).

**No silent caps.** If a code path bounds something — iteration cap, truncation,
skipped fire, dropped result — it must say so in an event, a log line, or a
history row. A quiet stop reads as success.

**Device preferences go through `hooks/use-stored.ts`** — `useStoredSet` for a
membership set, `useStoredJson` for anything else, `readStored`/`writeStored` for a
format that is not JSON (the sidebar side is a bare string, and moving it would reset
the preference for everyone who has set it). Reads and writes are best-effort:
localStorage throws on a full quota and is absent in some private windows, so absence
means the default.

Nothing is written until a value actually diverges from what storage holds. **Do not
rewrite that guard as a "skip the first effect run" ref** — StrictMode deliberately
double-invokes effects, so the second invocation finds the ref set and stamps the
default in anyway. That was measured, not reasoned about: `lursor:pins` and
`lursor:projects-collapsed` both came back as `[]` on a clean first load with the ref
version in place. Comparing values is also what keeps toggling a preference *back* to
its default persisting.

## 5. Architecture at a glance

**Backend — one turn.** Detail:
[`docs/architecture/runs-and-intents.md`](docs/architecture/runs-and-intents.md).

```
POST /threads/{id}/chat
  → parse request + turn intent            api/chat.py
  → persist the user turn up front
  → _build_agent_and_context(session, …)   providers, subagents, skills + env vars
  → build_deep_agent(row, workspace_path,…)  agents/builder.py
  → AGUIAdapter.from_request(request, agent=agent)
  → pick a driver: chat | plan | goal | execute_plan
  → chat_run_manager.start_run(thread_id, driver)   detached asyncio.Task
  → return an SSE subscription to that run
```

**`chat_run_manager` is the load-bearing abstraction.** A run is an `asyncio.Task`
owned by the manager, not by the request: it buffers encoded SSE lines, fans out to
subscribers, and survives browser disconnect. The HTTP response is only a
*subscriber*. That one choice is what makes reconnect, stop, headless scheduled
runs and the Assistant's blocking confirmations all work with no extra machinery.

**Frontend — transport → store → view.** Detail:
[`docs/architecture/runs-and-intents.md`](docs/architecture/runs-and-intents.md).

```
transport   agui/agent.ts (HttpAgent) · agui/stream-reader.ts
                → one ChatEventHandlers sink, shared by BOTH transports
state       agui/chatStore.ts   Zustand, normalized: order[] + byId{}
controller  agui/useChatEngine.ts   send/stop/queue/load/reconnect
view        components/chat/ChatTimeline → MessageRow(id) → UserBubble
                                        | AssistantGroup, in <StickToBottom>
```

The normalized store is the fix for the chat surface's four chronic defects
(render flashes, scroll detach, streaming jank, older-message flash). A streamed
token mutates `byId[assistantId]`, so **only that row re-renders** — the timeline
subscribes to `order` alone.

**Everything else is a pane.** Chat, terminal, files, preview, diff and the media
pages are tabs inside zones of a dockview grid, and a pane's DOM node is never
reparented. Detail:
[`docs/architecture/frontend-shell.md`](docs/architecture/frontend-shell.md).

## 6. Subsystems

| Area | What's in it |
| --- | --- |
| [`runs-and-intents.md`](docs/architecture/runs-and-intents.md) | The run engine, the chat transport/store, turn intents and the plan → refine → execute flow, the goal loop, compaction |
| [`skills-and-env.md`](docs/architecture/skills-and-env.md) | Skills' four layers, bundled skills, Skill Studio, environment variables and redaction |
| [`tools-and-agents.md`](docs/architecture/tools-and-agents.md) | Tool deferral and `search_tools`, subagents, memory providers, file-editing guards, **the Assistant** (control plane) |
| [`media.md`](docs/architecture/media.md) | laios as a control plane, the three media sources, video generation, image generation |
| [`frontend-shell.md`](docs/architecture/frontend-shell.md) | The pane layer, the shell and settings dialog, the sidebar, the file editor, first run |
| [`services.md`](docs/architecture/services.md) | Schedules, preview/background processes, persistent terminals, browser visual QA, git/prompts/analytics/models |
| [`backlog.md`](docs/architecture/backlog.md) | Work deferred with a reason: shell-rewrite leftovers, the laios UI backlog |

Two point-in-time audits are cited from code and tests, and carry open findings:
[`docs/TOOL-SURFACE-AUDIT.md`](docs/TOOL-SURFACE-AUDIT.md) (every tool the model
actually sees) and [`docs/FILE-EDITING-AUDIT.md`](docs/FILE-EDITING-AUDIT.md)
(hashline read/edit against Claude Code and the reference implementations).

## 7. Invariants and traps

Each of these has already cost a debugging session.

1. **AG-UI dual transport.** A new stream event type must be wired into **both**
   the live-send path and the reconnect path. They share one
   `ChatEventHandlers` sink precisely so they can't diverge — keep it that way.
   Anything encoded through `chat_run_manager` is replay-safe for free; the
   cheapest correct move is to add no new event type at all (schedules did this).
2. **One `LocalBackend` per workspace, shared across runs.** Dev servers stay
   visible to `list_shells` and to the preview service because of it. It is also
   why run-scoped state (env) must use a `ContextVar`.
3. **`subscribe()` must not `await` between snapshotting the buffer and
   registering the queue.**
4. **Reconcile must not materialize into roots we don't own.** See
   [`skills-and-env.md`](docs/architecture/skills-and-env.md).
5. **The goal evaluator fails closed** (not met), never open.
6. **Cross-cache invalidation.** `threadKeys.all()` is a separate TanStack Query
   entry from `threadKeys.byWorkspace(id)`. Every invalidation and optimistic
   setter must touch both, or Pinned and the project status marks count
   conversations the sessions under those projects have already dropped.
7. **Declare literal routes before parameterized ones** (`/active-runs` before
   `/{thread_id}`).
8. **`GET /threads/{id}` must stay unfiltered.**
9. **The media source never falls back.** `resolve_image_target` /
   `resolve_video_target` resolve within the configured source or return `None`
   plus a reason — never another source. See
   [`media.md`](docs/architecture/media.md).
10. **A pane's DOM node must never be reparented.** `renderer: 'always'` is what
   guarantees it; a template applied without `reuseExistingPanels`, or built as a
   constant that forgets to name an open pane, destroys the panel instead — and
   with it a live PTY, a scrolled iframe and an unsaved buffer. See
   [`frontend-shell.md`](docs/architecture/frontend-shell.md).
11. **Nothing outside the pane layer may address a pane through the URL.** `?c=` is
   written *from* the focused chat pane; a sidebar row parks a request on
   `lib/open-thread.ts` instead. Reading the URL to position a pane happens in
   exactly one place — once per workspace load, to honour a bookmark.
12. **Unhandled exceptions need hand-set CORS headers.** Starlette's
   `ServerErrorMiddleware` sits *outside* `CORSMiddleware`, so a bare 500 carries
   no `access-control-allow-origin` and the browser reports `TypeError: Failed to
   fetch` — every server bug reads as the backend being down. `main.py` has an
   explicit handler; don't remove it.
13. **Never patch a vendored dependency.** Compose, subclass, or wrap with a
   `PrepareTools` / `AbstractCapability`. When a fix belongs upstream, prepare it
   locally as a patch under [`docs/upstream/`](docs/upstream/) and hand it over —
   this repo does not open PRs against third-party projects.
14. **Local models are a first-class constraint.** GLM/DeepSeek via vLLM ignore
    tool enums, need the todo board to scaffold, and break on native
    `WebSearchTool` under `OpenAIChatModel`. Anything that narrows the toolset
    should be tested against them, not just against a frontier cloud model.
15. **Tools are filtered by their real names, and `web_search` is not one.** The
    local search tools are `duckduckgo_search` / `tavily_search` / `exa_search`;
    `web_search` only ever names the provider-*native* tool, which is not a
    function tool and never reaches a `PrepareTools` filter. Dropping a local
    fallback leaves the unsupported native tool with nothing to fall back to and
    pydantic-ai raises `UserError` *before the request* — this killed every `/ask`
    turn with web search on a local model. A filter that allowlists by name needs
    a test that every entry is a name some build really registers; a subset
    assertion passes a dead entry silently (`tests/test_tool_loading.py`).
16. **Auth middleware is registered *before* CORS, which makes it inner.**
    `add_middleware` inserts at the front of the list and the stack is built in
    reverse, so the middleware added **last** is outermost. Registering auth second
    would put it outside `CORSMiddleware`, strip `access-control-allow-origin` from
    every 401, and turn each one into `TypeError: Failed to fetch` — trap 12
    again, one layer up. `tests/test_auth.py` asserts the header on a 401 precisely
    so a reorder fails loudly.
17. **A new WebSocket route is authenticated for free; a new *client* is not.**
    Browsers can't set headers on a WebSocket, so the token rides as a
    `lursor.bearer.<token>` subprotocol and `TokenAuthMiddleware` wraps `send` to
    echo it back on accept — which is why the route handlers call a bare
    `accept()` and know nothing about any of it. Keep it that way: a route that
    selects its own subprotocol will fight the wrapper. Any new client must go
    through `connectWs()` in `api/client.ts`, which is also the only place the ws/wss
    scheme is derived — four call sites used to carry their own copy.
18. **Never persist a *reachable* preview URL, only a canonical one.** A forwarded
    port is chosen per session, so a remembered `127.0.0.1:58608` points at nothing
    next launch — and a URL saved on a phone used to carry that phone's view of the
    network back to the desktop. `lib/preview-reach.ts` keeps the two apart:
    canonical for storage, comparison and display; reachable only for the iframe and
    `openExternal`.
19. **A backend cannot self-update from inside its own systemd cgroup.**
    `render_systemd_unit` sets `KillMode=control-group` so a restart can't orphan the
    dev servers an agent run spawned — which also means every descendant of the
    backend dies with it. `start_new_session=True` does *not* save you: it leaves the
    session and process group, not the cgroup. So the update job would be SIGKILLed by
    the very restart it just triggered, halfway through `uv sync`, leaving a
    half-synced checkout and a log that stops mid-sentence. `start_update` in
    `app/updater.py` hands the job to `systemd-run --user` for its own cgroup, and
    falls back to a detached spawn that *says so in the log* — because a truncated log
    and a crashed update look identical otherwise. launchd has no equivalent trap.
20. **Update state is polled, never pushed.** The obvious move for "tell the UI an
    update exists" is a new AG-UI event, and it is the wrong one: the stream is
    thread-scoped, so an update would only be announced to someone mid-conversation,
    and it would owe the dual-transport wiring in trap 1 for nothing. `/api/update/*`
    plus Electron IPC is the whole mechanism. This is trap 1's own advice —
    "the cheapest correct move is to add no new event type at all".
21. **All writable state lives under one root, `config.DEFAULT_DATA_ROOT`.** There is
    no "dev location" any more. Until 0.1.10 the database alone defaulted to
    `BACKEND_DIR/lursor.db` while `workspaces_dir`, `skills_dir` and `media_dir`
    already used `~/.lursor` — so the installed app and `bun run electron:dev` read
    *different databases*, and a workspace created in one was simply missing from the
    other with nothing to indicate why. The dev copy also sat inside a checkout that
    `install-server.sh` runs `git reset --hard` on. A new writable path belongs in
    `Settings` and gets rebased by `_rebase_under_data_dir`; do not reach for
    `BACKEND_DIR`. `LURSOR_DATA_DIR` remains the override, which is how a second
    isolated backend is run.
22. **The Assistant's privilege is the *workspace*, and `app/assistant/registry.py`
    is a leaf.** Nothing under `app/agents/` may import from `app/assistant/` except
    that module, which is what lets `builder.py` take the tool guard without a cycle.
    A control-plane tool reaching an agent outside the Assistant workspace **raises**
    (`AssistantToolLeak`) rather than being filtered out: filtering would make a
    broken security boundary look like a missing feature. See
    [`tools-and-agents.md`](docs/architecture/tools-and-agents.md).

## 8. Desktop and distribution

The Electron app **owns its backend by default**: packaged builds ship a frozen
standalone CPython and spawn `uvicorn` themselves, with `LURSOR_DATA_DIR=~/.lursor`
so all writable state stays out of the read-only bundle. `HashRouter` in Electron
(history routing doesn't work from `file://`), `BrowserRouter` in the browser.

It can also be a **thin client** against a backend on another machine — a VPS over
https with a bearer token — in which case nothing is spawned locally. Two
consequences worth knowing before touching the bootstrap:

- The connection is resolved **before** the app document loads, and the API base
  and token reach the renderer through a **synchronous** `sendSync` in the preload.
  `api/client.ts` resolves `API_BASE` and `AUTH_TOKEN` at module scope, and the
  connection isn't known when the window is created.
- **Switching connections never stops a local backend.** `releaseConnection()`
  drops the forwards and the header injection only; the process is killed on quit.
  Ending every agent run, dev server and PTY on this machine because the user
  looked at another one is the opposite of the point.

Platform scope: macOS arm64 and Linux x64. The frozen backend is
architecture-specific, so each arch is a full extra build. Windows is unbuilt (the
Electron main process already branches on `win32`; the bundle script is the missing
piece).

How it is all wired — connections, backend lifecycle, port forwarding, drag-out,
signing and notarization: [`docs/ELECTRON.md`](docs/ELECTRON.md). Release runbook,
channels and secrets: [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md). The
user-facing remote runbook: [`docs/REMOTE.md`](docs/REMOTE.md).

## 9. Deliberately not built

**Deferred by design:** multi-*user* auth and tenancy (every table still carries a
nullable `user_id`; the shipped auth is one token for one operator — see
`app/auth.py`), serving the SPA from the backend so a browser could reach a remote
instance (it would need a login screen and a session cookie, because a browser can't
put a header on a navigation or an iframe load), a container image for the backend
(`scripts/install-server.sh` + `app/service.py` install it from source under systemd
or launchd instead), resuming a turn interrupted by a backend restart (run state is
in-memory, so supervision means "the API comes back", not "the work continues" — see
`reconcile_interrupted_runs`), app-managed SSH tunnels (the shipped remote path is
https direct; a tunnel is supervised outside the app), restarting a *local* backend
that crashes (Electron logs the exit and leaves the window a dead shell), Docker
sandbox execution, MCP + HTTP tool wiring (`Tool` rows are catalogued but not yet
passed to agents), Alembic, encryption or OS keychain for stored secrets, an
always-on scheduler daemon, catch-up fires, non-cron triggers, chained schedules, a
budget ceiling that disables a schedule, auto-retain of transcripts into Hindsight,
terminal-panel env injection, custom `.claude/commands/*.md` slash commands,
virtualized chat timeline, backend thread pagination, and `.cursor/rules` /
`AGENTS.md` ingestion alongside skills.

**Known debt:** `api/chat.py` is ~1900 lines; moving the run engine out of
`app/api/` into `app/agents/` is the right follow-up. `Skill.scope` is a dormant
column left in place so a migration didn't have to rewrite the table.

Scoped-and-deferred work, each entry with the reason it was left:
[`docs/architecture/backlog.md`](docs/architecture/backlog.md).
