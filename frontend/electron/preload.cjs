// Preload script: the safe bridge between the renderer and Electron main.
//
// Runs with contextIsolation on, so anything the UI needs is exposed on a
// frozen `window.electron` object. Keep this surface intentionally small.

const { contextBridge } = require("electron")

contextBridge.exposeInMainWorld("electron", {
  isElectron: true,
  platform: process.platform,
})
