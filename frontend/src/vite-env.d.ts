/// <reference types="vite/client" />

/** App version, inlined from package.json by Vite (see vite.config.ts). */
declare const __APP_VERSION__: string

/**
 * API surface exposed by the Electron preload bridge (electron/preload.cjs).
 * Undefined when the app runs in a plain browser.
 */
interface ElectronBridge {
  readonly isElectron: true
  readonly platform: "darwin" | "win32" | "linux" | string
  /**
   * Base URL of the backend API the desktop app is talking to — a local backend
   * on a port chosen at launch, or a saved remote connection. Null if not
   * supplied by the main process.
   */
  readonly apiBase: string | null
  /**
   * Bearer token for the active connection, or null when the backend needs none
   * (every local one). See `backend/app/auth.py`.
   */
  readonly authToken: string | null
  /** Display name of the active connection, shown in the shell chrome. */
  readonly connectionName: string | null
  /** True when the active connection is a remote backend rather than this machine. */
  readonly isRemote: boolean
  /** Open an http(s) URL in the system browser (main-process shell.openExternal). */
  readonly openExternal: (url: string) => Promise<void>
  /** Abandon the active connection and return to the picker. */
  readonly switchConnection: () => Promise<void>
  /**
   * Forward a port on the backend host to `127.0.0.1` on this machine, resolving
   * to the local port it landed on (the same number whenever it is free). Used by
   * the Preview panel to reach a remote dev server; resolves to `null` when the
   * connection is local and forwarding is unnecessary.
   */
  readonly forwardPort: (port: number) => Promise<number | null>
  /**
   * Begin a native drag of a workspace file, so it can be dropped into Finder or
   * another app as a real file — which an HTML5 drag cannot offer. The renderer
   * cancels its own drag and calls this; see `lib/file-drag-out.ts`.
   *
   * `absPath` is the file's path on the backend host. It is used directly on a
   * local connection; a remote one downloads the bytes to a temp copy first, which
   * is why this resolves rather than returning nothing.
   */
  readonly startFileDrag: (item: {
    workspaceId: string
    /** POSIX path relative to the workspace root. */
    path: string
    name: string
    isDir: boolean
    absPath: string
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  /**
   * The on-disk path of a dropped `File`, or null when it has none. Only the
   * preload can answer this (`webUtils.getPathForFile`); a browser never can, so
   * callers must treat "" as "unknown", not as "outside the workspace".
   */
  readonly filePath: (file: File) => string | null

  /** Subscribe to desktop update state. Returns its own unsubscribe function. */
  readonly onUpdateState: (
    callback: (state: DesktopUpdateState) => void
  ) => () => void
  /** The current state, for a renderer that mounted after the first check. */
  readonly getUpdateState: () => Promise<DesktopUpdateState>
  /** Re-check now, for the button in Settings. */
  readonly checkForUpdates: () => Promise<DesktopUpdateState>
  /** Restart into the new version, or hand off to Terminal on the script path. */
  readonly installUpdate: () => Promise<void>
  /** Keep the download but don't restart now — it installs on the next quit. */
  readonly deferUpdate: () => Promise<void>
}

/**
 * Update state pushed from the Electron main process (see `publishUpdateState` in
 * electron/main.cjs). This is the *client* update; a remote backend's version is a
 * separate stream over HTTP (see `src/api/update.ts`).
 */
interface DesktopUpdateState {
  /**
   * `unsupported` is a real, common answer: a `.deb` is owned by apt and a dev build
   * has no feed at all, and both need explaining rather than silence.
   */
  phase:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "error"
    | "unsupported"
  version: string | null
  percent: number | null
  error: string | null
  /**
   * `squirrel` downloads in the background and then needs a restart. `script` quits
   * the app and finishes in a Terminal window — so the two offer different actions,
   * and promising "Restart now" on the script path would be a lie.
   */
  mechanism: "squirrel" | "script" | "none"
  /** Human-readable detail for the `unsupported` and `script` cases. */
  note: string | null
}

interface Window {
  electron?: ElectronBridge
}
