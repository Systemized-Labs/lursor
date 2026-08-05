// Preload script: the safe bridge between the renderer and Electron main.
//
// Runs with contextIsolation on, so anything the UI needs is exposed on a
// frozen `window.electron` object. Keep this surface intentionally small.
//
// Two bridges, because two documents load with this preload: the React app gets
// `window.electron`, and the connection picker (electron/connect.html) gets
// `window.lursorConnect`. Each ignores the other's.

const { contextBridge, ipcRenderer } = require("electron")

// The active connection is read *synchronously*, because `api/client.ts` resolves
// `API_BASE` and `AUTH_TOKEN` at module scope — the first request can be in flight
// before an async handshake would have resolved. This replaces the older
// `--lursor-api-base=` launch argument, which couldn't work once the connection
// stopped being known before the window was created.
const connection = ipcRenderer.sendSync("connection:active") ?? {}

contextBridge.exposeInMainWorld("electron", {
  isElectron: true,
  platform: process.platform,
  // Base URL of the backend API this desktop instance is talking to.
  apiBase: connection.apiBase ?? null,
  // Bearer token for that backend, or null when it needs none (any local one).
  authToken: connection.token ?? null,
  connectionName: connection.name ?? null,
  isRemote: connection.kind === "remote",
  // Open an http(s) URL in the system browser. The main process re-validates
  // the scheme before handing off to shell.openExternal.
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  // Drop this connection and go back to the picker.
  switchConnection: () => ipcRenderer.invoke("connection:switch"),
  // Forward a port on the backend host to 127.0.0.1 here, resolving to the local
  // port it landed on. Null in local mode, where the port is already local.
  forwardPort: (port) => ipcRenderer.invoke("forward:open", port),
})

contextBridge.exposeInMainWorld("lursorConnect", {
  list: () => ipcRenderer.invoke("connection:list"),
  save: (input) => ipcRenderer.invoke("connection:save", input),
  remove: (id) => ipcRenderer.invoke("connection:remove", id),
  select: (id) => ipcRenderer.invoke("connection:select", id),
  // Why the last attempt failed, if it did — shown on the picker itself.
  lastError: ipcRenderer.sendSync("connection:last-error") ?? "",
})
