/**
 * Open a URL in the user's system browser.
 *
 * In Electron this hops to the main process (`shell.openExternal`) via the
 * preload bridge, so it never spawns an in-app window. In a plain browser there
 * is no bridge, so fall back to a new tab. Only http(s) URLs should be passed;
 * the main process re-validates the scheme before opening.
 */
export function openExternal(url: string): void {
  if (typeof window !== "undefined" && window.electron?.openExternal) {
    void window.electron.openExternal(url)
    return
  }
  window.open(url, "_blank", "noopener,noreferrer")
}
