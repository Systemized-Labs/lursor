# Lursor Desktop (Electron)

The Vite + React frontend in `frontend/` doubles as a desktop app via Electron.
The Electron shell only wraps the UI — the FastAPI backend still runs separately
on `http://localhost:8000` (start it with `scripts/dev.sh` or the backend README).

## Layout

```
frontend/
  electron/
    main.cjs      Main process: creates the window, loads the dev server (dev)
                  or dist/index.html (prod), routes external links to the OS browser.
    preload.cjs   contextIsolation bridge: exposes window.electron = { isElectron, platform }.
```

Key wiring:
- `vite.config.ts` sets `base: "./"` so built assets resolve under `file://`.
- `src/main.tsx` uses `HashRouter` when `window.electron?.isElectron` is set
  (history routing doesn't work from `file://`), and `BrowserRouter` in the browser.
- `src/vite-env.d.ts` declares the `window.electron` type.

## Develop

```bash
cd frontend
bun install
bun run electron:dev     # starts Vite, waits for :5173, then launches Electron
```

Make sure the backend is running (`http://localhost:8000`).

## Package

```bash
cd frontend
bun run electron:build            # current platform
bun run electron:build:mac        # or :win / :linux
```

Artifacts land in `frontend/release/`. Config lives in the `build` block of
`frontend/package.json` (appId `com.lursor.app`). The backend is not bundled;
distributed builds still expect a reachable backend.
