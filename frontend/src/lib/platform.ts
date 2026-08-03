/**
 * Platform helpers for the Electron desktop shell.
 *
 * `window.electron` is injected by electron/preload.cjs and is undefined in a
 * plain browser, so these are safe to read at render time.
 */

/** True when running inside the desktop shell rather than a plain browser. */
export const isElectron =
  typeof window !== "undefined" && window.electron?.isElectron === true

/** True when running inside Electron on macOS (frameless traffic-light chrome). */
export const isMacElectron =
  isElectron && window.electron?.platform === "darwin"
