#!/usr/bin/env bash
# Run backend (FastAPI) and frontend together for local development.
# Ctrl-C stops both.
#
# Usage:
#   ./scripts/dev.sh            backend + frontend (Vite) in the browser
#   ./scripts/dev.sh --electron backend + frontend inside the Electron desktop shell
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FRONTEND_CMD="dev"
FRONTEND_LABEL="frontend on :5173"
if [[ "${1:-}" == "--electron" ]]; then
  FRONTEND_CMD="electron:dev"
  FRONTEND_LABEL="frontend (Electron) — Vite on :5173"
fi

cleanup() {
  trap - INT TERM
  kill 0 2>/dev/null || true
}
trap cleanup INT TERM

echo "Installing frontend dependencies ..."
(cd "$ROOT_DIR/frontend" && bun install)

echo "Starting backend on :8791 ..."
# Bind to 0.0.0.0 so the API is reachable from other devices on the LAN (e.g.
# a phone hitting http://<this-machine-ip>:8791), not just localhost.
(cd "$ROOT_DIR/backend" && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8791) &

echo "Starting $FRONTEND_LABEL ..."
(cd "$ROOT_DIR/frontend" && bun run "$FRONTEND_CMD") &

wait
