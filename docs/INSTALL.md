# Installing Lursor (desktop)

The desktop app bundles its own backend — a frozen, self-contained Python
interpreter that Lursor starts and stops for you. There is **no** separate
Python, `uv`, `bun`, or manual server to run.

## One-line install

macOS (Apple Silicon) and Linux (x86_64):

```bash
curl -fsSL https://raw.githubusercontent.com/JonathanConn/lursor/main/scripts/install.sh | sh
```

This downloads the prebuilt app for your OS/architecture from GitHub Releases,
verifies it against the published SHA-256, and installs it:

- **macOS** → `Lursor.app` into `/Applications` (or `~/Applications` if that isn't
  writable). Released builds are signed and notarized, so Gatekeeper accepts them
  with no extra steps.
- **Linux** → `Lursor.AppImage` into `~/.local/bin` plus an app-menu entry.

## Homebrew (macOS)

```bash
brew tap --trust JonathanConn/lursor
brew install --cask lursor
```

Homebrew 6.0+ requires third-party taps to be trusted explicitly, which is what
the first command does. Lursor updates itself, so `brew upgrade` leaves the app
alone (`auto_updates true` in the cask).

### First run

1. Open Lursor. A brief splash shows while the bundled backend starts.
2. Open **Settings** and paste your **OpenRouter API key** — models won't work
   until you do. The key is stored locally in the app's config.
3. (Optional) The first time an agent uses visual QA, Chromium is downloaded
   automatically (~150 MB, one time).

## Options

Environment variables understood by the installer:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LURSOR_REPO` | `JonathanConn/lursor` | Source repo for releases |
| `LURSOR_VERSION` | latest release | Pin a specific version, e.g. `1.2.3` |
| `LURSOR_PREFIX` | `~/.local/bin` | Linux install directory |

Re-running the installer upgrades in place.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/JonathanConn/lursor/main/scripts/install.sh | sh -s -- --uninstall
```

Your data in `~/.lursor` (workspaces, skills, database, media) is left untouched.

## Requirements

- macOS on Apple Silicon, or Linux x86_64. (Intel Macs aren't built — run from
  source instead.)
- `git` on your `PATH` for the git/GitHub features (the installer warns if it's
  missing). Everything else the backend needs is bundled.

## Where things live

| Path | Contents |
| --- | --- |
| `~/.lursor/lursor.db` | SQLite database |
| `~/.lursor/workspaces/` | Workspace directories |
| `~/.lursor/skills/` | Skill folders |
| `~/.lursor/media/` | Chat attachments |

The app bundle itself is read-only; all writable state lives under `~/.lursor`
(the backend reads `LURSOR_DATA_DIR`, which the desktop app points here).

## Updates

Lursor checks for updates on launch and every six hours, downloads them in the
background, and asks before restarting (restarting stops any running agents).
This covers the macOS app and the Linux AppImage. If you installed the `.deb`,
re-run the installer or download a new one — dpkg owns that install.

## Not yet supported

- Windows (a PowerShell installer is a fast-follow).
- Intel macOS and Linux arm64 builds.

For how the desktop app is wired and how to build it yourself, see
[ELECTRON.md](./ELECTRON.md); for the release process, see
[DISTRIBUTION.md](./DISTRIBUTION.md).
