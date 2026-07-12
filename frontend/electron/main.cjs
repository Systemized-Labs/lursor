// Electron main process for the Lursor desktop app.
//
// In development it loads the Vite dev server (URL passed via
// VITE_DEV_SERVER_URL). In production it loads the built renderer from
// dist/index.html. The Python/FastAPI backend is expected to run separately
// on http://localhost:8000 (see the repo README / scripts/dev.sh).

const path = require("node:path")
const { app, BrowserWindow, nativeImage, shell } = require("electron")

const isDev = !app.isPackaged
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173"

// The product name — drives the macOS menu bar, About panel, and dock tooltip.
// In packaged builds this comes from electron-builder's productName, but set it
// explicitly so it is correct in dev too (otherwise it reads "Electron").
app.setName("Lursor")

const APP_ICON = nativeImage.createFromPath(
  path.join(__dirname, "..", "build", "icon.png")
)

/** @type {BrowserWindow | null} */
let mainWindow = null

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
    },
  })

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show()
  })

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: "detach" })
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"))
  }

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

app.whenReady().then(() => {
  // In dev the dock/taskbar shows Electron's default icon; set ours. Packaged
  // builds get the icon from electron-builder, so only override when unpackaged.
  if (isDev && process.platform === "darwin" && app.dock && !APP_ICON.isEmpty()) {
    app.dock.setIcon(APP_ICON)
  }

  app.setAboutPanelOptions({
    applicationName: "Lursor",
    applicationVersion: app.getVersion(),
  })

  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
