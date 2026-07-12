# Lursor

A self-hosted **agent harness**: create and manage AI agents, skills, and tools;
organize them into **workspaces** (directories on disk); and chat with them in
real time.

Built on:
- **[pydantic-deepagents](https://github.com/vstorm-co/pydantic-deepagents)** — the deep-agent engine (planning, filesystem, subagents, skills), on Pydantic AI.
- **FastAPI + SQLite** backend.
- **Vite + React + Tailwind + shadcn/ui** frontend.
- **[AG-UI](https://github.com/ag-ui-protocol/ag-ui)** protocol for streaming chat (via Pydantic AI's first-party adapter).

## Structure

```
lursor/
  backend/     FastAPI + pydantic-deepagents + SQLite   (see backend/README.md)
  frontend/    Vite + React + Tailwind + shadcn/ui       (see frontend/README.md)
  docs/        Plans and design notes (docs/PLAN.md)
```

## Quick start

Two terminals (or use the dev script below).

**Backend**
```bash
cd backend
uv sync --extra dev
cp .env.example .env      # add your OPENROUTER_API_KEY
uv run uvicorn app.main:app --reload --port 8000
```

**Frontend**
```bash
cd frontend
bun install
cp .env.example .env      # VITE_API_BASE defaults to http://localhost:8000/api
bun run dev
```

Then open the Vite URL (default `http://localhost:5173`).

### One command

```bash
./scripts/dev.sh          # runs backend + frontend together
```

## Status

MVP. See [docs/PLAN.md](docs/PLAN.md) for the architecture, the build phases, and
what is intentionally deferred (auth, Docker sandboxing, run-forking, tool
execution wiring).
