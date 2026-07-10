#!/usr/bin/env bash
# Run backend (FastAPI) and frontend (Vite) together for local development.
# Ctrl-C stops both.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  trap - INT TERM
  kill 0 2>/dev/null || true
}
trap cleanup INT TERM

echo "Starting backend on :8000 ..."
(cd "$ROOT_DIR/backend" && uv run uvicorn app.main:app --reload --port 8000) &

echo "Starting frontend on :5173 ..."
(cd "$ROOT_DIR/frontend" && pnpm dev) &

wait
