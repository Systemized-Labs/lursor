#!/bin/sh
# Upgrade a backend deployment in place, from the backend itself.
#
# Not run by hand — `POST /api/update` spawns this (see backend/app/updater.py), which
# is why it takes its inputs from the environment and reports through files rather
# than through stdout and an exit code nobody is left alive to read.
#
# Why this exists next to install-server.sh, which already upgrades:
#
#   1. install-server.sh ends with `lursor-service install --port "$PORT"`, and that
#      needs a port. The running backend only knows its port from uvicorn's argv, so
#      the endpoint would have to guess — and guessing 8791 for a host installed on
#      another port silently moves the backend and breaks every saved client.
#   2. `lursor-service install` finishes by printing the auth token. Piped into a log
#      that `GET /api/update/log` serves back, that puts the token in the response and
#      in a file on disk. Disqualifying.
#
# So this does the fetch/sync half and restarts rather than reinstalling: the unit is
# never re-rendered, the port cannot move, and no secret is printed.
#
# Env (all set by the caller):
#   LURSOR_UPDATE_LOG     append progress here
#   LURSOR_UPDATE_EXIT    write the final exit status here
#   LURSOR_UPDATE_REF     the tag or branch to move to
#   LURSOR_UPDATE_RUNNER  "systemd-run" when we got our own cgroup, else "detached"
set -eu

LOG="${LURSOR_UPDATE_LOG:-$HOME/.lursor/update.log}"
EXIT_FILE="${LURSOR_UPDATE_EXIT:-$HOME/.lursor/update-exit-code}"
REF="${LURSOR_UPDATE_REF:-main}"

# Redirect here rather than letting the caller hand over a descriptor, so that
# wrapping this script in `systemd-run` (whose stdout goes to the journal) doesn't
# quietly move the log somewhere the API can't read it.
exec >>"$LOG" 2>&1

# `$?` inside the handler is the status at trap time, so this records the real
# outcome whether we fell off the end or died on `set -e`. It is the only signal the
# API has that the job finished, since the process that started it is gone by then.
on_exit() {
  status=$?
  printf '%s\n' "$status" >"$EXIT_FILE" 2>/dev/null || true
  if [ "$status" -eq 0 ]; then
    echo ">> update finished"
  else
    echo "error: update failed (exit $status)"
  fi
}
trap on_exit EXIT

echo ">> updating to $REF"

# The service environment is not a login shell, so the rc files that would have put
# uv on PATH never ran. install-server.sh drops it here.
PATH="$HOME/.local/bin:$PATH"
export PATH

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

command -v git >/dev/null 2>&1 || { echo "error: git is not on PATH"; exit 1; }
command -v uv  >/dev/null 2>&1 || { echo "error: uv is not on PATH"; exit 1; }

echo ">> fetching $REF"
git fetch --depth 1 origin "$REF"

# Hard reset, matching install-server.sh: this directory is a deployment, not a
# workspace, and a merge conflict here would leave a half-updated backend behind a
# service that is about to restart into it.
echo ">> checking out"
git reset --hard FETCH_HEAD

echo ">> syncing dependencies (this can take a few minutes)"
cd "$DIR/backend"
uv sync

# --- Restart -----------------------------------------------------------------
#
# Last, and only once everything above succeeded: a failed sync must leave the old
# code running rather than restart into a broken tree.
#
# On Linux this script normally runs inside its own transient systemd unit (see
# `start_update` in backend/app/updater.py), so restarting the backend does not touch
# us. When that wrapper was unavailable we are inside lursor-backend.service's own
# cgroup, and `KillMode=control-group` means the restart SIGKILLs this process
# mid-write — hence the warning, so a log that stops here is not read as a crash.
echo ">> restarting the service"
if [ "${LURSOR_UPDATE_RUNNER:-detached}" != "systemd-run" ] && [ "$(uname -s)" = "Linux" ]; then
  echo ">> note: this log ends here — the restart terminates this process too"
fi
uv run lursor-service restart

echo ">> service restarted"
