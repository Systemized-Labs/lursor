/// <reference types="vite/client" />

/**
 * API surface exposed by the Electron preload bridge (electron/preload.cjs).
 * Undefined when the app runs in a plain browser.
 */
interface ElectronBridge {
  readonly isElectron: true
  readonly platform: "darwin" | "win32" | "linux" | string
}

interface Window {
  electron?: ElectronBridge
}
