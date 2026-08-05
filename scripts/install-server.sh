#!/bin/sh
# Lursor *backend* installer, for a machine that stays on.
#
#   curl -fsSL https://raw.githubusercontent.com/Systemized-Labs/lursor/main/scripts/install-server.sh | sh
#
# Installs the backend from source and hands it to the platform's supervisor, so it
# survives a reboot, a crash and an OOM kill. Re-run it to upgrade: it pulls, re-syncs
# and restarts the service, keeping your database, workspaces and token.
#
# The desktop app can also trigger an upgrade over the API, which runs
# scripts/self-update.sh rather than this script. That one does the same fetch/sync but
# restarts instead of reinstalling, because the running backend does not know which
# port it was installed on and `lursor-service install` prints the token — see the
# header of that script.
#
# This is the *server* half. It does not install the desktop app (scripts/install.sh
# does that) — you point that app at this backend afterwards, and the token printed at
# the end is how it authenticates. See docs/REMOTE.md.
#
# The real work is `lursor-service`, a CLI in the backend itself (app/service.py):
# rendering a systemd unit or a launchd plist is logic worth unit-testing, and this
# script is only the part that cannot be — fetching the code and building the
# environment that CLI then runs from.
#
# Env overrides:
#   LURSOR_REPO      owner/repo to clone from     (default Systemized-Labs/lursor)
#   LURSOR_DIR       where to install             (default ~/lursor)
#   LURSOR_REF       branch/tag to check out      (default main)
#   LURSOR_PORT      port to bind                 (default 8791)
#
# Flags:
#   --uninstall      stop and remove the service (leaves the code and your data)
set -eu

REPO="${LURSOR_REPO:-Systemized-Labs/lursor}"
DIR="${LURSOR_DIR:-$HOME/lursor}"
REF="${LURSOR_REF:-main}"
PORT="${LURSOR_PORT:-8791}"

info() { printf '\033[0;36m>>\033[0m %s\n' "$1"; }
warn() { printf '\033[0;33mwarning:\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[0;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    *) die "unknown option '$arg' (expected --uninstall)" ;;
  esac
done

# --- Sanity ---------------------------------------------------------------

[ "$(id -u)" -eq 0 ] && die "don't run this as root: the backend runs as you and uses
your home directory, so a root install puts its database and keys in /root."

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) die "unsupported OS: $(uname -s) (this installer supports Linux and macOS)" ;;
esac

# --- Uninstall ------------------------------------------------------------

if [ "$UNINSTALL" -eq 1 ]; then
  [ -d "$DIR/backend" ] || die "nothing installed at $DIR"
  info "Removing the service"
  ( cd "$DIR/backend" && uv run lursor-service uninstall )
  info "Done. The code in $DIR and your data in ~/.lursor were left alone."
  exit 0
fi

# --- Prerequisites --------------------------------------------------------

command -v git >/dev/null 2>&1 || die "git is required (install it and re-run)"

if ! command -v uv >/dev/null 2>&1; then
  # uv also fetches the right Python: the backend pins >=3.11,<3.13, and a distro
  # that ships something outside that range is the common case rather than the
  # exception (Fedora 44 ships 3.14).
  info "Installing uv (Python toolchain manager)"
  curl -fsSL https://astral.sh/uv/install.sh | sh || die "could not install uv"
  # The installer drops it here and only edits shell rc files, which do not apply to
  # this non-interactive shell.
  PATH="$HOME/.local/bin:$PATH"
  export PATH
  command -v uv >/dev/null 2>&1 || die "uv installed but not on PATH; open a new shell and re-run"
fi

# --- Fetch ----------------------------------------------------------------

if [ -d "$DIR/.git" ]; then
  info "Updating $DIR"
  git -C "$DIR" fetch --depth 1 origin "$REF"
  # Hard reset rather than pull: this directory is a deployment, not a workspace, and
  # a merge conflict here would leave a half-updated backend behind a service that is
  # about to restart into it.
  git -C "$DIR" reset --hard FETCH_HEAD
elif [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR exists and is not a git checkout; move it aside or set LURSOR_DIR"
else
  info "Cloning $REPO into $DIR"
  git clone --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$DIR"
fi

# --- Build ----------------------------------------------------------------

cd "$DIR/backend"
info "Installing dependencies (this downloads a Python and a large tree; give it a few minutes)"
uv sync

# --- Install the service --------------------------------------------------

# Anything this script has to say comes *before* the install, so the token block the
# CLI prints is the last thing on screen and can be copied without scrolling.
info "Installed at $DIR — check on it later with:"
printf '     cd %s/backend && uv run lursor-service status\n' "$DIR"

info "Installing the service"
uv run lursor-service install --port "$PORT"
