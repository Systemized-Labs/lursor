# PLAN: One-curl desktop install (bundled backend)

Status: **draft, awaiting approval** · Target platforms: **macOS + Linux** · Owner: jon

## Goal

A new user runs a single command:

```bash
curl -fsSL https://<host>/install.sh | sh
```

…and ends up with the **Lursor desktop app installed and fully functional** — no
Python, `uv`, `bun`, or manually-started backend required. The Electron app owns
its own FastAPI backend as a bundled child process. The OpenRouter key is entered
later in the in-app Settings page (no key handling in the installer).

This requires three new pieces that don't exist today:

1. **A self-contained backend bundle** (frozen Python + deps) shipped inside the app.
2. **Electron backend lifecycle** — spawn on launch, health-check, tear down on quit.
3. **A release pipeline + a static `install.sh`** that downloads the right artifact.

## Current state (what we're building on)

- Backend: FastAPI, `uv`-managed, Python 3.12, git-sourced `pydantic-deepagents`,
  SQLite, runs `uvicorn app.main:app` on `:8791`. Runtime data dirs already default
  to `~/.lursor/` (`workspaces/`, `skills/`, `media/`) — **except the DB**, which
  defaults to `BACKEND_DIR/lursor.db` (`backend/app/config.py`). That path becomes
  read-only once bundled and must move to `~/.lursor/`.
- Frontend: Vite/React, packaged by **electron-builder** (mac `dmg`+`zip`, linux
  `AppImage`+`deb`). `frontend/electron/main.cjs` today just loads `dist/index.html`
  and **expects a backend to already be running** — it never starts one.
- No CI, no release publishing, no code signing/notarization, no auto-update.
- Runtime prereqs that survive bundling: **git binary** (github/git features via
  subprocess), a **POSIX shell/PTY** (terminal), and **Chromium** (Playwright, lazy
  `playwright install chromium` on first use). Python/uv/bun are eliminated by the
  freeze.

## Design decisions (locked from Q&A)

| Decision | Choice |
| --- | --- |
| Backend delivery | Bundle a frozen Python backend inside the Electron app; Electron spawns it |
| Platforms (v1) | macOS (arm64 + x86_64) and Linux (x86_64) |
| API key | In-app Settings page only (persisted to `AppConfig` in DB); installer never touches keys |

## Architecture

```
Lursor.app / Lursor.AppImage
  ├─ renderer (dist/, built by vite)              loaded from file://
  ├─ electron/main.cjs                            spawns + supervises backend
  └─ resources/backend/                           the frozen bundle (extraResources)
       ├─ python (relocatable interpreter)
       ├─ site-packages/ (app + all deps)
       └─ app/ (the FastAPI source)

Runtime data (writable, outside the app bundle):
  ~/.lursor/
     lursor.db          ← DATABASE_URL points here (moved out of backend dir)
     workspaces/  skills/  media/
```

On launch: Electron picks a free port → spawns the bundled backend bound to
`127.0.0.1:<port>` → polls `GET /api/health` until ok (with a splash screen) →
loads the renderer, injecting the resolved API base → on quit/`window-all-closed`,
kills the backend child.

## Freezing strategy (the load-bearing decision)

**Recommended: relocatable standalone-CPython + installed deps** (not PyInstaller).

Rationale: the dependency tree (pydantic, fastapi, playwright, greenlet, aiosqlite,
a git-sourced package) is exactly the kind of thing PyInstaller's hidden-import /
data-file heuristics get wrong. A [python-build-standalone](https://github.com/astral-sh/python-build-standalone)
interpreter (the same distributions `uv` uses) is relocatable and lets us install
the real wheels with no freezing guesswork.

Build steps (per platform, in CI):

1. `uv python install 3.12` → get a standalone interpreter; copy it into `resources/backend/python/`.
2. `uv pip install --python resources/backend/python --no-dev .` from `backend/`
   (installs `app` + all deps, incl. the git dependency, into the interpreter's
   own `site-packages` — **no venv**, so no hardcoded absolute paths).
3. Copy `backend/app/` alongside (or rely on the installed `app` package).
4. Smoke-test: `resources/backend/python/bin/python -m uvicorn app.main:app` boots
   and `GET /api/health` returns ok.

Launcher invocation from Electron:
`<resources>/backend/python/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port <port>`
(Windows path `python/python.exe` — out of scope for v1 but keep the shape.)

*Alternative considered:* PyInstaller onedir. Rejected for v1 due to Playwright +
large-tree fragility, but noted if bundle size becomes a problem.

Bundle-size notes: Chromium is **not** pre-bundled; Playwright lazy-downloads it to
its own cache (~150 MB) on first browser-QA use. Acceptable; we surface a one-time
note. If we want zero runtime downloads later, pre-fetch Chromium in CI into the
bundle and set `PLAYWRIGHT_BROWSERS_PATH`.

## Work breakdown

### Phase 1 — Backend: make it bundle-safe
- `backend/app/config.py`: move DB default out of the bundle. Add a `LURSOR_DATA_DIR`
  (default `~/.lursor`) and derive `database_url`, `workspaces_dir`, `skills_dir`,
  `media_dir` from it. Electron overrides via env.
- Confirm all writable paths resolve under `~/.lursor` when the app dir is read-only.
- Add a `backend/scripts/build_bundle.sh` implementing the freeze steps above
  (parametrized by target dir; no hardcoded paths — dynamic discovery per global rules).
- Bind default host to `127.0.0.1` for the packaged app (dev keeps `0.0.0.0`).

### Phase 2 — Electron: backend lifecycle
- `frontend/electron/main.cjs`:
  - Resolve bundle path: `process.resourcesPath/backend` when `app.isPackaged`,
    else fall back to running `uv run uvicorn …` from the repo (so `electron:dev`
    still works without freezing).
  - Pick a free port; spawn backend with `env` = `{ LURSOR_DATA_DIR, DATABASE_URL,
    HOST, PORT, browser flags }`.
  - Splash/loading window; poll `/api/health` (timeout + error screen on failure).
  - Inject the resolved API base into the renderer (via `preload.cjs` →
    `window.electron.apiBase`) instead of the build-time `VITE_API_BASE`, so a
    dynamic port works.
  - `app.requestSingleInstanceLock()`; kill child on `quit`/`will-quit`.
- Frontend API client: prefer `window.electron.apiBase` when present, else
  `VITE_API_BASE` (browser dev unchanged).
- `frontend/package.json` build block: add `extraResources` to copy the frozen
  `backend/` bundle into `resources/`; keep mac (`dmg`+`zip`, arm64+x64) and linux
  (`AppImage`) targets.

### Phase 3 — Release pipeline (CI)
- `.github/workflows/release.yml`: on tag `v*`, matrix build on `macos-14` (arm64),
  `macos-13` (x86_64), `ubuntu-latest` (x64):
  - build frontend, run `build_bundle.sh`, run `electron-builder --publish always`
    to attach artifacts to a **GitHub Release**.
  - Publish a `latest.json`/`version` file the installer reads.
- **Unsigned for v1** — document Gatekeeper/quarantine handling (installer strips
  `com.apple.quarantine`). Signing + notarization is a fast-follow, not v1.

### Phase 4 — The static `install.sh`
- `scripts/install.sh` (served raw from the repo/release or a website):
  - Detect OS (`Darwin`/`Linux`) + arch; map to artifact name.
  - Resolve latest version from the published version file (override via `LURSOR_VERSION`).
  - Download the matching artifact to a temp dir; verify checksum.
  - **macOS**: mount dmg (or unzip), copy `Lursor.app` to `/Applications` (fall back
    to `~/Applications` if no perms), `xattr -dr com.apple.quarantine`, optionally open it.
  - **Linux**: place `Lursor.AppImage` in `~/.local/bin`, `chmod +x`, write a
    `~/.local/share/applications/lursor.desktop` entry + icon.
  - Soft-check for `git`; warn (not fail) if missing, since git-backed features need it.
  - Idempotent re-runs (upgrade in place). Clear final message: "Open Lursor, then
    paste your OpenRouter key in Settings."
- Provide a matching uninstall path (`--uninstall`) and a documented one-liner in README.

### Phase 5 — Docs
- Rewrite `docs/ELECTRON.md` packaging section (backend is now bundled).
- Add `docs/INSTALL.md` + README "Install" section with the curl one-liner and the
  "enter your key in Settings" first-run note.

## First-run UX

1. Install via curl → app appears in /Applications (mac) or app menu (linux).
2. Open app → splash while the bundled backend boots → main UI.
3. No models work yet → Settings page → paste OpenRouter key (saved to `AppConfig`).
4. Optional: first agent that uses browser QA triggers a one-time Chromium download.

## Risks / open items

- **Bundle size**: standalone Python + deps ≈ 150–300 MB before Chromium. Acceptable
  for a dev tool; revisit if it balloons.
- **macOS Gatekeeper**: unsigned apps downloaded via curl are quarantined; the
  installer's `xattr` strip handles it but is a smell. Signing/notarization is the
  proper fix (fast-follow).
- **Port conflicts / multiple instances**: mitigated by dynamic port + single-instance lock.
- **git not present** (fresh macOS without CLT): git features degrade; installer warns.
- **Playwright runtime download**: needs network on first browser-QA use; surfaced to user.
- **x86_64 macOS**: separate CI runner (`macos-13`); drop if not needed.

## Explicitly out of scope (v1)

- Windows installer (PowerShell `irm | iex`) — noted as fast-follow.
- Auto-update (`electron-updater`).
- Code signing / notarization.
- Docker/sandboxed backend.
- Installer-side API key handling.

## Sequencing

Phase 1 → 2 give a locally-packageable app you can test end-to-end (`electron:build`
+ manually running `build_bundle.sh`). Phases 3–4 make it downloadable. Phase 5 is docs.
Recommend landing 1–2 first and verifying a hand-built `.app` launches with a working
bundled backend before wiring CI and the installer.

## Files to be added / changed

- `backend/app/config.py` — data-dir env override (changed)
- `backend/scripts/build_bundle.sh` — freeze the backend (new)
- `frontend/electron/main.cjs` — spawn/supervise backend, splash, singleton (changed)
- `frontend/electron/preload.cjs` — expose `apiBase` (changed)
- `frontend/package.json` — `extraResources`, targets (changed)
- frontend API client — prefer `window.electron.apiBase` (changed)
- `.github/workflows/release.yml` — matrix build + publish (new)
- `scripts/install.sh` — the curl installer (new)
- `docs/ELECTRON.md`, `docs/INSTALL.md`, `README.md` — docs (changed/new)
