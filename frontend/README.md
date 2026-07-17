# Lursor Frontend

Admin UI and streaming chat for the Lursor agent harness. Built with Vite,
React 18, TypeScript, Tailwind CSS, shadcn/ui, React Router, TanStack Query, and
the AG-UI client for streaming chat over SSE.

## Prerequisites

- Node 18+ (developed against Node 23)
- bun

## Setup

```bash
bun install
cp .env.example .env   # adjust VITE_API_BASE if needed
```

`VITE_API_BASE` defaults to `http://localhost:8791/api`.

## Scripts

```bash
bun run dev      # start the dev server
bun run build    # type-check (tsc -b) and build for production
bun run preview  # preview the production build
bun run lint     # run oxlint
```

## Desktop app (Electron)

The same UI ships as an Electron desktop app. See [../docs/ELECTRON.md](../docs/ELECTRON.md).

```bash
bun run electron:dev     # Vite + Electron together (backend must be running)
bun run electron:build   # package a distributable into release/
```

## Structure

- `src/api/` — typed API client and TanStack Query hooks per resource.
- `src/agui/` — AG-UI `HttpAgent` setup, event-to-UI reducer, and the
  `useAgentChat` hook (the only chat integration surface).
- `src/components/ui/` — shadcn/ui primitives.
- `src/components/` — shared app components (layout, theme, multi-select, etc.).
- `src/pages/` — Agents, Skills, Tools, Workspaces, and Chat pages.
- `src/lib/` — utilities including `cn`.

## Features

- Manage Agents, Skills, Tools, and Workspaces (create, edit, delete).
- Group agents into workspaces and open chat threads.
- Chat with an agent inside a workspace; assistant tokens and tool calls stream
  live over the AG-UI protocol.
- Dark and light mode via shadcn CSS variables.
