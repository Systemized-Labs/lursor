// Preload script: the safe bridge between the renderer and Electron main.
//
// Runs with contextIsolation on, so anything the UI needs is exposed on a
// frozen `window.electron` object. Keep this surface intentionally small.
//
// Two bridges, because two documents load with this preload: the React app gets
// `window.electron`, and the connection picker (electron/connect.html) gets
// `window.lursorConnect`. Each ignores the other's.

const { contextBridge, ipcRenderer, webUtils } = require("electron")

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
  // Hand a workspace file to the OS as a real file drag, so it can be dropped into
  // Finder or another app. Only main can do this (webContents.startDrag), so the
  // renderer cancels its own HTML drag and calls this instead.
  startFileDrag: (item) => ipcRenderer.invoke("file:drag", item),
  // The on-disk path of a dropped File. Electron removed `File.path` in v32, and
  // webUtils is the sanctioned replacement — it has to be called here, in the
  // preload, because the renderer has no access to it. Lets a drop tell a file that
  // is *already in the workspace* from one arriving off the desktop.
  filePath: (file) => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },

  // --- Desktop updates ---
  // The offer lives in the React app rather than in a native dialog, so main has to
  // be able to push state in and take an answer back out.
  //
  // Returns its own unsubscribe function: without one, every HMR cycle in dev leaves
  // another listener attached and a single transition fires the toast N times.
  onUpdateState: (callback) => {
    const handler = (_event, state) => callback(state)
    ipcRenderer.on("update:state", handler)
    return () => ipcRenderer.off("update:state", handler)
  },
  // For a renderer that mounted after the first check resolved — the push alone
  // would have missed it.
  getUpdateState: () => ipcRenderer.invoke("update:get-state"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  // Restarts into the new version (or hands off to Terminal on the script path).
  installUpdate: () => ipcRenderer.invoke("update:install"),
  // Keep the download but don't restart now; it installs on the next quit.
  deferUpdate: () => ipcRenderer.invoke("update:later"),
})

contextBridge.exposeInMainWorld("lursorConnect", {
  list: () => ipcRenderer.invoke("connection:list"),
  save: (input) => ipcRenderer.invoke("connection:save", input),
  // Reachability + token check for form values that haven't been saved yet.
  test: (input) => ipcRenderer.invoke("connection:test", input),
  // Scheme/address verdict for a half-typed URL. No network.
  inspect: (url) => ipcRenderer.invoke("connection:inspect", url),
  remove: (id) => ipcRenderer.invoke("connection:remove", id),
  select: (id) => ipcRenderer.invoke("connection:select", id),
  // Why the last attempt failed, if it did — shown on the picker itself.
  lastError: ipcRenderer.sendSync("connection:last-error") ?? "",
})
