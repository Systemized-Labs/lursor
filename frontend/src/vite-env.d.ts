/// <reference types="vite/client" />

/**
 * API surface exposed by the Electron preload bridge (electron/preload.cjs).
 * Undefined when the app runs in a plain browser.
 */
interface ElectronBridge {
  readonly isElectron: true
  readonly platform: "darwin" | "win32" | "linux" | string
  /**
   * Base URL of the backend API the desktop app is talking to (the backend
   * runs on a port chosen at launch). Null if not supplied by the main process.
   */
  readonly apiBase: string | null
  /** Open an http(s) URL in the system browser (main-process shell.openExternal). */
  readonly openExternal: (url: string) => Promise<void>
}

interface Window {
  electron?: ElectronBridge
}
