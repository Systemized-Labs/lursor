#!/bin/sh
# Lursor desktop installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Systemized-Labs/lursor/main/scripts/install.sh | sh
#
# Downloads the prebuilt Lursor desktop app for this OS/arch from GitHub
# Releases and installs it. The app bundles its own backend, so no Python, uv,
# bun, or manual server is required. After installing, open Lursor and paste
# your OpenRouter key in Settings.
#
# Env overrides:
#   LURSOR_REPO      owner/repo to fetch from       (default Systemized-Labs/lursor)
#   LURSOR_VERSION   pin a version, e.g. 1.2.3      (default: latest release)
#   LURSOR_PREFIX    Linux install dir              (default ~/.local/bin)
#
# Flags:
#   --uninstall      remove an installed Lursor
set -eu

REPO="${LURSOR_REPO:-Systemized-Labs/lursor}"
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

# ASSET_ARCH is the arch string electron-builder actually puts in the filename,
# which is not always ARCH_TAG: it substitutes each target's own convention
# rather than the `${arch}` in our artifactName template (AppImage -> x86_64,
# deb -> amd64). ARCH_TAG stays the normalized form and still names the
# checksum file, which the release workflow derives from `matrix.arch`.
case "$OS" in
  Darwin) OS_TAG="mac";   EXT="dmg";      ASSET_ARCH="$ARCH_TAG" ;;
  Linux)  OS_TAG="linux"; EXT="AppImage"; ASSET_ARCH="x86_64" ;;
  *) die "unsupported OS: $OS (this installer supports macOS and Linux)" ;;
esac

if [ "$OS_TAG" = "linux" ] && [ "$ARCH_TAG" != "x64" ]; then
  die "no Linux $ARCH_TAG build is published yet (only linux-x64)."
fi

# Intel Macs are not built: the bundled Python interpreter is arch-specific and
# Apple has dropped x86_64. Building from source still works on Intel.
if [ "$OS_TAG" = "mac" ] && [ "$ARCH_TAG" != "arm64" ]; then
  die "macOS builds are Apple Silicon only. On an Intel Mac, run Lursor from source (see README)."
fi

SUFFIX="${OS_TAG}-${ASSET_ARCH}.${EXT}"
# One checksum file covers every platform's assets; we look ours up by name.
SUMS_ASSET="SHA256SUMS.txt"

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
  # Install metadata, not user data — nothing under ~/.lursor that you created.
  rm -f "${LURSOR_DATA_DIR:-$HOME/.lursor}/.install-version"
  info "Done. (Your data in ~/.lursor was left untouched.)"
  exit 0
}

[ "${1:-}" = "--uninstall" ] && uninstall

# --- Resolve the download URL --------------------------------------------
command -v curl >/dev/null 2>&1 || die "curl is required."

if [ -n "$VERSION" ]; then
  ASSET="Lursor-${VERSION}-${SUFFIX}"
  URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET}"
  SUMS_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${SUMS_ASSET}"
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
  # The checksum file sits next to the asset in the same release.
  SUMS_URL="$(dirname "$URL")/${SUMS_ASSET}"
fi

# --- Download -------------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
info "Downloading ${ASSET} ..."
curl -fSL --progress-bar "$URL" -o "$TMP/$ASSET" || die "download failed: $URL"

# --- Verify ---------------------------------------------------------------
# Fail closed on a mismatch, but tolerate a release that predates the checksum
# files rather than blocking the install outright.
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  fi
}

if curl -fsSL "$SUMS_URL" -o "$TMP/$SUMS_ASSET" 2>/dev/null; then
  EXPECTED="$(awk -v a="$ASSET" '$2 == a || $2 == "*" a {print $1}' "$TMP/$SUMS_ASSET" | head -n 1)"
  ACTUAL="$(sha256_of "$TMP/$ASSET")"
  if [ -z "$ACTUAL" ]; then
    warn "neither shasum nor sha256sum found — skipping checksum verification."
  elif [ -z "$EXPECTED" ]; then
    warn "no checksum listed for ${ASSET} — skipping verification."
  elif [ "$EXPECTED" != "$ACTUAL" ]; then
    die "checksum mismatch for ${ASSET} (expected ${EXPECTED}, got ${ACTUAL}). Aborting."
  else
    info "Checksum verified."
  fi
else
  warn "no ${SUMS_ASSET} published for this release — skipping checksum verification."
fi

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

  APP_PATH="$DEST/Lursor.app"

  # Released builds are signed and notarized, so Gatekeeper accepts them and the
  # quarantine flag can stay put (leaving it is what lets macOS keep verifying
  # the app). Only fall back to clearing it if this build fails assessment —
  # e.g. a locally built or otherwise unsigned artifact — since macOS 15 no
  # longer offers the Control-click bypass for those.
  if spctl --assess --type execute "$APP_PATH" >/dev/null 2>&1; then
    info "Signature verified by Gatekeeper."
  else
    warn "this build is not notarized; clearing the quarantine flag so it can open."
    xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
  fi
else
  PREFIX="${LURSOR_PREFIX:-$HOME/.local/bin}"
  mkdir -p "$PREFIX"
  APP_PATH="$PREFIX/Lursor.AppImage"
  info "Installing to ${APP_PATH} ..."
  cp "$TMP/$ASSET" "$APP_PATH"
  chmod +x "$APP_PATH"

  # Icon for the app menu. Fetched from the repo rather than unpacked from the
  # AppImage, which would mean extracting a ~400 MB squashfs to get one PNG.
  ICONS_DIR="$HOME/.local/share/icons"
  ICON_PATH="$ICONS_DIR/lursor.png"
  ICON_REF="${LURSOR_VERSION:+v$LURSOR_VERSION}"
  mkdir -p "$ICONS_DIR"
  if ! curl -fsSL \
    "https://raw.githubusercontent.com/${REPO}/${ICON_REF:-main}/frontend/build/icon.png" \
    -o "$ICON_PATH" 2>/dev/null; then
    rm -f "$ICON_PATH"
    warn "could not fetch the app icon; the menu entry will use a generic one."
  fi

  # Desktop entry so it shows up in the app menu.
  APPS_DIR="$HOME/.local/share/applications"
  mkdir -p "$APPS_DIR"
  {
    echo "[Desktop Entry]"
    echo "Name=Lursor"
    echo "Comment=Self-hosted agent harness"
    echo "Exec=$APP_PATH"
    [ -f "$ICON_PATH" ] && echo "Icon=$ICON_PATH"
    echo "Terminal=false"
    echo "Type=Application"
    echo "Categories=Development;"
    # Electron sets the WM class from productName; matching it here keeps the
    # running window grouped under this launcher instead of a second entry.
    echo "StartupWMClass=Lursor"
  } > "$APPS_DIR/lursor.desktop"
fi

# --- Record what we installed ---------------------------------------------
# scripts/update.sh compares against this. On macOS the app's Info.plist is the
# real source of truth, but an AppImage carries no version we can read back
# without unpacking ~400 MB of squashfs, so leave a stamp behind for it.
INSTALLED_VERSION="${ASSET#Lursor-}"
INSTALLED_VERSION="${INSTALLED_VERSION%-$SUFFIX}"
STAMP_DIR="${LURSOR_DATA_DIR:-$HOME/.lursor}"
if mkdir -p "$STAMP_DIR" 2>/dev/null; then
  printf '%s\n' "$INSTALLED_VERSION" > "$STAMP_DIR/.install-version" 2>/dev/null \
    || warn "could not record the installed version in $STAMP_DIR."
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
