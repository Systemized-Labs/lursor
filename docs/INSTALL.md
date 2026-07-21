# Installing Lursor (desktop)

The desktop app bundles its own backend — a frozen, self-contained Python
interpreter that Lursor starts and stops for you. There is **no** separate
Python, `uv`, `bun`, or manual server to run.

## One-line install

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/JonathanConn/lursor/main/scripts/install.sh | sh
```

This downloads the prebuilt app for your OS/architecture from GitHub Releases and
installs it:

- **macOS** → `Lursor.app` into `/Applications` (or `~/Applications` if that isn't
  writable). Because the app is currently unsigned and downloaded via curl, the
  installer clears the Gatekeeper quarantine flag so it opens normally.
- **Linux** → `Lursor.AppImage` into `~/.local/bin` plus an app-menu entry.

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

- macOS (Apple Silicon or Intel) or Linux x86_64.
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

## Not yet supported

- Windows (a PowerShell installer is a fast-follow).
- Auto-update and code signing / notarization.

For how the desktop app is wired and how to build it yourself, see
[ELECTRON.md](./ELECTRON.md).
