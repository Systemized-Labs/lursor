# Lursor Backend

FastAPI + SQLite backend for the Lursor agent harness. Agents are built on
[pydantic-deepagents](https://github.com/vstorm-co/pydantic-deepagents) and chat
is served over the [AG-UI](https://github.com/ag-ui-protocol/ag-ui) protocol via
Pydantic AI's first-party AG-UI adapter.

## Requirements

- Python 3.11 or 3.12 (managed via `uv`)
- An `OPENROUTER_API_KEY` (models are served through OpenRouter)

## Setup

```bash
cd backend
uv sync --extra dev          # create venv + install deps
cp .env.example .env         # then add your OPENROUTER_API_KEY
```

## Run

```bash
uv run uvicorn app.main:app --reload --port 8791
```

- API base: `http://localhost:8791/api`
- Interactive docs: `http://localhost:8791/docs`
- Health: `GET /api/health`

## Test & lint

```bash
uv run pytest        # end-to-end CRUD tests (no API key needed)
uv run ruff check app tests
```

## Layout

```
app/
  main.py          FastAPI app, CORS, router mounting, startup
  config.py        Settings (env / .env)
  db/
    session.py     Async SQLite engine + session dependency
    models.py      SQLModel tables (Agent, Skill, Tool, Workspace, Thread, Message)
  schemas/         Request/response models
  api/             CRUD routers + the AG-UI chat endpoint (chat.py)
  cron.py          Cron/timezone arithmetic (pure; no DB, no clock of its own)
  agents/
    builder.py     DB Agent row -> create_deep_agent(...)
    scheduler.py   The 30s tick that fires Schedule rows
tests/
```

## How schedules work

A `Schedule` row is a prompt, a cron expression, a timezone, one workspace and one
agent. `agents/scheduler.py` runs a single 30s `asyncio` tick (started from
`lifespan`): it selects enabled schedules whose `next_fire_at` has passed, opens a
fresh `Thread` per fire, and calls `chat.start_scheduled_run` — the headless
counterpart to the chat endpoint, converging on the same drivers so a scheduled run
can't drift from a manual one. The synthetic turn is persisted with `kind="cron"`,
and usage rows are tagged the same way so unattended spend is visible in Analytics.

Because the scheduler lives in this process, schedules fire only while the app is
up. On startup, an enabled schedule whose `next_fire_at` is in the past gets one
`missed` history row recording how many occurrences elapsed, and its clock rolls
forward — nothing is replayed. See the Schedules section of `AGENTS.md`.

## How chat works

`POST /api/threads/{id}/chat` is an AG-UI endpoint. It loads the thread's agent
row, renders it into a deep agent scoped to the workspace directory
(`builder.build_deep_agent`), and streams AG-UI events (tokens, tool calls) back
as SSE via `AGUIAdapter.dispatch_request`. The user and assistant turns are
persisted to the `messages` table for history.

## Notes / deferred

- Tool rows (`/api/tools`) are catalogued but not yet wired into agent execution;
  deep agents ship with their own builtin toolset. Wiring MCP/HTTP tools is a
  follow-up.
- Schema is created with `create_all` on startup. Introduce Alembic once it
  stabilizes.
- Single-user; every table has a nullable `user_id` for later multi-tenancy.
