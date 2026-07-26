#!/usr/bin/env bash
# Build a self-contained, relocatable backend bundle for the desktop app.
#
# Produces a directory containing a standalone CPython interpreter with the
# Lursor backend and all of its dependencies installed into it (no venv, so no
# absolute paths are baked in). The desktop app ships this under its resources
# and launches it with:
#
#   <bundle>/python/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port <port>
#
# Strategy (see docs/PLAN-desktop-install.md): a python-build-standalone
# interpreter (the same distributions `uv` uses) is relocatable, so we install
# the real wheels into it rather than freezing with PyInstaller — which copes
# poorly with this dependency tree (Playwright, a git-sourced package, pydantic).
#
# Usage:
#   backend/scripts/build_bundle.sh [OUTPUT_DIR] [PYTHON_VERSION]
# Defaults:
#   OUTPUT_DIR      = backend/bundle
#   PYTHON_VERSION  = the pin in backend/.python-version (fallback 3.12)
set -euo pipefail

# --- Resolve paths dynamically (no hardcoded locations). ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

OUTPUT_DIR="${1:-$BACKEND_DIR/bundle}"
PY_VERSION="${2:-}"
if [[ -z "$PY_VERSION" ]]; then
  if [[ -f "$BACKEND_DIR/.python-version" ]]; then
    PY_VERSION="$(tr -d '[:space:]' < "$BACKEND_DIR/.python-version")"
  else
    PY_VERSION="3.12"
  fi
fi

command -v uv >/dev/null 2>&1 || {
  echo "error: 'uv' is required to build the bundle (https://docs.astral.sh/uv/)." >&2
  exit 1
}

echo ">> Building backend bundle"
echo "   backend : $BACKEND_DIR"
echo "   output  : $OUTPUT_DIR"
echo "   python  : $PY_VERSION"

# --- Clean output. ---
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# --- 1. Fetch a standalone CPython into a scratch dir, then copy it in. ---
PYBUILD_DIR="$OUTPUT_DIR/.pybuild"
mkdir -p "$PYBUILD_DIR"
uv python install --install-dir "$PYBUILD_DIR" "$PY_VERSION"

# There is exactly one cpython-* install root inside PYBUILD_DIR.
PY_ROOT="$(find "$PYBUILD_DIR" -maxdepth 1 -type d -name 'cpython-*' | head -n 1)"
if [[ -z "$PY_ROOT" ]]; then
  echo "error: could not locate the standalone CPython install under $PYBUILD_DIR" >&2
  exit 1
fi

PY_DEST="$OUTPUT_DIR/python"
# Copy dereferencing symlinks so the bundle is self-contained and relocatable.
cp -RL "$PY_ROOT" "$PY_DEST"
rm -rf "$PYBUILD_DIR"

# uv marks its managed interpreters EXTERNALLY-MANAGED to prevent mutation. This
# copy is ours to populate, so drop the marker to allow installing into it.
find "$PY_DEST" -name EXTERNALLY-MANAGED -delete

PYBIN="$PY_DEST/bin/python3"
[[ -x "$PYBIN" ]] || PYBIN="$PY_DEST/bin/python"
if [[ ! -x "$PYBIN" ]]; then
  echo "error: no python executable under $PY_DEST/bin" >&2
  exit 1
fi

# --- 2. Install the backend + its (non-dev) dependencies into that interpreter. ---
# Install from uv.lock rather than resolving fresh: `uv pip install <project>`
# re-resolves and would let a release ship dependency versions that were never
# tested locally. Exporting the lock gives byte-identical bundles for a given
# commit. The optional `dev` extra is excluded from the shipped bundle.
echo ">> Installing backend + dependencies into the bundled interpreter ..."
REQ_FILE="$OUTPUT_DIR/.requirements.txt"
uv export \
  --project "$BACKEND_DIR" \
  --frozen \
  --no-dev \
  --no-emit-project \
  --no-hashes \
  -o "$REQ_FILE"
uv pip install --python "$PYBIN" -r "$REQ_FILE"
# The project itself is not in the exported requirements (--no-emit-project);
# install it without deps so the lock stays the single source of versions.
uv pip install --python "$PYBIN" --no-deps "$BACKEND_DIR"
rm -f "$REQ_FILE"

# --- 3. Smoke test: boot uvicorn against a throwaway data dir and hit health. ---
echo ">> Smoke-testing the bundle ..."
SMOKE_DATA="$(mktemp -d)"
SMOKE_PORT=8799
trap 'rm -rf "$SMOKE_DATA"' EXIT

LURSOR_DATA_DIR="$SMOKE_DATA" "$PYBIN" -m uvicorn app.main:app \
  --host 127.0.0.1 --port "$SMOKE_PORT" >"$SMOKE_DATA/server.log" 2>&1 &
SERVER_PID=$!

ok=0
for _ in $(seq 1 40); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "error: backend process exited during smoke test:" >&2
    cat "$SMOKE_DATA/server.log" >&2
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:$SMOKE_PORT/api/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 0.5
done

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true

if [[ "$ok" -ne 1 ]]; then
  echo "error: /api/health never became healthy. Server log:" >&2
  cat "$SMOKE_DATA/server.log" >&2
  exit 1
fi

BUNDLE_SIZE="$(du -sh "$OUTPUT_DIR" | cut -f1)"
echo ">> OK — bundle built and verified healthy ($BUNDLE_SIZE) at:"
echo "   $OUTPUT_DIR"
