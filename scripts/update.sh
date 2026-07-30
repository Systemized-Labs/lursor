#!/bin/sh
# Lursor desktop updater.
#
#   curl -fsSL https://raw.githubusercontent.com/JonathanConn/lursor/main/scripts/update.sh | sh
#
# Compares the installed version against the latest GitHub release and, when a
# newer one exists, hands off to install.sh to download, verify, and install it.
#
# This is the update path for builds the in-app updater cannot install itself:
# Squirrel.Mac validates the code signature, so an unsigned macOS build can
# download an update and then fail at the last step. The desktop app detects
# that case and runs this script instead. Once releases are signed and
# notarized, in-app updates take over and this becomes a manual fallback.
#
# Env overrides:
#   LURSOR_REPO      owner/repo to fetch from         (default JonathanConn/lursor)
#   LURSOR_VERSION   update to this version           (default: latest release)
#   LURSOR_PREFIX    Linux install dir                (default ~/.local/bin)
#   LURSOR_DATA_DIR  where the version stamp lives    (default ~/.lursor)
#   LURSOR_REF       ref to fetch install.sh from     (default main)
#
# Flags:
#   --check          report the versions and exit; never install
#   --force          install even when already up to date
#   --wait-pid PID   wait for PID to exit before installing (a running Lursor)
#   --relaunch       open Lursor once the update is installed
set -eu

REPO="${LURSOR_REPO:-JonathanConn/lursor}"
VERSION="${LURSOR_VERSION:-}"
REF="${LURSOR_REF:-main}"
STAMP="${LURSOR_DATA_DIR:-$HOME/.lursor}/.install-version"
INSTALL_URL="https://raw.githubusercontent.com/${REPO}/${REF}/scripts/install.sh"

info() { printf '\033[0;36m>>\033[0m %s\n' "$1"; }
warn() { printf '\033[0;33mwarning:\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[0;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: update.sh [--check] [--force] [--wait-pid PID] [--relaunch]

  --check         report installed and latest versions, then exit
  --force         install even when already up to date
  --wait-pid PID  wait for PID to exit first (used by the app to update itself)
  --relaunch      open Lursor once the update is installed
EOF
}

CHECK_ONLY=0
FORCE=0
WAIT_PID=""
RELAUNCH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --check)     CHECK_ONLY=1 ;;
    --force)     FORCE=1 ;;
    --relaunch)  RELAUNCH=1 ;;
    --wait-pid)
      shift
      WAIT_PID="${1:-}"
      [ -n "$WAIT_PID" ] || die "--wait-pid needs a process id."
      ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

command -v curl >/dev/null 2>&1 || die "curl is required."

# --- Detect platform ------------------------------------------------------
case "$(uname -s)" in
  Darwin) OS_TAG="mac" ;;
  Linux)  OS_TAG="linux" ;;
  *) die "unsupported OS: $(uname -s) (this updater supports macOS and Linux)." ;;
esac

# --- Find the existing install -------------------------------------------
# Sets APP_PATH (empty when Lursor isn't installed) and INSTALLED (empty when
# the version can't be determined).
APP_PATH=""
INSTALLED=""

read_stamp() {
  [ -r "$STAMP" ] || return 0
  INSTALLED="$(head -n 1 "$STAMP" 2>/dev/null || true)"
}

detect_install() {
  if [ "$OS_TAG" = "mac" ]; then
    for d in /Applications "$HOME/Applications"; do
      [ -d "$d/Lursor.app" ] || continue
      APP_PATH="$d/Lursor.app"
      break
    done
    [ -n "$APP_PATH" ] || return 0
    # The bundle's own Info.plist is authoritative — it survives a drag-install,
    # a Homebrew cask install, and a stamp file that fell out of sync.
    if command -v plutil >/dev/null 2>&1; then
      INSTALLED="$(plutil -extract CFBundleShortVersionString raw -o - \
        "$APP_PATH/Contents/Info.plist" 2>/dev/null || true)"
    fi
    [ -n "$INSTALLED" ] || INSTALLED="$(defaults read \
      "$APP_PATH/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)"
    [ -n "$INSTALLED" ] || read_stamp
  else
    APP_PATH="${LURSOR_PREFIX:-$HOME/.local/bin}/Lursor.AppImage"
    [ -f "$APP_PATH" ] || { APP_PATH=""; return 0; }
    # An AppImage carries no version we can read back without unpacking ~400 MB
    # of squashfs, so the installer leaves a stamp behind instead.
    read_stamp
  fi
}

# --- Version comparison ---------------------------------------------------
# True when $1 is newer than $2. Dotted numeric compare, with a trailing
# prerelease (1.2.0-rc.1) ranking below the release it leads to.
version_gt() {
  awk -v a="$1" -v b="$2" '
    function base(v) { sub(/-.*$/, "", v); return v }
    function pre(v,  i) { i = index(v, "-"); return i ? substr(v, i + 1) : "" }
    BEGIN {
      na = split(base(a), A, "."); nb = split(base(b), B, ".")
      n = (na > nb ? na : nb)
      for (i = 1; i <= n; i++) {
        x = (i <= na ? A[i] : 0) + 0
        y = (i <= nb ? B[i] : 0) + 0
        if (x > y) exit 0
        if (x < y) exit 1
      }
      pa = pre(a); pb = pre(b)
      if (pa == pb) exit 1
      if (pa == "") exit 0
      if (pb == "") exit 1
      exit (pa > pb) ? 0 : 1
    }'
}

# --- Resolve the target version ------------------------------------------
resolve_target() {
  if [ -n "$VERSION" ]; then
    TARGET="${VERSION#v}"
    return 0
  fi
  TARGET="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep -o '"tag_name": *"[^"]*"' \
    | sed 's/.*"tag_name": *"//; s/"$//; s/^v//' \
    | head -n 1 || true)"
  [ -n "$TARGET" ] || die "could not resolve the latest release of ${REPO}."
}

# --- Hand off to the installer -------------------------------------------
# install.sh already knows how to download, checksum, and install each
# platform's artifact; pinning LURSOR_VERSION keeps it from re-resolving
# "latest" and installing something other than what we just compared against.
run_installer() {
  script_dir=""
  case "${0:-}" in
    */*) script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)" || script_dir="" ;;
  esac

  if [ -n "$script_dir" ] && [ -r "$script_dir/install.sh" ]; then
    installer="$script_dir/install.sh"
  else
    # Download rather than `curl … | sh`: a piped fetch that 404s feeds an empty
    # script to a shell that then exits 0, which reads as a successful update.
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL "$INSTALL_URL" -o "$tmp/install.sh" \
      || die "could not fetch the installer from $INSTALL_URL"
    [ -s "$tmp/install.sh" ] || die "the installer fetched from $INSTALL_URL was empty."
    installer="$tmp/install.sh"
  fi

  LURSOR_REPO="$REPO" LURSOR_VERSION="$TARGET" sh "$installer"
}

relaunch() {
  if [ "$OS_TAG" = "mac" ]; then
    for d in /Applications "$HOME/Applications"; do
      if [ -d "$d/Lursor.app" ]; then
        open "$d/Lursor.app" || warn "could not reopen Lursor."
        return 0
      fi
    done
  else
    p="${LURSOR_PREFIX:-$HOME/.local/bin}/Lursor.AppImage"
    if [ -x "$p" ]; then
      ("$p" >/dev/null 2>&1 &)
      return 0
    fi
  fi
  warn "could not find Lursor to reopen."
}

# --- Decide --------------------------------------------------------------
detect_install
if [ -z "$APP_PATH" ]; then
  die "no Lursor install found. Install it first:
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | sh"
fi

resolve_target

if [ -z "$INSTALLED" ]; then
  warn "could not determine the installed version; treating ${TARGET} as an update."
  info "Latest release: ${TARGET}"
elif [ "$INSTALLED" = "$TARGET" ]; then
  info "Lursor ${INSTALLED} is already up to date."
  [ "$FORCE" = 1 ] || exit 0
  info "Reinstalling ${TARGET} (--force)."
elif version_gt "$INSTALLED" "$TARGET"; then
  info "Installed ${INSTALLED} is newer than the latest release (${TARGET})."
  [ "$FORCE" = 1 ] || exit 0
  info "Installing ${TARGET} anyway (--force)."
else
  info "Update available: ${INSTALLED} -> ${TARGET}"
fi

if [ "$CHECK_ONLY" = 1 ]; then
  exit 0
fi

# --- Install --------------------------------------------------------------
# The bundle can't be replaced while it's running, so let the app get out of
# the way first. Bounded, because a hung app shouldn't leave this spinning.
if [ -n "$WAIT_PID" ]; then
  info "Waiting for Lursor (pid ${WAIT_PID}) to quit ..."
  waited=0
  while kill -0 "$WAIT_PID" 2>/dev/null; do
    waited=$((waited + 1))
    [ "$waited" -le 600 ] || die "Lursor (pid ${WAIT_PID}) is still running; quit it and re-run this updater."
    sleep 1
  done
fi

run_installer

[ "$RELAUNCH" = 1 ] && relaunch
exit 0
