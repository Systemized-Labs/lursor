# Lursor Frontend

Admin UI and streaming chat for the Lursor agent harness. Built with Vite,
React 18, TypeScript, Tailwind CSS, shadcn/ui, React Router, TanStack Query, and
the AG-UI client for streaming chat over SSE.

## Prerequisites

- Node 18+ (developed against Node 23)
- pnpm

## Setup

```bash
pnpm install
cp .env.example .env   # adjust VITE_API_BASE if needed
```

`VITE_API_BASE` defaults to `http://localhost:8000/api`.

## Scripts

```bash
pnpm dev      # start the dev server
pnpm build    # type-check (tsc -b) and build for production
pnpm preview  # preview the production build
pnpm lint     # run oxlint
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
