#!/bin/sh
# Lursor desktop installer.
#
#   curl -fsSL https://raw.githubusercontent.com/JonathanConn/lursor/main/scripts/install.sh | sh
#
# Downloads the prebuilt Lursor desktop app for this OS/arch from GitHub
# Releases and installs it. The app bundles its own backend, so no Python, uv,
# bun, or manual server is required. After installing, open Lursor and paste
# your OpenRouter key in Settings.
#
# Env overrides:
#   LURSOR_REPO      owner/repo to fetch from       (default JonathanConn/lursor)
#   LURSOR_VERSION   pin a version, e.g. 1.2.3      (default: latest release)
#   LURSOR_PREFIX    Linux install dir              (default ~/.local/bin)
#
# Flags:
#   --uninstall      remove an installed Lursor
set -eu

REPO="${LURSOR_REPO:-JonathanConn/lursor}"
VERSION="${LURSOR_VERSION:-}"

info() { printf '\033[0;36m>>\033[0m %s\n' "$1"; }
warn() { printf '\033[0;33mwarning:\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[0;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# --- Detect platform ------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$ARCH" in
  arm64 | aarch64) ARCH_TAG="arm64" ;;
  x86_64 | amd64)  ARCH_TAG="x64" ;;
  *) die "unsupported architecture: $ARCH" ;;
esac

case "$OS" in
  Darwin) OS_TAG="mac";   EXT="dmg" ;;
  Linux)  OS_TAG="linux"; EXT="AppImage" ;;
  *) die "unsupported OS: $OS (this installer supports macOS and Linux)" ;;
esac

if [ "$OS_TAG" = "linux" ] && [ "$ARCH_TAG" != "x64" ]; then
  die "no Linux $ARCH_TAG build is published yet (only linux-x64)."
fi

SUFFIX="${OS_TAG}-${ARCH_TAG}.${EXT}"

# --- Uninstall ------------------------------------------------------------
uninstall() {
  if [ "$OS_TAG" = "mac" ]; then
    for d in /Applications "$HOME/Applications"; do
      if [ -d "$d/Lursor.app" ]; then
        info "Removing $d/Lursor.app"
        rm -rf "$d/Lursor.app"
      fi
    done
  else
    PREFIX="${LURSOR_PREFIX:-$HOME/.local/bin}"
    rm -f "$PREFIX/Lursor.AppImage"
    rm -f "$HOME/.local/share/applications/lursor.desktop"
    rm -f "$HOME/.local/share/icons/lursor.png"
    info "Removed Lursor AppImage and desktop entry"
  fi
  info "Done. (Your data in ~/.lursor was left untouched.)"
  exit 0
}

[ "${1:-}" = "--uninstall" ] && uninstall

# --- Resolve the download URL --------------------------------------------
command -v curl >/dev/null 2>&1 || die "curl is required."

if [ -n "$VERSION" ]; then
  ASSET="Lursor-${VERSION}-${SUFFIX}"
  URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET}"
else
  info "Resolving latest release of ${REPO} ..."
  API="https://api.github.com/repos/${REPO}/releases/latest"
  # Pull the browser_download_url whose asset name ends with our platform suffix.
  URL="$(curl -fsSL "$API" \
    | grep -o '"browser_download_url": *"[^"]*"' \
    | sed 's/.*"browser_download_url": *"//; s/"$//' \
    | grep "${SUFFIX}$" \
    | head -n 1 || true)"
  [ -n "$URL" ] || die "no ${SUFFIX} asset found in the latest release of ${REPO}."
  ASSET="$(basename "$URL")"
fi

# --- Download -------------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
info "Downloading ${ASSET} ..."
curl -fSL --progress-bar "$URL" -o "$TMP/$ASSET" || die "download failed: $URL"

# --- Install --------------------------------------------------------------
if [ "$OS_TAG" = "mac" ]; then
  info "Mounting disk image ..."
  MOUNT="$(hdiutil attach -nobrowse -readonly "$TMP/$ASSET" \
    | grep -o '/Volumes/.*' | head -n 1)"
  [ -n "$MOUNT" ] || die "could not mount $ASSET"

  DEST="/Applications"
  # Fall back to a per-user location if /Applications isn't writable.
  if [ ! -w "$DEST" ]; then
    DEST="$HOME/Applications"
    mkdir -p "$DEST"
  fi

  info "Installing to ${DEST}/Lursor.app ..."
  rm -rf "$DEST/Lursor.app"
  cp -R "$MOUNT/Lursor.app" "$DEST/"
  hdiutil detach "$MOUNT" >/dev/null || true

  # The app is unsigned and was downloaded via curl, so Gatekeeper would
  # quarantine it. Clear the flag so it opens without the "damaged" prompt.
  xattr -dr com.apple.quarantine "$DEST/Lursor.app" 2>/dev/null || true

  APP_PATH="$DEST/Lursor.app"
else
  PREFIX="${LURSOR_PREFIX:-$HOME/.local/bin}"
  mkdir -p "$PREFIX"
  APP_PATH="$PREFIX/Lursor.AppImage"
  info "Installing to ${APP_PATH} ..."
  cp "$TMP/$ASSET" "$APP_PATH"
  chmod +x "$APP_PATH"

  # Desktop entry so it shows up in the app menu.
  APPS_DIR="$HOME/.local/share/applications"
  mkdir -p "$APPS_DIR"
  cat > "$APPS_DIR/lursor.desktop" <<EOF
[Desktop Entry]
Name=Lursor
Exec=$APP_PATH
Terminal=false
Type=Application
Categories=Development;
EOF
fi

# --- Runtime soft-check ---------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  warn "git was not found on your PATH. Lursor's git/GitHub features need it; install git to enable them."
fi

# --- Done -----------------------------------------------------------------
printf '\n'
info "Lursor installed."
if [ "$OS_TAG" = "mac" ]; then
  info "Open it from Applications (or run: open \"$APP_PATH\")."
else
  info "Launch it from your app menu (or run: \"$APP_PATH\")."
fi
info "First run: open Settings and paste your OpenRouter API key to enable models."
