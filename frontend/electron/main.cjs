// Electron main process for the Lursor desktop app.
//
// By default the desktop app owns its backend: on launch it starts the bundled
// FastAPI server (a frozen, self-contained Python interpreter shipped under the
// app's resources), waits for it to become healthy, then loads the renderer. In
// development it instead runs the backend from source via `uv` and loads the
// Vite dev server. See docs/ELECTRON.md.
//
// It can also be a thin client. A saved *remote* connection points it at a backend
// on another machine — typically a VPS over https with a bearer token — and then
// nothing is spawned locally: agents run there and keep running with this machine
// asleep. Switching to one does not stop a local backend that is already up — its
// agents, dev servers and PTYs keep running, and switching back reattaches to the
// same process. See electron/connections.cjs and docs/REMOTE.md.
//
// The connection is therefore resolved before anything else happens, and everything
// downstream (health check, API base, port forwarding, teardown) branches on it.

const path = require("node:path")
const os = require("node:os")
const fs = require("node:fs")
const http = require("node:http")
const https = require("node:https")
const net = require("node:net")
const { spawn, execFile } = require("node:child_process")
const {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  session,
  shell,
  ipcMain,
  dialog,
} = require("electron")

const connections = require("./connections.cjs")
const portForward = require("./port-forward.cjs")

const isDev = !app.isPackaged
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:8888"
// DevTools only auto-open when explicitly asked for (./scripts/dev.sh --electron --debug).
const OPEN_DEVTOOLS = process.env.LURSOR_DEVTOOLS === "1"
const PREFERRED_PORT = 8791
// First boot imports a large dependency tree and runs DB init/seed, so give the
// backend generous headroom before declaring it unhealthy.
const HEALTH_TIMEOUT_MS = 90_000

// The product name — drives the macOS menu bar, About panel, and dock tooltip.
app.setName("Lursor")

const APP_ICON = nativeImage.createFromPath(
  path.join(__dirname, "..", "build", "icon.png")
)

/** @type {BrowserWindow | null} */
let mainWindow = null
/** @type {import("node:child_process").ChildProcess | null} */
let backendProc = null
/**
 * The port {@link backendProc} was started on. Kept alongside the process because a
 * local backend outlives a switch to a remote one, and switching back has to reattach
 * to the port it is already listening on rather than pick a new one.
 * @type {number | null}
 */
let backendPort = null
/** Guards teardown so we only kill the backend once. */
let backendKilled = false
/**
 * The connection the renderer is talking to, once resolved: the saved
 * {@link connections.Connection} plus the API base it produced. Read synchronously
 * by the preload, so it must be set before the app document loads.
 * @type {{ id: string, name: string, kind: string, apiBase: string, token: string } | null}
 */
let activeConnection = null
/** Why the last connection attempt failed, surfaced on the picker. */
let lastConnectionError = ""
/**
 * Whether the load-failure screen is currently up. Latched so the error screen's own
 * navigation cannot re-enter the handler that showed it, and cleared on the next load
 * that does succeed.
 */
let loadFailureShown = false

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------

/**
 * Resolve a usable TCP port, preferring {@link PREFERRED_PORT}. Falls back to an
 * OS-assigned ephemeral port if the preferred one is taken (e.g. a second
 * instance, or a dev server already bound to it).
 * @returns {Promise<number>}
 */
function findFreePort(preferred) {
  const tryListen = (port) =>
    new Promise((resolve) => {
      const srv = net.createServer()
      srv.once("error", () => resolve(null))
      srv.listen({ port, host: "127.0.0.1" }, () => {
        const chosen = srv.address().port
        srv.close(() => resolve(chosen))
      })
    })

  return tryListen(preferred).then((p) => p ?? tryListen(0))
}

/**
 * Build the command that launches the backend.
 *  - Packaged: the frozen interpreter under resources/backend.
 *  - Dev: `uv run uvicorn ...` from the repo's backend/ directory.
 * @returns {{ command: string, args: string[], cwd: string, dataDir: string | null }}
 */
function resolveBackendCommand(port) {
  // Arguments to uvicorn itself, shared by both modes; each prepends its own way
  // of reaching the uvicorn entrypoint.
  const appArgs = ["app.main:app", "--host", "127.0.0.1", "--port", String(port)]

  if (!isDev) {
    const bundleDir = path.join(process.resourcesPath, "backend")
    const binDir = path.join(bundleDir, "python", "bin")
    const candidates =
      process.platform === "win32"
        ? [path.join(bundleDir, "python", "python.exe")]
        : [path.join(binDir, "python3"), path.join(binDir, "python")]
    const python = candidates.find((p) => fs.existsSync(p)) ?? candidates[0]
    return {
      command: python,
      args: ["-m", "uvicorn", ...appArgs],
      cwd: bundleDir,
      // Packaged app bundle is read-only: keep all writable state in ~/.lursor.
      dataDir: path.join(os.homedir(), ".lursor"),
    }
  }

  // Dev: run from source. No LURSOR_DATA_DIR override, so the backend keeps its
  // existing dev defaults (DB next to the backend, data under ~/.lursor).
  const backendDir = path.join(__dirname, "..", "..", "backend")
  return {
    command: "uv",
    args: ["run", "uvicorn", ...appArgs],
    cwd: backendDir,
    dataDir: null,
  }
}

function startBackend(port) {
  const { command, args, cwd, dataDir } = resolveBackendCommand(port)
  const env = { ...process.env, PYTHONUNBUFFERED: "1" }
  if (dataDir) env.LURSOR_DATA_DIR = dataDir
  // Tell the backend who owns its lifecycle, so it can refuse to self-update: we
  // would respawn the old code on the next launch, and in a packaged build its own
  // files live inside a read-only app bundle. Declared rather than left to the
  // backend to infer, because a dev run is an ordinary git checkout and no amount of
  // path-sniffing distinguishes it from a server install. See backend/app/updater.py.
  env.LURSOR_MANAGED_BY = "desktop"

  console.log(`[backend] starting: ${command} ${args.join(" ")} (cwd=${cwd})`)

  // detached: own process group, so we can signal uv + its python child as one.
  const proc = spawn(command, args, { cwd, env, detached: true })

  proc.stdout?.on("data", (d) => process.stdout.write(`[backend] ${d}`))
  proc.stderr?.on("data", (d) => process.stderr.write(`[backend] ${d}`))
  proc.on("error", (err) => {
    console.error("[backend] failed to spawn:", err)
  })
  proc.on("exit", (code, signal) => {
    console.log(`[backend] exited (code=${code}, signal=${signal})`)
    if (backendProc === proc) {
      backendProc = null
      backendPort = null
    }
  })

  backendProc = proc
  backendPort = port
  // Re-arm the teardown guard: a previous local backend may have been killed and
  // replaced, and this new process still has to be killable.
  backendKilled = false
  return proc
}

function killBackend() {
  if (backendKilled || !backendProc || backendProc.pid == null) return
  backendKilled = true
  const pid = backendProc.pid
  try {
    // Negative pid signals the whole process group (kills uv's python child too).
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      backendProc.kill("SIGTERM")
    } catch {
      /* already gone */
    }
  }
}

/**
 * GET one route on a backend, as the app would.
 *
 * Resolves to the HTTP status — 0 when the request never got an answer at all —
 * and the parsed JSON body when there was one. The status distinction is the whole
 * point of the health path: 200 is healthy, 401 means the token is wrong and
 * waiting will never help, and 0 means try again.
 *
 * `body` is capped because this runs against an address the user typed: a
 * misdirected connection can land on something that streams forever, and a probe
 * must not be the thing that eats the main process's memory.
 *
 * @returns {Promise<{ status: number, body: unknown }>}
 */
function probe(apiBase, token, route, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let url
    try {
      url = new URL(`${apiBase.replace(/\/$/, "")}${route}`)
    } catch {
      return resolve({ status: 0, body: null })
    }
    const transport = url.protocol === "https:" ? https : http
    const req = transport.get(
      url,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => {
        const status = res.statusCode ?? 0
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => {
          if (text.length > 64_000) return
          text += chunk
        })
        res.on("end", () => {
          let body = null
          try {
            body = JSON.parse(text)
          } catch {
            /* Not JSON: the status alone is the answer. */
          }
          resolve({ status, body })
        })
        res.on("error", () => resolve({ status, body: null }))
      }
    )
    req.on("error", () => resolve({ status: 0, body: null }))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve({ status: 0, body: null })
    })
  })
}

/**
 * Ping a backend's health endpoint once, for callers that only need the status.
 *
 * @returns {Promise<number>}
 */
async function pingHealth(apiBase, token, timeoutMs = 5000) {
  return (await probe(apiBase, token, "/health", timeoutMs)).status
}

/**
 * Poll a backend's health endpoint until it answers or we give up.
 *
 * `watchProcess` is for the local backend only: if the process we spawned has died
 * there is nothing left to wait for, so failing immediately beats burning the whole
 * timeout. A remote backend must never be given it — `backendProc` says nothing about
 * a machine on the other end of the network, and is null on a client that has never
 * started one.
 *
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
function waitForHealth(apiBase, token, timeoutMs, watchProcess) {
  const deadline = Date.now() + timeoutMs

  return new Promise((resolve) => {
    const attempt = async () => {
      const status = await pingHealth(apiBase, token)
      if (status === 200) return resolve({ ok: true, status })
      // A rejected credential is a permanent answer; retrying just delays telling
      // the user the one thing they can act on.
      if (status === 401 || status === 403) return resolve({ ok: false, status })
      if (watchProcess && !backendProc) return resolve({ ok: false, status })
      if (Date.now() >= deadline) return resolve({ ok: false, status })
      setTimeout(attempt, 500)
    }
    attempt()
  })
}

// ---------------------------------------------------------------------------
// Splash / error screens (system chrome, not the React app)
// ---------------------------------------------------------------------------

function screenHtml(title, subtitle, spinner) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html><html><head><meta charset="utf-8" />
    <style>
      html,body{height:100%;margin:0}
      body{background:#000;color:#e5e5e5;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
      .t{font-size:16px;font-weight:600}
      .s{color:#9a9a9a;max-width:32rem;text-align:center;line-height:1.5;padding:0 24px}
      .spin{width:22px;height:22px;border:2px solid #333;border-top-color:#e5e5e5;border-radius:50%;
        animation:r .8s linear infinite}
      @keyframes r{to{transform:rotate(360deg)}}
    </style></head><body>
      ${spinner ? '<div class="spin"></div>' : ""}
      <div class="t">${title}</div>
      <div class="s">${subtitle}</div>
    </body></html>`)}`
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#000000",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Centre the macOS traffic lights in the sidebar's 44px chrome strip (the
    // `h-11` band in AppSidebar): the current controls are ~15px tall, so a 15px
    // top inset leaves ~14px below them and puts their centre on the strip's,
    // level with the panel heading rendered beside them.
    trafficLightPosition:
      process.platform === "darwin" ? { x: 14, y: 15 } : undefined,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // No `additionalArguments` for the API base any more: the connection isn't
      // known when the window is created (the picker may not have run yet), and a
      // launch argument is fixed for the window's lifetime. The preload reads it
      // synchronously over IPC instead, which also survives a connection switch.
    },
  })

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show()
  })

  mainWindow.loadURL(
    screenHtml("Starting Lursor", "Bringing up the backend…", true)
  )

  // Open external links (target=_blank / window.open) in the system browser
  // instead of a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url)
      return { action: "deny" }
    }
    return { action: "allow" }
  })

  // Replay the update state into every document this window loads. Without this an
  // update found before the renderer mounted — or before a reload — is announced to
  // nobody, and since `autoInstallOnAppQuit` stays false it would simply never be
  // offered. The splash and picker documents ignore it.
  mainWindow.webContents.on("did-finish-load", () => {
    loadFailureShown = false
    if (updateState.phase !== "idle" && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update:state", updateState)
    }
  })

  // A failed navigation leaves the *previous* document up rather than blanking the
  // window. During startup that document is the splash, so anything that breaks the
  // handoff in `loadApp` leaves it spinning "Bringing up the backend…" forever —
  // describing a backend that is already healthy, and giving the user nothing to act
  // on. Say what actually failed instead.
  //
  // Two things are deliberately not treated as failures. ERR_ABORTED (-3) is reported
  // by any navigation that supersedes one still in flight, which is exactly what the
  // splash-to-app handoff does. And subframe loads are the page's business, not the
  // window's — a dead iframe must not replace a working app with an error screen.
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || loadFailureShown) return
      console.error(
        `[window] load failed (${errorCode} ${errorDescription}): ${validatedURL}`
      )
      // Latched so the error screen's own load can't feed back into this handler.
      loadFailureShown = true
      showLoadError(`The window could not load (${errorDescription}).`)
    }
  )

  // A dead renderer has the same consequence as a failed load — the window keeps
  // showing whatever happened to be there — so it gets the same treatment. A clean
  // exit is just a process being recycled around a navigation, not a crash.
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (details?.reason === "clean-exit" || loadFailureShown) return
    console.error("[window] renderer gone:", details?.reason)
    loadFailureShown = true
    showLoadError(`The interface process stopped unexpectedly (${details?.reason}).`)
  })

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

function loadApp() {
  if (!mainWindow) return
  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL)
    if (OPEN_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: "detach" })
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"))
  }
}

/** Show the connection picker, optionally explaining what just went wrong. */
function loadPicker(reason = "") {
  lastConnectionError = reason
  if (!mainWindow) return
  mainWindow.loadFile(path.join(__dirname, "connect.html"))
}

function showBackendError() {
  if (!mainWindow) return
  mainWindow.loadURL(
    screenHtml(
      "Backend failed to start",
      "Lursor could not start its backend. Please quit and reopen the app; if the problem persists, check Console for [backend] logs.",
      false
    )
  )
}

/**
 * Report a navigation that never landed.
 *
 * Distinct from {@link showBackendError}: there the backend is the suspect and we
 * never got as far as the interface. Here the backend answered and it is the
 * renderer — or the bundle it was asked to load — that failed.
 */
function showLoadError(reason) {
  if (!mainWindow) return
  mainWindow.loadURL(
    screenHtml(
      "Lursor could not load its interface",
      `${reason} The backend is running; it is the window that failed. Quit and reopen the app — if that doesn't clear it, reinstall with the command in docs/INSTALL.md.`,
      false
    )
  )
}

// Renderer-invoked "open in system browser" (context menu on chat links). Guard
// the scheme here too — never hand arbitrary URIs to the OS.
ipcMain.handle("open-external", (_event, url) => {
  if (
    typeof url === "string" &&
    (url.startsWith("http://") || url.startsWith("https://"))
  ) {
    return shell.openExternal(url)
  }
})

// ---------------------------------------------------------------------------
// Dragging files out
// ---------------------------------------------------------------------------
//
// A file dragged out of the explorer has to leave the window as a *real file* —
// Finder, Slack and every editor want a path on this machine, and an HTML5 drag
// can only offer text. `webContents.startDrag` is the only thing that can promise
// a file to the OS, and it lives in main, so the renderer cancels its own drag
// (see lib/file-drag-out.ts) and hands the item over here.
//
// Local connection: the workspace is on this disk, so the path the tree already
// computes for "Copy path" is the file. Remote: it isn't here at all, so the bytes
// are staged into a temp copy first and the drag carries that.

/** Temp dir holding staged copies of remote files; removed on quit. */
let dragStagingDir = null

/**
 * Cap on a remote file staged for a drag.
 *
 * A drag has to become a file while the mouse is still down, so this is bounded by
 * patience rather than by disk: past a certain size the gesture is over before the
 * download is, and a silent no-op is a worse answer than "too big to drag".
 */
const DRAG_STAGE_MAX_BYTES = 64 * 1024 * 1024

/** Where staged copies go, created on first use. */
function stagingDir() {
  if (!dragStagingDir) {
    dragStagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "lursor-drag-"))
  }
  return dragStagingDir
}

/**
 * Download one workspace file from the active backend into a temp copy.
 *
 * Each drag gets its own subdirectory, so two files with the same name from
 * different folders don't overwrite each other, and the name the OS shows on the
 * dropped file is the real one.
 *
 * @returns {Promise<{ file: string } | { error: string }>}
 */
function stageRemoteFile(workspaceId, relPath, name) {
  const connection = activeConnection
  if (!connection) return Promise.resolve({ error: "Not connected to a backend." })

  let url
  try {
    url = new URL(
      `${connection.apiBase.replace(/\/$/, "")}/workspaces/${encodeURIComponent(
        workspaceId
      )}/files/raw?path=${encodeURIComponent(relPath)}`
    )
  } catch {
    return Promise.resolve({ error: "Couldn’t resolve the file’s address." })
  }

  // basename, always: the name is only ever a leaf here, and a "../" in it would
  // otherwise write outside the staging dir.
  const dir = fs.mkdtempSync(path.join(stagingDir(), "item-"))
  const file = path.join(dir, path.basename(name) || "file")

  return new Promise((resolve) => {
    const transport = url.protocol === "https:" ? https : http
    const req = transport.get(
      url,
      {
        headers: connection.token
          ? { Authorization: `Bearer ${connection.token}` }
          : {},
      },
      (res) => {
        if ((res.statusCode ?? 0) !== 200) {
          res.resume()
          resolve({ error: `The backend answered with HTTP ${res.statusCode ?? 0}.` })
          return
        }
        const out = fs.createWriteStream(file)
        let written = 0
        res.on("data", (chunk) => {
          written += chunk.length
          if (written > DRAG_STAGE_MAX_BYTES) {
            req.destroy()
            out.destroy()
            resolve({
              error: "That file is too large to drag from a remote workspace.",
            })
          }
        })
        res.pipe(out)
        out.on("finish", () => resolve({ file }))
        out.on("error", () => resolve({ error: "Couldn’t write a local copy." }))
      }
    )
    req.on("error", () => resolve({ error: "Couldn’t reach the backend." }))
    // Generous, because the drag is already lost if it takes this long — the timeout
    // exists to release the request, not to bound the gesture.
    req.setTimeout(30_000, () => {
      req.destroy()
      resolve({ error: "The download timed out." })
    })
  })
}

/**
 * The icon the cursor carries during the drag.
 *
 * The real file icon is what the OS would show, so ask for that first; `startDrag`
 * rejects an empty image, so fall back to the app icon and let the caller report
 * the throw if even that is missing.
 */
async function dragIcon(filePath) {
  try {
    const icon = await app.getFileIcon(filePath, { size: "normal" })
    if (icon && !icon.isEmpty()) return icon
  } catch {
    /* No icon for this path — the app's own will do. */
  }
  if (APP_ICON.isEmpty()) return APP_ICON
  return APP_ICON.resize({ width: 64, height: 64 })
}

/**
 * Start a native drag of a workspace file or folder.
 *
 * `absPath` is trusted only on a local connection: with a remote backend it is a
 * path on *that* machine, and a machine with the same checkout at the same place
 * would otherwise hand the drop target a different file with the right name.
 *
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
ipcMain.handle("file:drag", async (event, request) => {
  const name = path.basename(String(request?.name ?? ""))
  const relPath = String(request?.path ?? "")
  const absPath = String(request?.absPath ?? "")
  const workspaceId = String(request?.workspaceId ?? "")
  const isDir = Boolean(request?.isDir)
  if (!name) return { ok: false, error: "Nothing to drag." }

  let file = ""
  if (activeConnection?.kind === "remote") {
    if (isDir) {
      return {
        ok: false,
        error: "Folders on a remote backend can’t be dragged out — only files.",
      }
    }
    if (!workspaceId || !relPath) return { ok: false, error: "Nothing to drag." }
    const staged = await stageRemoteFile(workspaceId, relPath, name)
    if ("error" in staged) return { ok: false, error: staged.error }
    file = staged.file
  } else {
    // No path means the tree hasn't resolved the workspace root yet, which is a
    // different answer from a path that isn't there — and it fixes itself.
    if (!absPath) {
      return { ok: false, error: "Still resolving the workspace path — try again." }
    }
    if (!fs.existsSync(absPath)) {
      return { ok: false, error: `Couldn’t find ${name} on disk.` }
    }
    file = absPath
  }

  try {
    event.sender.startDrag({ files: [file], icon: await dragIcon(file) })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || "The drag couldn’t be started." }
  }
})

/** Drop the staged copies. Best-effort: a leftover temp dir is not worth a crash. */
function clearDragStaging() {
  if (!dragStagingDir) return
  try {
    fs.rmSync(dragStagingDir, { recursive: true, force: true })
  } catch {
    /* The OS will reap it. */
  }
  dragStagingDir = null
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/**
 * Attach the bearer token to requests the *browser* makes on our behalf.
 *
 * `api/client.ts` can set the header on anything it fetches itself, but a
 * subresource load can't be intercepted from JS: `<img src>` for chat attachments
 * and generated images, `<video src>` for generated video, and download links all
 * go straight out through Chromium. Signing every one of those URLs server-side
 * would mean a second auth mechanism; one hook here covers all of them, plus
 * anything added later.
 *
 * Scoped to the active connection's origin so the token never leaks to anywhere
 * else the renderer might load from.
 */
function installAuthHeaderInjection(apiBase, token) {
  const filter = { urls: ["<all_urls>"] }
  let origin
  try {
    origin = new URL(apiBase).origin
  } catch {
    return
  }

  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    let sameOrigin = false
    try {
      sameOrigin = new URL(details.url).origin === origin
    } catch {
      sameOrigin = false
    }
    if (sameOrigin && token) {
      callback({
        requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${token}` },
      })
      return
    }
    callback({ requestHeaders: details.requestHeaders })
  })
}

/** Forget any header injection from a previous connection. */
function clearAuthHeaderInjection() {
  session.defaultSession.webRequest.onBeforeSendHeaders(null)
}

/**
 * Spawn a local backend on a free port, point {@link activeConnection} at it, and
 * wait for it to answer.
 *
 * @returns {Promise<boolean>} whether it came up.
 */
async function startLocalBackend(connection) {
  const port = await findFreePort(PREFERRED_PORT)
  const apiBase = `http://127.0.0.1:${port}/api`
  activeConnection = { ...connection, apiBase, token: "" }

  mainWindow?.loadURL(screenHtml("Starting Lursor", "Bringing up the backend…", true))
  startBackend(port)

  const { ok } = await waitForHealth(apiBase, "", HEALTH_TIMEOUT_MS, true)
  return ok
}

/**
 * Bring up a connection and load the app on it.
 *
 * Local: reattach to the backend we already own, or spawn one. Remote: spawn nothing
 * and check we can reach it. Either way the app only loads once the backend answers,
 * so the renderer never races a backend that isn't up.
 */
async function connectTo(connection) {
  clearAuthHeaderInjection()
  portForward.configure(null)

  if (connection.kind === "local") {
    // A local backend we started is still running: switching away doesn't stop it, so
    // reattach instead of spawning a second one. Two backends would land on two ports
    // against one SQLite database, and the agents and dev servers left running on the
    // first would be invisible from the second.
    let ok
    if (backendProc && backendPort != null) {
      const apiBase = `http://127.0.0.1:${backendPort}/api`
      activeConnection = { ...connection, apiBase, token: "" }
      mainWindow?.loadURL(
        screenHtml("Connecting to Lursor", `Reattaching to ${connection.name}…`, true)
      )
      ok = (await waitForHealth(apiBase, "", HEALTH_TIMEOUT_MS, true)).ok
      if (!ok) {
        // It died or wedged while we were away. Replace it rather than leaving the
        // user on an error screen for a process they can neither see nor restart.
        console.log("[backend] reattach failed; starting a fresh local backend")
        killBackend()
        ok = await startLocalBackend(connection)
      }
    } else {
      ok = await startLocalBackend(connection)
    }

    if (!ok) {
      showBackendError()
      return
    }
    connections.setLastUsed(connection.id)
    loadApp()
    return
  }

  const apiBase = connections.apiBaseFor(connection.url)
  activeConnection = { ...connection, apiBase }

  mainWindow?.loadURL(
    screenHtml("Connecting to Lursor", `Reaching ${connection.name}…`, true)
  )

  // Shorter than the local timeout on purpose: the local one is sized for a cold
  // first boot importing a large dependency tree, while a remote backend is already
  // running or it isn't. Waiting 90s to say "unreachable" is just a worse error.
  const { ok, status } = await waitForHealth(apiBase, connection.token, 20_000, false)
  if (!ok) {
    loadPicker(
      status === 401 || status === 403
        ? `${connection.name} rejected the token. Check it matches the LURSOR_AUTH_TOKEN the backend was started with.`
        : `Could not reach ${connection.name} at ${connection.url}. Check the backend is running and the address is right.`
    )
    return
  }

  installAuthHeaderInjection(apiBase, connection.token)
  portForward.configure({ apiBase, token: connection.token })
  connections.setLastUsed(connection.id)
  loadApp()
}

/**
 * Decide what to connect to at launch.
 *
 * The picker only appears when there is something to choose between — a remote has
 * been added — or when the last-used connection is a remote we can't reach. A user
 * who never adds one sees the same launch they always have: splash, backend, app.
 */
async function bootConnection() {
  if (process.argv.includes("--lursor-pick-connection") && connections.hasRemotes()) {
    loadPicker()
    return
  }
  await connectTo(connections.lastUsed())
}

/**
 * Detach from the current connection, without quitting.
 *
 * Deliberately does *not* stop a local backend. Switching connections is a change of
 * view, not a shutdown: killing it would end every agent run, dev server and terminal
 * on this machine just because you looked at another one — and the reason to run a
 * backend elsewhere is precisely that work should survive you looking away. It is
 * stopped on quit ({@link teardown}), and reattached to by {@link connectTo}.
 */
function releaseConnection() {
  portForward.closeAll()
  clearAuthHeaderInjection()
  activeConnection = null
}

// Read synchronously by the preload before the document runs, because
// `api/client.ts` resolves its API base and token at module scope.
ipcMain.on("connection:active", (event) => {
  event.returnValue = activeConnection
})

ipcMain.on("connection:last-error", (event) => {
  event.returnValue = lastConnectionError
  // One-shot: a message about a failed attempt shouldn't reappear the next time the
  // picker opens for an unrelated reason.
  lastConnectionError = ""
})

ipcMain.handle("connection:list", () => connections.list())
ipcMain.handle("connection:save", (_event, input) => connections.save(input ?? {}))
ipcMain.handle("connection:remove", (_event, id) => connections.remove(id))

/**
 * What the scheme rule makes of an address, without touching the network.
 *
 * Cheap enough to call on every keystroke, and it keeps the picker from carrying a
 * second copy of the private-address logic that would drift from the real one.
 *
 * @returns {{ url: string, insecure: boolean } | { error: string }}
 */
ipcMain.handle("connection:inspect", (_event, url) => connections.normalizeRemoteUrl(url))

/**
 * Try an address and token *without* committing to them.
 *
 * The picker's alternative was save-and-connect: a typo cost a failed connection,
 * a bounce back to the picker, and a saved entry that doesn't work. This answers the
 * same question in place, and reports the backend's version while it's there —
 * remote is the one configuration where the two halves can drift, and finding that
 * out before connecting beats finding out from a broken screen.
 *
 * One shot, no polling: unlike a connect, nothing here is waiting for a backend to
 * finish booting, and a test that hangs for 20s is a worse answer than "no".
 *
 * @returns {Promise<{ ok: true, url: string, version?: string } | { error: string }>}
 */
ipcMain.handle("connection:test", async (_event, input) => {
  const normalized = connections.normalizeRemoteUrl(input?.url)
  if ("error" in normalized) return normalized

  const token = String(input?.token ?? "").trim()
  if (!token) {
    return {
      error:
        "A remote backend needs its token (the LURSOR_AUTH_TOKEN it was started with).",
    }
  }

  const apiBase = connections.apiBaseFor(normalized.url)
  const { status, body } = await probe(apiBase, token, "/health", 8000)

  if (status === 0) {
    // An address typed without a scheme is promoted to https, which is the right
    // guess right up until the box is a LAN machine with no certificate — and then
    // the failure looks like "unreachable" rather than "wrong scheme". Since http is
    // allowed here, say so instead of leaving them to guess.
    const suggestHttp =
      normalized.url.startsWith("https://") &&
      connections.isPrivateHost(new URL(normalized.url).hostname)
    return {
      error:
        `No answer from ${normalized.url}. Check the backend is running and the address is right.` +
        (suggestHttp
          ? ` If it has no TLS in front of it, try ${normalized.url.replace("https://", "http://")} — plain http is allowed to a private address.`
          : ""),
    }
  }
  if (status === 401 || status === 403) {
    return {
      error:
        "Reached the backend, but it rejected the token. Check it matches the " +
        "LURSOR_AUTH_TOKEN it was started with.",
    }
  }
  if (status !== 200) {
    return {
      error: `${normalized.url} answered with HTTP ${status}. That is something other than a Lursor backend — check the address and any reverse proxy in front of it.`,
    }
  }
  // Something is there and it let us in, but a login page or a different service
  // can do that too. The shape of the body is what makes it *ours*.
  if (!body || typeof body !== "object" || body.status !== "ok") {
    return {
      error: `${normalized.url} answered, but not like a Lursor backend. Check the address points at the backend rather than something in front of it.`,
    }
  }

  // Best-effort: a backend too old to have /api/server-info is still a backend you
  // can connect to, so a miss here reports success without a version rather than
  // failing the test.
  const info = await probe(apiBase, token, "/server-info", 5000)
  const version =
    info.status === 200 && info.body && typeof info.body.version === "string"
      ? info.body.version
      : undefined

  return { ok: true, url: normalized.url, insecure: normalized.insecure, version }
})

ipcMain.handle("connection:select", async (_event, id) => {
  const connection = connections.get(id)
  if (!connection) {
    loadPicker("That connection no longer exists.")
    return
  }
  releaseConnection()
  await connectTo(connection)
})

ipcMain.handle("connection:switch", async () => {
  releaseConnection()
  loadPicker()
})

ipcMain.handle("forward:open", async (_event, port) => portForward.forward(port))

// --- Update bridge ---------------------------------------------------------
//
// The offer used to be a native dialog here; it is the renderer's now, so these are
// the three things it needs: the current state (for a window that mounted late or
// reloaded), a way to re-check on demand, and a way to say "do it".

ipcMain.handle("update:get-state", () => updateState)

ipcMain.handle("update:check", () => {
  if (squirrel) squirrel.checkForUpdates()
  else if (updateState.mechanism === "script") checkForScriptUpdate()
  return updateState
})

ipcMain.handle("update:install", () => {
  if (updateState.mechanism === "script") {
    if (updateState.version) runScriptUpdate(updateState.version)
    return
  }
  // quitAndInstall triggers before-quit, so killBackend still runs.
  if (squirrel && updateState.phase === "downloaded") squirrel.quitAndInstall()
})

ipcMain.handle("update:later", () => {
  // Matches what the old dialog's "Later" did: don't interrupt now, but don't throw
  // the download away either — install it on the next quit.
  if (squirrel && updateState.phase === "downloaded") {
    squirrel.autoInstallOnAppQuit = true
  }
})

/**
 * Application menu, for the one item that has to live outside the React app:
 * switching connections is only reachable when the app can't load.
 *
 * Built from the default template rather than replacing it, so the standard
 * Edit/View/Window menus (and the macOS app menu) all survive.
 */
function installMenu() {
  const switchItem = {
    label: "Switch Connection…",
    click: () => {
      releaseConnection()
      loadPicker()
    },
  }

  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            // A plain label rather than `role: "appMenu"`: a role comes with its own
            // predefined submenu, and overriding one while also naming the role is
            // asking two mechanisms for the same answer. macOS labels the first menu
            // with the app name regardless of what is put here.
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              switchItem,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        ...(process.platform === "darwin" ? [] : [switchItem, { type: "separator" }]),
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------

/** Re-check for updates on this cadence while the app stays open. */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Repo the update feed and the fallback updater script come from. */
const UPDATE_REPO = process.env.LURSOR_REPO || "Systemized-Labs/lursor"
const UPDATE_SCRIPT_URL = `https://raw.githubusercontent.com/${UPDATE_REPO}/main/scripts/update.sh`

/**
 * The latest update state, mirrored to the renderer.
 *
 * Kept here as well as sent, for two reasons: the window may not have finished
 * loading when the first check resolves (a fast network beats the renderer), and a
 * reload throws away whatever the renderer knew. Both are replayed from here — see
 * `did-finish-load` in `createWindow`.
 *
 * `mechanism` matters to the UI because the two paths offer different things: Squirrel
 * downloads in the background and then needs a restart, whereas the script updater
 * hands off to Terminal and quits immediately. Telling the user "Restart now" when the
 * app is about to disappear into a Terminal window would be a lie.
 *
 * @typedef {"idle"|"checking"|"available"|"downloading"|"downloaded"|"error"|"unsupported"} UpdatePhase
 * @type {{phase: UpdatePhase, version: string|null, percent: number|null,
 *         error: string|null, mechanism: "squirrel"|"script"|"none", note: string|null}}
 */
let updateState = {
  phase: "idle",
  version: null,
  percent: null,
  error: null,
  mechanism: "none",
  note: null,
}

/** Merge into the update state and tell the renderer. */
function publishUpdateState(patch) {
  updateState = { ...updateState, ...patch }
  // Logged on every transition on purpose: if the IPC or the renderer subscription
  // ever breaks, an update that downloads and is never offered is otherwise a
  // completely silent regression — `autoInstallOnAppQuit` stays false, so nothing
  // happens at all.
  console.log(`[updater] ${updateState.phase}`, updateState.version ?? "")
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update:state", updateState)
  }
}

/**
 * Route this build to whichever update mechanism can actually finish the job.
 *
 * - dev: neither (there is no update feed for an unpackaged app).
 * - Linux: only an AppImage self-updates. A .deb is owned by apt/dpkg, and
 *   electron-updater errors out if we ask it to update one, so skip.
 * - macOS: Squirrel.Mac validates the code signature before swapping the
 *   bundle, so an unsigned build downloads a few hundred MB and then fails at
 *   the last step, with nothing but a log line to show for it. Ask Gatekeeper
 *   the same question up front and fall back to scripts/update.sh when the
 *   answer is no. This flips itself back to in-app updates the moment releases
 *   are signed and notarized — see docs/DISTRIBUTION.md.
 */
function initAutoUpdate() {
  if (isDev) {
    publishUpdateState({
      phase: "unsupported",
      note: "Updates are off in a development build.",
    })
    return
  }
  if (process.platform === "linux") {
    if (process.env.APPIMAGE) initSquirrelUpdate()
    else
      publishUpdateState({
        phase: "unsupported",
        note: "This build is managed by your package manager — update it with apt.",
      })
    return
  }
  if (process.platform !== "darwin") {
    publishUpdateState({
      phase: "unsupported",
      note: `No update channel for ${process.platform}.`,
    })
    return
  }

  isGatekeeperApproved().then((approved) => {
    if (approved) initSquirrelUpdate()
    else initScriptUpdate()
  })
}

/**
 * Whether Gatekeeper accepts this bundle — the same check Squirrel.Mac makes
 * before installing an update, and the one install.sh makes before deciding
 * whether to clear the quarantine flag.
 * @returns {Promise<boolean>}
 */
function isGatekeeperApproved() {
  const bundle = path.resolve(app.getPath("exe"), "..", "..", "..")
  return new Promise((resolve) => {
    execFile("spctl", ["--assess", "--type", "execute", bundle], (err) =>
      resolve(!err)
    )
  })
}

function initSquirrelUpdate() {
  // Required lazily: pulling electron-updater into an unpackaged dev run would
  // have it complain about the missing app-update.yml on startup.
  const { autoUpdater } = require("electron-updater")
  squirrel = autoUpdater

  autoUpdater.logger = console
  autoUpdater.autoDownload = true
  // Installing on quit would race the backend teardown, so we drive the restart
  // ourselves once the user asks for it.
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on("error", (err) => {
    publishUpdateState({
      phase: "error",
      error: String(err?.message ?? err),
      mechanism: "squirrel",
    })
  })
  autoUpdater.on("checking-for-update", () => {
    // Don't stomp a version already found and downloaded by an earlier check —
    // the 6-hourly re-check would otherwise hide a pending update mid-poll.
    if (updateState.phase === "downloaded" || updateState.phase === "downloading") return
    publishUpdateState({ phase: "checking", mechanism: "squirrel", error: null })
  })
  autoUpdater.on("update-not-available", () => {
    if (updateState.phase === "downloaded" || updateState.phase === "downloading") return
    publishUpdateState({ phase: "idle", version: null, mechanism: "squirrel" })
  })
  autoUpdater.on("update-available", (info) => {
    publishUpdateState({
      phase: "available",
      version: info.version,
      mechanism: "squirrel",
    })
  })
  autoUpdater.on("download-progress", (p) => {
    publishUpdateState({
      phase: "downloading",
      percent: Math.round(p?.percent ?? 0),
      mechanism: "squirrel",
    })
  })

  autoUpdater.on("update-downloaded", (info) => {
    // No dialog here any more: the offer is the renderer's, so it can be a toast
    // plus a persistent indicator rather than a modal that is gone once dismissed.
    // The install still only happens when the user asks — see `update:install`.
    publishUpdateState({
      phase: "downloaded",
      version: info.version,
      percent: 100,
      mechanism: "squirrel",
    })
  })

  autoUpdater.checkForUpdates()
  setInterval(() => autoUpdater.checkForUpdates(), UPDATE_CHECK_INTERVAL_MS)
}

// --- Script updater (builds Squirrel can't install) ------------------------

/** The electron-updater instance, once one exists. Null on the script path. */
let squirrel = null

/**
 * Compare two release versions. Dotted numeric compare, with a trailing
 * prerelease (1.2.0-rc.1) ranking below the release it leads to.
 * @returns {boolean} true when `candidate` is newer than `current`
 */
function isNewerVersion(candidate, current) {
  const parse = (value) => {
    const v = String(value ?? "").trim().replace(/^v/, "")
    const dash = v.indexOf("-")
    const base = dash === -1 ? v : v.slice(0, dash)
    return {
      nums: base.split(".").map((n) => parseInt(n, 10) || 0),
      pre: dash === -1 ? "" : v.slice(dash + 1),
    }
  }
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const x = a.nums[i] ?? 0
    const y = b.nums[i] ?? 0
    if (x !== y) return x > y
  }
  if (a.pre === b.pre) return false
  if (!a.pre) return true
  if (!b.pre) return false
  return a.pre > b.pre
}

function initScriptUpdate() {
  console.log("[updater] build is unsigned — using the script updater")
  checkForScriptUpdate()
  setInterval(checkForScriptUpdate, UPDATE_CHECK_INTERVAL_MS)
}

async function checkForScriptUpdate() {
  publishUpdateState({ phase: "checking", mechanism: "script", error: null })
  let latest = ""
  try {
    // `/releases/latest` excludes drafts and prereleases, which is exactly the
    // stable-only channel we want — no filtering of our own to get wrong.
    const res = await fetch(
      `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15_000),
      }
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    latest = String((await res.json()).tag_name ?? "").replace(/^v/, "")
  } catch (err) {
    publishUpdateState({
      phase: "error",
      error: String(err?.message ?? err),
      mechanism: "script",
    })
    return
  }

  if (!latest || !isNewerVersion(latest, app.getVersion())) {
    publishUpdateState({ phase: "idle", version: null, mechanism: "script" })
    return
  }

  // There is no download step on this path: the script does the fetching, after the
  // app has quit. So "available" is the terminal state, and the renderer's action
  // goes straight to the handoff.
  publishUpdateState({
    phase: "available",
    version: latest,
    mechanism: "script",
    note:
      "Lursor will quit, finish the update in a Terminal window, then reopen. " +
      "This stops any running agents.",
  })
}

/**
 * Hand the update to scripts/update.sh and get out of its way: the installer
 * can only replace the app bundle once this process is gone, so it waits on our
 * pid and reopens Lursor when it's done. Terminal gives a several-hundred-MB
 * download somewhere to show progress, since the app won't be around to.
 */
function runScriptUpdate(version) {
  const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
  const script = [
    "#!/bin/sh",
    `LURSOR_REPO=${quote(UPDATE_REPO)}`,
    `LURSOR_VERSION=${quote(version)}`,
    "export LURSOR_REPO LURSOR_VERSION",
    `curl -fsSL ${quote(UPDATE_SCRIPT_URL)} | sh -s -- --wait-pid ${process.pid} --relaunch`,
    "",
  ].join("\n")

  try {
    // mkdtemp gives us a 0700 directory, so nothing else can swap the script
    // out from under Terminal between writing it and opening it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lursor-update-"))
    const file = path.join(dir, "update-lursor.command")
    fs.writeFileSync(file, script, { mode: 0o700 })
    spawn("open", ["-a", "Terminal", file], {
      detached: true,
      stdio: "ignore",
    }).unref()
  } catch (err) {
    console.error("[updater] could not start the updater:", err?.message ?? err)
    dialog.showErrorBox(
      "Could not start the updater",
      `Run this in a terminal instead:\n\ncurl -fsSL ${UPDATE_SCRIPT_URL} | sh`
    )
    return
  }
  app.quit()
}

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

// Only one instance may own the backend/port at a time.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // In dev the dock/taskbar shows Electron's default icon; set ours. Packaged
    // builds get the icon from electron-builder, so only override when unpackaged.
    if (isDev && process.platform === "darwin" && app.dock && !APP_ICON.isEmpty()) {
      app.dock.setIcon(APP_ICON)
    }

    app.setAboutPanelOptions({
      applicationName: "Lursor",
      applicationVersion: app.getVersion(),
    })

    installMenu()

    // The window comes up first now, showing the splash while the connection is
    // resolved — which may mean waiting on a network round trip to a VPS, or on the
    // user choosing from the picker.
    createWindow()
    await bootConnection()

    // Only look for updates once the app is actually usable, so a slow or failing
    // update check never delays startup.
    //
    // This used to be local-only, on the grounds that quitting to install would drop
    // a remote connection mid-run. That reasoning applied to the *install*, not the
    // check — and the install is now user-initiated from the renderer rather than a
    // dialog that appears unbidden, so nothing quits until someone asks. Downloading
    // in the background touches no connection. Meanwhile the old skip left remote
    // users with no way to learn their client was out of date at all, which is the
    // configuration where client and backend drift in the first place.
    initAutoUpdate()

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length !== 0) return
      createWindow()
      // The window was closed, so whatever it was connected to has to be brought
      // back up — on macOS the app is still running and the local backend with it,
      // so this reattaches to that process and the health check passes immediately.
      await connectTo(activeConnection ?? connections.lastUsed())
    })
  })
}

app.on("window-all-closed", () => {
  // Forwards belong to the window that asked for them; a new one re-requests what
  // it needs from the process feed.
  portForward.closeAll()
  if (process.platform !== "darwin") app.quit()
})

/** Everything the app owns outside its own process. */
function teardown() {
  portForward.closeAll()
  clearDragStaging()
  killBackend()
}

// Tear down whenever the app is shutting down.
app.on("before-quit", teardown)
app.on("will-quit", teardown)
process.on("exit", teardown)
