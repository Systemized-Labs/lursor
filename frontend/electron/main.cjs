// Electron main process for the Lursor desktop app.
//
// The desktop app owns its backend: on launch it starts the bundled FastAPI
// server (a frozen, self-contained Python interpreter shipped under the app's
// resources), waits for it to become healthy, then loads the renderer. In
// development it instead runs the backend from source via `uv` and loads the
// Vite dev server. See docs/PLAN-desktop-install.md.

const path = require("node:path")
const os = require("node:os")
const fs = require("node:fs")
const http = require("node:http")
const net = require("node:net")
const { spawn } = require("node:child_process")
const { app, BrowserWindow, nativeImage, shell, ipcMain, dialog } = require("electron")

const isDev = !app.isPackaged
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:8888"
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
/** Set once the backend port is chosen; the renderer talks to this base. */
let apiBase = ""
/** Guards teardown so we only kill the backend once. */
let backendKilled = false

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
  const args = [
    "-m",
    "uvicorn",
    "app.main:app",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ]

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
      args,
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
    args: ["run", "uvicorn", ...args],
    cwd: backendDir,
    dataDir: null,
  }
}

function startBackend(port) {
  const { command, args, cwd, dataDir } = resolveBackendCommand(port)
  const env = { ...process.env, PYTHONUNBUFFERED: "1" }
  if (dataDir) env.LURSOR_DATA_DIR = dataDir

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
    backendProc = null
  })

  backendProc = proc
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
 * Poll the backend's health endpoint until it responds ok or we time out.
 * @returns {Promise<boolean>}
 */
function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const url = `http://127.0.0.1:${port}/api/health`

  const pingOnce = () =>
    new Promise((resolve) => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.on("error", () => resolve(false))
      req.setTimeout(2000, () => {
        req.destroy()
        resolve(false)
      })
    })

  return new Promise((resolve) => {
    const attempt = async () => {
      if (await pingOnce()) return resolve(true)
      // Bail early if the backend process died on us.
      if (!backendProc) return resolve(false)
      if (Date.now() >= deadline) return resolve(false)
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
    // Nudge the macOS traffic lights down so they sit centered in the app's
    // top strip instead of clipping the sidebar logo.
    trafficLightPosition:
      process.platform === "darwin" ? { x: 14, y: 18 } : undefined,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Hand the resolved API base to the renderer synchronously via the preload
      // (the backend port may be ephemeral, so it can't be baked in at build).
      additionalArguments: [`--lursor-api-base=${apiBase}`],
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

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

function loadApp() {
  if (!mainWindow) return
  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: "detach" })
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"))
  }
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
// Auto-update
// ---------------------------------------------------------------------------

/** Re-check for updates on this cadence while the app stays open. */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Whether this build can install an update in place.
 *
 * - dev: never (there is no update feed for an unpackaged app).
 * - macOS: Squirrel.Mac validates the code signature, so unsigned builds can
 *   download an update but never install one. We still let it try and surface
 *   the failure in the log rather than second-guessing the signature here.
 * - Linux: only AppImage self-updates. A .deb install is owned by apt/dpkg, and
 *   electron-updater errors out if we ask it to update one, so skip.
 */
function canSelfUpdate() {
  if (isDev) return false
  if (process.platform === "linux") return Boolean(process.env.APPIMAGE)
  return process.platform === "darwin"
}

function initAutoUpdate() {
  if (!canSelfUpdate()) {
    console.log("[updater] not supported for this build — skipping")
    return
  }

  // Required lazily: pulling electron-updater into an unpackaged dev run would
  // have it complain about the missing app-update.yml on startup.
  const { autoUpdater } = require("electron-updater")

  autoUpdater.logger = console
  autoUpdater.autoDownload = true
  // Installing on quit would race the backend teardown, so we drive the restart
  // ourselves from the prompt below.
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on("error", (err) => {
    console.error("[updater] check failed:", err?.message ?? err)
  })
  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] downloading ${info.version}`)
  })

  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `Lursor ${info.version} is ready to install`,
      detail:
        "Restarting takes a few seconds and will stop any running agents. The update installs on the next launch either way.",
    })
    if (response === 0) {
      // quitAndInstall triggers before-quit, so killBackend still runs.
      autoUpdater.quitAndInstall()
    } else {
      autoUpdater.autoInstallOnAppQuit = true
    }
  })

  autoUpdater.checkForUpdates()
  setInterval(() => autoUpdater.checkForUpdates(), UPDATE_CHECK_INTERVAL_MS)
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

    const port = await findFreePort(PREFERRED_PORT)
    apiBase = `http://127.0.0.1:${port}/api`

    createWindow()
    startBackend(port)

    const healthy = await waitForHealth(port, HEALTH_TIMEOUT_MS)
    if (healthy) {
      loadApp()
      // Only look for updates once the app is actually usable, so a slow or
      // failing update check never delays startup.
      initAutoUpdate()
    } else {
      showBackendError()
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

// Tear the backend down whenever the app is shutting down.
app.on("before-quit", killBackend)
app.on("will-quit", killBackend)
process.on("exit", killBackend)
