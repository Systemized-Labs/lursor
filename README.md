# Lursor

A self-hosted **agent harness**: create and manage AI agents, skills, subagents,
and tools; organize them into **workspaces** (directories on disk); and chat with
them in real time — with a live terminal, file browser, git review, and dev-server
preview alongside every conversation.

Built on:
- **[pydantic-deepagents](https://github.com/vstorm-co/pydantic-deepagents)** — the deep-agent engine (planning, filesystem, subagents, skills, memory), on Pydantic AI.
- **FastAPI + SQLite** backend.
- **Vite + React + Tailwind + shadcn/ui** frontend, which also ships as an **Electron** desktop app.
- **[AG-UI](https://github.com/ag-ui-protocol/ag-ui)** protocol for streaming chat (via Pydantic AI's first-party adapter).
- **OpenRouter** for cloud models, plus optional local models driven through a **laios** daemon.

## Features

- **Agents, skills, subagents, tools** — full CRUD, with per-agent model,
  instructions, and feature flags (todo, subagents, skills, memory, web search,
  thinking level).
- **Workspaces** — each is a directory on disk that becomes an agent's filesystem
  root. Group the agents available in a workspace and open chat threads against them.
- **Streaming chat** — assistant tokens and tool calls stream live over AG-UI SSE.
  Threads are auto-named by a fast model; `/compact` summarizes long conversations.
- **Context compaction** — long runs summarize their own history before the window
  fills. Every agent and subagent can override how full the window gets first, and
  how much of the history goes into the summary versus stays verbatim.
- **Plan → refine → execute** and **goal mode** — a self-continuing loop that drafts
  a plan, (optionally) waits for approval, then works turn after turn until an
  independent evaluator judges the objective met.
- **Schedules** — give an agent standing work on a cron expression (in its own
  timezone, so 9am survives DST). Each fire opens a fresh conversation as either a
  single turn or a goal run. In-process, so schedules fire only while Lursor is
  running; anything due while it was closed is reported, never replayed.
- **Live terminal** — a real PTY per workspace over a WebSocket (job control,
  full-screen apps; POSIX only).
- **File browser** — inspect and upload files in a workspace.
- **Changes panel** — the working-tree git diff for every repo found under a
  workspace, plus GitHub integration.
- **Preview** — auto-detects background dev servers the agent starts and surfaces
  their URLs.
- **Analytics** — token-usage and cost rollups per model, workspace, and day.
- **Prompt library** — curated, seeded prompt templates.
- **Providers & models** — OpenRouter by default; add custom providers and drive
  local model daemons (pull / serve / VRAM) via laios.

## Structure

```
lursor/
  backend/     FastAPI + pydantic-deepagents + SQLite   (see backend/README.md)
  frontend/    Vite + React + Tailwind + shadcn/ui       (see frontend/README.md)
               also runs as an Electron desktop app     (see docs/ELECTRON.md)
  docs/        Install, desktop, and release docs
               design record lives in AGENTS.md at the repo root
  packaging/   Homebrew cask template (rendered by the release workflow)
  scripts/     dev.sh — run backend + frontend together
               install.sh — one-line desktop installer (curl | sh)
```

## Install (desktop app)

The quickest way to run Lursor is the desktop app, which **bundles its own
backend** — no Python, `uv`, `bun`, or manual server needed:

```bash
curl -fsSL https://raw.githubusercontent.com/JonathanConn/lursor/main/scripts/install.sh | sh
```

Or on macOS, via Homebrew:

```bash
brew tap --trust JonathanConn/lursor && brew install --cask lursor
```

macOS (Apple Silicon) and Linux x86_64. After it installs, open Lursor and paste
your OpenRouter key in **Settings**. See [docs/INSTALL.md](docs/INSTALL.md) for
options and uninstall, and [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) for how
releases are built and signed.

## Quick start (from source)

Two terminals (or use the dev script below).

**Backend**
```bash
cd backend
uv sync --extra dev
cp .env.example .env      # add your OPENROUTER_API_KEY
uv run uvicorn app.main:app --reload --port 8791
```

**Frontend**
```bash
cd frontend
bun install
cp .env.example .env      # VITE_API_BASE defaults to http://localhost:8791/api
bun run dev
```

Then open the Vite URL (default `http://localhost:8888`).

### One command

```bash
./scripts/dev.sh              # backend + frontend in the browser
./scripts/dev.sh --electron   # backend + frontend in the Electron desktop shell
./scripts/dev.sh --electron --debug   # ... and auto-open Chrome DevTools
```

Ctrl-C stops both processes. See [docs/ELECTRON.md](docs/ELECTRON.md) for how the
desktop app is wired and how to package a distributable.

## Status

MVP, actively growing. [AGENTS.md](AGENTS.md) is the design record — the
architecture, the subsystem-by-subsystem decisions, the invariants worth knowing
before changing anything, and what is deliberately not built. Auth/multi-tenancy
and Docker sandboxing remain intentionally deferred.
