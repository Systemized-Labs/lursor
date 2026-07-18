// Preload script: the safe bridge between the renderer and Electron main.
//
// Runs with contextIsolation on, so anything the UI needs is exposed on a
// frozen `window.electron` object. Keep this surface intentionally small.

const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("electron", {
  isElectron: true,
  platform: process.platform,
  // Open an http(s) URL in the system browser. The main process re-validates
  // the scheme before handing off to shell.openExternal.
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
})
