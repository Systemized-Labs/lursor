// Preload script: the safe bridge between the renderer and Electron main.
//
// Runs with contextIsolation on, so anything the UI needs is exposed on a
// frozen `window.electron` object. Keep this surface intentionally small.

const { contextBridge, ipcRenderer } = require("electron")

// The main process starts the backend on a (possibly ephemeral) port and passes
// the resolved API base in via webPreferences.additionalArguments, e.g.
// "--lursor-api-base=http://127.0.0.1:8791/api". Parse it here so the renderer
// can read it synchronously at startup (the port isn't known at build time).
const apiBaseArg = process.argv.find((a) => a.startsWith("--lursor-api-base="))
const apiBase = apiBaseArg ? apiBaseArg.slice("--lursor-api-base=".length) : null

contextBridge.exposeInMainWorld("electron", {
  isElectron: true,
  platform: process.platform,
  // Base URL of the backend API this desktop instance is talking to.
  apiBase,
  // Open an http(s) URL in the system browser. The main process re-validates
  // the scheme before handing off to shell.openExternal.
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
})
