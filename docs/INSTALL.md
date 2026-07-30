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

1. Open Lursor. A brief splash shows while the bundled backend starts, then the
   setup walkthrough takes over.
2. **Bring a model.** Paste an [OpenRouter key](https://openrouter.ai/keys), or
   switch to **Local** and point at any OpenAI-compatible endpoint (Ollama, LM
   Studio, vLLM, llama.cpp). Either one is enough; nothing runs without one. Keys
   are stored locally, on your machine.
3. **Connect GitHub** (optional). A personal access token with `repo` scope lets
   you clone repos into workspaces and gives agents authenticated git in the
   terminal. It lives in a Lursor-only git config — your `~/.gitconfig` is never
   touched.
4. **Open your first workspace** — clone a repo, or point at a folder you already
   have. That folder is where conversations run.
5. **Create your first agent** — a name, the model it runs on, and optionally what
   it should do. Conversations run as an agent, so this is what you'll be talking
   to; you can rename, re-prompt, and add tools later in Customization.
6. (Optional) The first time an agent uses visual QA, Chromium is downloaded
   automatically (~150 MB, one time).

To step through it again later: **Settings → General → Setup walkthrough**.

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

Lursor checks for updates on launch and every six hours, and asks before
restarting (restarting stops any running agents). How it installs one depends on
the build:

- **Linux AppImage, and signed macOS builds** — downloaded in the background and
  installed in place. Nothing to do.
- **Unsigned macOS builds** — Squirrel.Mac validates the code signature before
  swapping the app bundle, so it can download an update and then refuse to
  install it. Until Lursor's releases are signed and notarized, the app detects
  this, and "Update now" quits Lursor, runs the updater in a Terminal window,
  and reopens it.
- **`.deb`** — dpkg owns that install; re-run the installer or download a new one.

To update by hand at any time:

```bash
curl -fsSL https://raw.githubusercontent.com/JonathanConn/lursor/main/scripts/update.sh | sh
```

It compares what you have installed against the latest release and does nothing
if you're current. Add `--check` to see the two versions without installing, or
`--force` to reinstall regardless. The same `LURSOR_REPO`, `LURSOR_VERSION`, and
`LURSOR_PREFIX` variables apply, so `LURSOR_VERSION=1.2.3 … | sh` downgrades or
pins.

## Not yet supported

- Windows (a PowerShell installer is a fast-follow).
- Intel macOS and Linux arm64 builds.

For how the desktop app is wired and how to build it yourself, see
[ELECTRON.md](./ELECTRON.md); for the release process, see
[DISTRIBUTION.md](./DISTRIBUTION.md).
