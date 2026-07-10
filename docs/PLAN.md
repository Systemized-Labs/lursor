# Lursor — Agent Harness MVP Plan

> Status: **MVP IMPLEMENTED** (2026-07-10). Backend + frontend scaffolded and verified end-to-end. See "Verification" at the bottom. Decisions below are locked.

## 1. What we're building

An **agent harness**: a self-hosted platform to create, configure, and manage AI agents (plus their skills and tools), organize them into **workspaces**, and **chat** with them in real time.

Built on:
- **[pydantic-deepagents](https://github.com/vstorm-co/pydantic-deepagents)** (`pydantic_deep`) — the deep-agent engine (planning, filesystem, subagents, skills, tools, memory), itself built on **Pydantic AI**.
- **FastAPI** backend + **SQLite** database.
- **Vite + React** frontend with the **AG-UI** protocol for chat.

### Key research finding (de-risks the hardest part)
Pydantic AI ships a **first-party AG-UI adapter** (`pydantic_ai.ag_ui`). Because pydantic-deepagents is built on Pydantic AI, a deep agent can be streamed to the browser as AG-UI Server-Sent Events with very little glue. The frontend talks to it with the AG-UI client SDK (`@ag-ui/client`). AG-UI is an open, event-based protocol (~16 event types: message tokens, tool calls, state patches, lifecycle) streamed as ordered JSON over SSE.

Sources:
- [pydantic-deepagents](https://github.com/vstorm-co/pydantic-deepagents) · [docs](https://vstorm-co.github.io/pydantic-deepagents/)
- [Pydantic AI AG-UI docs](https://ai.pydantic.dev/ui/ag-ui/) · [API](https://ai.pydantic.dev/api/ag_ui/)
- [AG-UI protocol](https://github.com/ag-ui-protocol/ag-ui) · [docs](https://docs.ag-ui.com/introduction)

## 2. Decisions (from kickoff)

| Decision | Choice |
|---|---|
| Repo layout | **Monorepo**: `backend/` + `frontend/` + `docs/` at repo root |
| Frontend | **Vite + React + TypeScript**, raw **AG-UI client** (`@ag-ui/client`) |
| Execution model | **Local filesystem** workspaces (a workspace = a directory on disk). No Docker in MVP; sandboxing is a later phase. |
| Auth | **Single-user, no auth.** DB carries a nullable `user_id` everywhere so multi-tenant auth drops in later without a painful migration. |
| Models | Served via **OpenRouter** (Pydantic AI `openrouter:` prefix). Default `openrouter:qwen/qwen3.7-max`, configurable per-agent. |

> Note on location: current working dir is `lursor/client`. I'll scaffold the monorepo **in this directory as the repo root**. If you'd rather it live at `lursor/` (renaming `client`), say so before we start.

## 3. Core domain model

```
Agent      — name, description, model, instructions/system prompt, feature flags
             (todo, subagents, skills, memory, web_search, thinking level), config JSON
Skill      — name, description, SKILL.md content (markdown, loaded on demand)
Tool       — name, description, kind (builtin | mcp | http), config JSON
Workspace  — name, filesystem path (agent's fs root), description
Thread     — a conversation: belongs to a workspace, bound to an agent, title
Message    — role, content, tool-call payload (JSON) — persists chat history/state

Join tables: agent_skills, agent_tools, workspace_agents (agents available in a workspace)
```

All tables get `id`, `created_at`, `updated_at`, and nullable `user_id`.

## 4. Architecture

```
┌─────────────────────────────┐        ┌──────────────────────────────────────┐
│  Frontend (Vite + React)    │        │  Backend (FastAPI)                     │
│                             │  REST  │                                        │
│  Agents / Skills / Tools /  │ ─────► │  /api/agents  /api/skills  /api/tools  │
│  Workspaces CRUD pages      │        │  /api/workspaces  /api/threads         │
│                             │        │                                        │
│  Chat page                  │  SSE   │  /api/threads/{id}/chat  (AG-UI)       │
│  (@ag-ui/client HttpAgent)  │ ◄────► │    → builds deep agent from DB row     │
│                             │        │    → pydantic_ai.ag_ui adapter stream  │
└─────────────────────────────┘        │    → persists messages                 │
                                        │                                        │
                                        │  SQLite (SQLModel + aiosqlite)         │
                                        │  Workspaces = dirs under WORKSPACES_DIR│
                                        └──────────────────────────────────────┘
```

### Backend layout
```
backend/
  pyproject.toml
  app/
    main.py            # FastAPI app, CORS, router mount, startup (create tables)
    config.py          # pydantic-settings: DB_URL, WORKSPACES_DIR, OPENROUTER_API_KEY
    db/
      session.py       # async engine + session dependency (aiosqlite)
      models.py        # SQLModel tables
    schemas/           # request/response Pydantic models
    api/
      agents.py        skills.py   tools.py
      workspaces.py    threads.py  chat.py   # chat.py = AG-UI SSE endpoint
    agents/
      builder.py       # DB Agent row -> create_deep_agent(...) config
    services/          # persistence + orchestration helpers
  tests/
```

### Frontend layout
```
frontend/
  package.json  vite.config.ts  tsconfig.json
  src/
    main.tsx  App.tsx  router
    api/          # typed REST client (agents/skills/tools/workspaces/threads)
    agui/         # AG-UI HttpAgent setup + event → UI reducer
    pages/        # Agents, Skills, Tools, Workspaces, Chat
    components/    ui/   # shared: table, form, layout, message list
```

### The chat flow (the interesting bit)
1. User opens a Thread (workspace + agent) and sends a message.
2. Frontend `@ag-ui/client` posts a `RunAgentInput` (history + state) to `/api/threads/{id}/chat`.
3. Backend loads the `Agent` row → `builder.py` calls `create_deep_agent(...)` with that agent's model, instructions, flags, attached skills (written into the workspace as `SKILL.md` files or passed in) and tools. Workspace dir becomes the agent's filesystem root.
4. `pydantic_ai.ag_ui` adapter runs the agent and streams AG-UI events (tokens, tool calls, state) back as SSE.
5. Backend persists user + assistant messages to `Message` for history/replay.

## 5. Build phases (each phase = runnable checkpoint)

**Phase 0 — Scaffold & tooling**
- Monorepo, `backend/` (uv or venv + pyproject), `frontend/` (Vite React-TS).
- `.env.example`, `README.md`, dev scripts to run both. Install pydantic-deepagents.
- Health check endpoint + "hello" React page talking to it.

**Phase 1 — Backend core + CRUD**
- SQLModel models + async SQLite, table creation on startup.
- CRUD APIs: agents, skills, tools, workspaces (+ join management).
- Workspace create = make a directory under `WORKSPACES_DIR`.
- Basic pytest coverage for CRUD.

**Phase 2 — Agent builder + AG-UI chat**
- `builder.py`: map a DB Agent → `create_deep_agent(...)`.
- Threads API + AG-UI SSE chat endpoint via `pydantic_ai.ag_ui`.
- Message persistence.

**Phase 3 — Frontend**
- CRUD pages for agents / skills / tools / workspaces.
- Chat page wired to AG-UI client (streaming tokens, tool-call display).
- Thread list + history.

**Phase 4 — Polish (still MVP)**
- Loading/error states, form validation, empty states.
- Seed/example agent + skill so it works out of the box.
- Dark/light-safe styling (semantic colors only).

### Deferred (post-MVP, but designed for)
Auth/multi-tenancy · Docker sandbox execution · live-run forking · MCP tool wiring UI · memory/checkpoints browsing · deployment/packaging.

## 6. Proposed stack details

- **Backend:** Python 3.11+, FastAPI, `SQLModel` + `aiosqlite` (async), `pydantic-settings`, `pydantic-deep`, Pydantic AI, `uvicorn`. Tables via `create_all` for MVP; add Alembic when schema stabilizes.
- **Frontend:** Vite, React 18, TypeScript, React Router, `@ag-ui/client`, a light component approach (plain CSS or Tailwind — TBD in Phase 0). Semantic color tokens only (dark/light safe).

## 7. Resolved decisions
1. **Install source:** pydantic-deep installed from the GitHub repo (`pydantic-deep @ git+https://github.com/vstorm-co/pydantic-deepagents.git`). Also required `ag-ui-protocol` for the adapter.
2. **Frontend styling:** Tailwind **v4** (CSS-first config via `@tailwindcss/vite`, `@theme inline` tokens, `tw-animate-css`) + shadcn/ui components (hand-written on Radix).
3. **Directory:** monorepo root is `lursor/` (the `client` subdir was removed).
4. **MVP scope:** no additions to the deferred list.

## 8. Verification (2026-07-10)

- **Backend:** `ruff` clean; `pytest` 4/4 pass; live `uvicorn` serves `/api/health` + full CRUD; seed script runs.
- **Deep agent:** `builder.build_deep_agent` constructs a real `pydantic_ai.Agent` offline.
- **AG-UI chat, end-to-end:** POSTing a `RunAgentInput` to `/api/threads/{id}/chat` streams SSE events (`RUN_STARTED` → token/tool events; ends in `RUN_ERROR` only when no valid provider key is set). User turn persisted; assistant turn persists on successful runs.
- **Frontend:** `pnpm build` (tsc + vite) passes with zero type errors; dev server serves the app (title "Lursor") with router, CRUD pages, and the AG-UI chat page wired to the backend endpoint.

### Confirmed integration facts (from introspecting installed packages)
- `create_deep_agent(...)` returns a `pydantic_ai.Agent`, so it drops straight into `AGUIAdapter.dispatch_request`.
- On-disk workspaces: `LocalBackend(root_dir=<workspace path>)`. Skills passed as `pydantic_deep.Skill(name, description, content)`.
- Frontend uses `@ag-ui/client@0.0.57` `HttpAgent.runAgent({}, subscriber)` with typed event callbacks, isolated behind `useAgentChat(threadId)`.

### To run with real chat
Set `OPENROUTER_API_KEY` in `backend/.env` (default model `openrouter:qwen/qwen3.7-max`), then `./scripts/dev.sh`.
```

