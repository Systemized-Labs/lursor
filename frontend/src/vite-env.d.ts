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
}

interface Window {
  electron?: ElectronBridge
}
