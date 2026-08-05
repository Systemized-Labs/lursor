# Lursor Desktop (Electron)

The Vite + React frontend in `frontend/` doubles as a desktop app via Electron.
In **packaged** builds the app owns its backend: it ships a frozen, self-contained
Python interpreter and starts/stops the FastAPI server itself. In **development**
it runs the backend from source via `uv` and loads the Vite dev server.

It can also run as a **thin client** against a backend on another machine, in which
case it spawns nothing. See [REMOTE.md](REMOTE.md) for the user-facing side.

## Connections

Everything below branches on which connection is active, so it is resolved first
(`electron/connections.cjs`):

- **Local** — the bundled backend, spawned on demand. Synthesized rather than stored,
  so a fresh install has no config file and boots straight into local mode without
  ever showing a picker.
- **Remote** — a saved `{ name, url, token }` in `~/.lursor/connections.json`, with
  the token encrypted via `safeStorage` (plaintext plus a logged warning where no
  keychain exists). `http://` is refused for non-loopback hosts: a bearer token over
  plain HTTP is a giveaway. Loopback is allowed so remote mode can be tested locally.

The picker (`electron/connect.html`) appears when a remote exists and the last-used
one can't be reached, or on demand from **Switch Connection…** in the app menu. It is
plain HTML with inline styles on purpose — it has to work before there is a backend
to talk to, which is the same reason the splash and error screens are `data:` URLs.

## Backend lifecycle (main process)

On launch (`electron/main.cjs`):

1. Create the window, showing the splash, and resolve the connection.
2. **Local**: pick a port (prefers `8791`, ephemeral if taken) and spawn the backend:
   - **Packaged**: `<Resources>/backend/python/bin/python -m uvicorn app.main:app`,
     with `LURSOR_DATA_DIR=~/.lursor` so all writable state stays out of the
     read-only app bundle.
   - **Dev**: `uv run uvicorn app.main:app` from `../../backend` (no data-dir
     override, so dev keeps its existing DB next to the backend).

   **Remote**: spawn nothing.
3. Poll `GET /api/health` (with the bearer token, if any) until ok, then load the
   renderer. A `401`/`403` is treated as final rather than retried — the token is
   wrong and waiting won't fix it — and sends you back to the picker with that
   said out loud. Local failures still show the backend-error screen.
4. The renderer reads the API base and token **synchronously** from the preload
   (`ipcRenderer.sendSync("connection:active")`), because `src/api/client.ts`
   resolves them at module scope. This replaced `webPreferences.additionalArguments`,
   which is fixed when the window is created — too early, now that the connection may
   not be chosen yet.
5. On a remote connection the main process also injects `Authorization` into requests
   to that origin via `webRequest.onBeforeSendHeaders`, covering `<img>`, `<video>`
   and download URLs that no JS layer can add a header to.
6. The backend is spawned in its own process group and killed on quit
   (`before-quit`/`will-quit`), along with any open port forwards. A single-instance
   lock prevents port clashes.

## Port forwarding

`electron/port-forward.cjs` reaches dev servers on a remote backend's loopback
interface: a local `net` listener on the *same* port number pipes each TCP connection
over a WebSocket to `/api/tunnel`. The renderer asks for one through
`window.electron.forwardPort(port)`; `src/lib/preview-reach.ts` decides when to.

Forwarding rather than HTTP-proxying because dev servers emit root-absolute asset
paths and their own HMR sockets — a path-prefixed proxy means rewriting HTML, CSS and
socket payloads per framework. Keeping the port number identical also keeps the
address the dev server printed the address that works.

## Layout

```
frontend/
  electron/
    main.cjs           Main process: connection bootstrap, backend lifecycle
                       (spawn/health/teardown), window, splash/error screens,
                       auth-header injection, menu, single-instance lock.
    connections.cjs    Saved connections: read/write, token encryption, URL rules.
    connect.html       The connection picker (plain HTML — runs before any backend).
    port-forward.cjs   Local TCP listeners piped to /api/tunnel on a remote backend.
    preload.cjs        contextIsolation bridges: window.electron (the app) and
                       window.lursorConnect (the picker).
```

Key wiring:
- `vite.config.ts` sets `base: "./"` so built assets resolve under `file://`.
- `src/main.tsx` uses `HashRouter` when `window.electron?.isElectron` is set
  (history routing doesn't work from `file://`), and `BrowserRouter` in the browser.
- `src/api/client.ts` prefers `window.electron.apiBase` when present, and is the one
  place the token is attached — to fetches via `authHeaders()` and to WebSockets via
  `connectWs()`, which carries it as a subprotocol because browsers can't set headers
  on a socket.
- `src/lib/preview-reach.ts` maps a canonical dev-server address to one reachable
  from here (origin host on a LAN device, forwarded port on a remote backend).
- `src/components/layout/connection-status.tsx` shows which machine you're driving,
  and renders nothing at all in local mode.
- `src/vite-env.d.ts` declares the `window.electron` type.

## Develop

```bash
cd frontend
bun install
bun run electron:dev     # starts Vite, waits for :8888, then launches Electron
```

Make sure the backend is running (`http://localhost:8791`).

## Package

Packaging freezes the backend into a self-contained bundle first, then builds the
Electron app with that bundle under its resources:

```bash
cd frontend
bun run bundle:backend            # freeze the backend -> ../backend/bundle (heavy, ~400 MB)
bun run electron:build            # current platform (runs bundle:backend for you)
bun run electron:build:mac        # or :linux  (each runs bundle:backend first)
```

- `backend/scripts/build_bundle.sh` produces the frozen backend: a relocatable
  standalone CPython (via `uv`) with the backend + all deps installed into it,
  then smoke-tests a real `uvicorn` boot + `/api/health`.
- electron-builder copies `backend/bundle` into the app's resources as `backend`
  (`extraResources` in `frontend/package.json`).
- Artifacts land in `frontend/release/`. Config lives in the `build` block of
  `frontend/package.json` (appId `com.lursor.app`).

The frozen backend is **architecture-specific**, so a single machine builds for
its own arch. CI (`.github/workflows/release.yml`) builds each arch on a matching
runner: macOS arm64 (`macos-15`) and Linux x64 (`ubuntu-latest`). Intel macOS is
not built (see [DISTRIBUTION.md](./DISTRIBUTION.md)).

## Signing and notarization (macOS)

Released macOS builds are signed with a Developer ID certificate and notarized.
Two pieces make that work with a bundled interpreter:

- `build/entitlements.mac.plist` — the hardened runtime forbids most of what this
  app does by default. JIT, unsigned executable memory, library validation, and
  network client/server are all required by Electron or CPython; each key in the
  file says which.
- `scripts/sign-backend-bundle.cjs` — an `afterPack` hook that discovers every
  Mach-O file under `Resources/backend` and codesigns it. Notarization requires
  *every* nested binary to be signed, but `@electron/osx-sign` only signs
  Electron's own binaries plus an explicit `mac.binaries` list — which would rot
  on every dependency bump, so we discover them instead. It runs at `afterPack`
  because signatures apply inside-out: the app's own signature seals the contents
  of `Resources/`.

Local builds without a certificate still work — the hook logs that it found no
identity and leaves the bundle unsigned.

Auto-update is wired in `main.cjs` and covers the Linux AppImage and signed macOS
builds via `electron-updater`. Unsigned macOS builds — which Squirrel.Mac refuses
to update — fall back to `scripts/update.sh`, run from Terminal after the app
quits. See [DISTRIBUTION.md](./DISTRIBUTION.md) for that fallback, the release
runbook, the CI secrets, and the Homebrew tap.

Windows remains unbuilt.
