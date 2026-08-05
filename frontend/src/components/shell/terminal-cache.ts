import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"

import { connectWs } from "@/api/client"
import {
  lastTerminalSize,
  rememberTerminalSize,
  setTerminalDisposer,
} from "@/lib/terminal-session"

/**
 * Live xterm instances, cached beyond the lifetime of the React component that
 * shows them.
 *
 * The backend keeps the *shell* alive across a disconnect (see
 * `app/terminal_sessions.py`), which is what makes a terminal survive a reload.
 * This is the other half: keeping the *client* alive means a workspace switch
 * costs nothing at all — no socket, no replay, no re-render. Dockview's
 * `renderer: 'always'` already protects a pane from being reparented, but
 * switching workspaces calls `fromJSON` and rebuilds every panel, so the React
 * component genuinely unmounts. Parking the terminal's DOM node here and
 * re-appending it on the next mount preserves scroll position, selection and
 * alt-screen state exactly.
 *
 * Keyed by pane id, which is globally unique and already persisted with the
 * layout (`pane-kinds.ts`). Entries leave on real pane close, and by LRU past
 * {@link MAX_LIVE}; an evicted entry only loses its client, since the shell
 * behind it is still re-attachable.
 */

/** How many terminals stay hot. Past this the least recently used is dropped. */
const MAX_LIVE = 8

const RECONNECT_MIN_MS = 250
const RECONNECT_MAX_MS = 4000

interface Entry {
  paneId: string
  workspaceId?: string
  /** The persistent host node. Parked (detached) while no pane is showing it. */
  el: HTMLDivElement
  term: Terminal
  fit: FitAddon
  ws: WebSocket | null
  observer: ResizeObserver
  dataSub: { dispose: () => void }
  /** Backoff state for the reconnect loop. */
  attempt: number
  timer: number | null
  /** A pane is currently displaying this entry — never evict it. */
  mounted: boolean
  /** `dispose` has run; ignore every callback still in flight. */
  disposed: boolean
  /** The server said the *shell* exited, so a closed socket is not a dropout. */
  exited: boolean
  /** We have written PTY bytes at least once, so a replay must reset first. */
  hydrated: boolean
  /** The "connecting…" line is still on screen and should be erased. */
  notice: boolean
  usedAt: number
}

const entries = new Map<string, Entry>()

// --- theme ------------------------------------------------------------------

// Shared scratch canvas: the 2D context normalizes any browser-valid CSS color
// (oklch, hex, hsl, rgb, …) into an sRGB `#rrggbb`/`rgba(...)` string that
// xterm.js can parse. Our theme tokens come in all of those formats.
let colorCanvasCtx: CanvasRenderingContext2D | null | undefined

/** Resolve a semantic CSS token off :root to an xterm-parseable color string. */
function readToken(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
  if (!raw) return fallback

  if (colorCanvasCtx === undefined) {
    colorCanvasCtx = document.createElement("canvas").getContext("2d")
  }
  if (!colorCanvasCtx) return fallback

  // A rejected assignment leaves fillStyle unchanged, so seed a known sentinel
  // and treat "value didn't take" as a parse failure.
  colorCanvasCtx.fillStyle = "#000"
  colorCanvasCtx.fillStyle = raw
  const normalized = colorCanvasCtx.fillStyle
  return typeof normalized === "string" ? normalized : fallback
}

/** Derive an xterm theme from the app's semantic CSS tokens (light/dark aware). */
function readTheme() {
  // Ride on `--card` (the same surface Monaco uses) rather than the canvas
  // `--background`, so the terminal reads as a distinct, more legible panel.
  return {
    background: readToken("--card", "#000"),
    foreground: readToken("--card-foreground", "#fff"),
    cursor: readToken("--card-foreground", "#fff"),
    cursorAccent: readToken("--card", "#000"),
    selectionBackground: readToken("--accent", "#3b3b3b"),
    selectionForeground: readToken("--accent-foreground", "#fff"),
  }
}

/**
 * One observer for every terminal, installed on first use.
 *
 * Per-instance it would mean N observers on the same node watching for the same
 * class flip — and, now that instances outlive their components, N observers
 * nobody unsubscribes on unmount.
 */
let themeObserver: MutationObserver | null = null

function ensureThemeObserver(): void {
  if (themeObserver || typeof MutationObserver === "undefined") return
  themeObserver = new MutationObserver(() => {
    const theme = readTheme()
    for (const entry of entries.values()) entry.term.options.theme = theme
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  })
}

// --- geometry ---------------------------------------------------------------

/** Fit to the parked node's box, then tell the PTY its new dimensions. */
function syncSize(entry: Entry): void {
  // Not just zero: a pane too short for a single row has no size worth
  // reporting, and telling the PTY it is one row high reflows the shell's whole
  // output — so a panel collapsed and expanded again would come back mangled.
  // Below a line, the last real size is the right one to keep. A parked node is
  // detached and measures zero, which this covers too.
  if (entry.el.clientWidth === 0 || entry.el.clientHeight < 24) return
  try {
    entry.fit.fit()
  } catch {
    return
  }
  rememberTerminalSize(entry.term.cols, entry.term.rows)
  if (entry.ws?.readyState === WebSocket.OPEN) {
    entry.ws.send(
      JSON.stringify({ type: "resize", cols: entry.term.cols, rows: entry.term.rows })
    )
  }
}

// --- connection -------------------------------------------------------------

function connect(entry: Entry): void {
  if (entry.disposed) return
  entry.timer = null

  const ws = connectWs("/terminal/ws", {
    session_id: entry.paneId,
    ...(entry.workspaceId ? { workspace_id: entry.workspaceId } : {}),
    cols: String(entry.term.cols),
    rows: String(entry.term.rows),
  })
  ws.binaryType = "arraybuffer"
  entry.ws = ws
  const encoder = new TextEncoder()

  ws.onopen = () => {
    entry.attempt = 0
    // A reconnect replays the server's whole ring, so whatever is on screen has
    // to go first or the scrollback would be printed twice. Only on a *re*-connect:
    // a first connect has nothing to clear.
    if (entry.hydrated) {
      entry.term.reset()
      entry.notice = false
    }
    syncSize(entry)
  }

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      // Text frames are control messages, not output. `exit` is the only one, and
      // it is the difference between "the shell died" and "the socket dropped" —
      // without it every reconnect would falsely report a dead process.
      try {
        const message = JSON.parse(event.data) as { type?: string }
        if (message.type === "exit") {
          entry.exited = true
          return
        }
      } catch {
        // Not ours: fall through and print it, as the endpoint used to allow.
      }
    }
    if (entry.notice) {
      // Erase the "connecting…" line in place so the first prompt lands on it.
      entry.term.write("\r\x1b[2K")
      entry.notice = false
    }
    entry.hydrated = true
    if (event.data instanceof ArrayBuffer) {
      entry.term.write(new Uint8Array(event.data))
    } else if (typeof event.data === "string") {
      entry.term.write(event.data)
    }
  }

  ws.onclose = () => {
    if (entry.disposed || entry.ws !== ws) return
    entry.ws = null
    if (entry.exited) {
      entry.term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n")
      return
    }
    scheduleReconnect(entry)
  }

  entry.dataSub.dispose()
  // Keystrokes → PTY (binary frames keep control chars byte-exact).
  entry.dataSub = entry.term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data))
  })
}

function scheduleReconnect(entry: Entry): void {
  if (entry.disposed || entry.timer !== null) return
  const delay = Math.min(RECONNECT_MIN_MS * 2 ** entry.attempt, RECONNECT_MAX_MS)
  entry.attempt += 1
  entry.timer = window.setTimeout(() => connect(entry), delay)
}

/**
 * Retry every dropped terminal now.
 *
 * A machine that just came back online, or a tab the user just returned to, has
 * no reason to sit out the rest of a four-second backoff — and after a laptop
 * sleep the backoff timer itself may not have fired at all.
 */
function reconnectAll(): void {
  for (const entry of entries.values()) {
    if (entry.disposed || entry.exited || entry.ws) continue
    if (entry.timer !== null) {
      window.clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.attempt = 0
    connect(entry)
  }
}

let wakeListenersInstalled = false

function ensureWakeListeners(): void {
  if (wakeListenersInstalled || typeof window === "undefined") return
  wakeListenersInstalled = true
  window.addEventListener("online", reconnectAll)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reconnectAll()
  })
}

// --- lifecycle --------------------------------------------------------------

function create(paneId: string, workspaceId?: string): Entry {
  const el = document.createElement("div")
  el.style.height = "100%"
  el.style.width = "100%"

  const term = new Terminal({
    fontFamily:
      '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    allowProposedApi: true,
    theme: readTheme(),
    scrollback: 10000,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  term.open(el)
  // Start at the size the last terminal settled at rather than xterm's 80×24.
  // The first connect carries these to the server, so a pre-warmed shell — which
  // was started at this same guess — is not resized out from under its prompt the
  // instant it is claimed.
  const remembered = lastTerminalSize()
  term.resize(remembered.cols, remembered.rows)

  let entry: Entry
  const observer = new ResizeObserver(() => {
    if (entry) syncSize(entry)
  })

  entry = {
    paneId,
    workspaceId,
    el,
    term,
    fit,
    ws: null,
    observer,
    dataSub: { dispose: () => undefined },
    attempt: 0,
    timer: null,
    mounted: false,
    disposed: false,
    exited: false,
    hydrated: false,
    notice: true,
    usedAt: Date.now(),
  }

  // Something on screen from the first frame. A cold shell spends whatever the
  // user's rc files cost before it prints a prompt, and a blank panel for two
  // seconds reads as a hang rather than as work in progress.
  term.write("\x1b[2mconnecting…\x1b[0m")

  entry.observer.observe(el)
  entries.set(paneId, entry)
  ensureThemeObserver()
  ensureWakeListeners()
  // Not connected yet, and not swept yet — both wait for `mountTerminal`. The
  // socket, because the pane has to be measured first (a shell told the wrong
  // width draws its prompt for a screen this one does not have). The sweep,
  // because this entry is not `mounted` until the caller has appended it, so
  // with MAX_LIVE terminals already open the only eviction candidate would be
  // the one we just built.
  return entry
}

/** Tear down the client. The backend session is untouched and re-attachable. */
function dispose(entry: Entry): void {
  entry.disposed = true
  if (entry.timer !== null) window.clearTimeout(entry.timer)
  entry.observer.disconnect()
  entry.dataSub.dispose()
  if (entry.ws) {
    entry.ws.onclose = null
    entry.ws.close()
  }
  entry.term.dispose()
  entry.el.remove()
  entries.delete(entry.paneId)
}

function evictStale(): void {
  if (entries.size <= MAX_LIVE) return
  const idle = [...entries.values()]
    .filter((entry) => !entry.mounted)
    .sort((a, b) => a.usedAt - b.usedAt)
  for (const entry of idle.slice(0, entries.size - MAX_LIVE)) dispose(entry)
}

export interface MountedTerminal {
  /** Park the node again, leaving the socket and the shell alone. */
  unmount: () => void
}

/**
 * Show pane `paneId`'s terminal inside `host`, creating it on first use.
 *
 * The returned `unmount` detaches the node without closing anything — that is
 * the whole point. Real teardown is {@link releaseTerminal}.
 */
export function mountTerminal(
  host: HTMLElement,
  paneId: string,
  workspaceId?: string
): MountedTerminal {
  const existing = entries.get(paneId)
  const entry = existing ?? create(paneId, workspaceId)
  entry.usedAt = Date.now()
  entry.mounted = true
  host.appendChild(entry.el)
  // Measure first. Only once the node is in the document does `fit` know the
  // pane's real geometry, and the first frame the server sends is drawn for
  // whatever geometry we open the socket with — including a pre-warmed shell's
  // prompt, which is discarded and repainted if we ask for a different size.
  syncSize(entry)
  if (!existing) {
    connect(entry)
    // Focus only a terminal the user has just caused to exist. Re-showing a
    // cached one happens on every workspace switch, and stealing focus there
    // would yank the caret out of whatever they were actually typing in.
    entry.term.focus()
  }
  // Safe here and not in `create`: this one is now `mounted`, so it cannot be
  // the candidate its own arrival evicted.
  evictStale()

  return {
    unmount: () => {
      entry.mounted = false
      entry.usedAt = Date.now()
      if (entry.el.parentNode === host) host.removeChild(entry.el)
      evictStale()
    },
  }
}

// Hand the pane layer a way to tear a terminal down without importing xterm to
// do it — see `lib/terminal-session.ts` for why the dependency points this way.
setTerminalDisposer((paneId) => {
  const entry = entries.get(paneId)
  if (entry) dispose(entry)
})
