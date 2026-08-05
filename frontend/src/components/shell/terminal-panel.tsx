import { useEffect, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"

import { API_BASE } from "@/api/client"

/** Build the WebSocket URL for the PTY endpoint from the REST API base. */
function terminalWsUrl(workspaceId?: string): string {
  const url = new URL(`${API_BASE.replace(/\/$/, "")}/terminal/ws`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  if (workspaceId) url.searchParams.set("workspace_id", workspaceId)
  return url.toString()
}

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

interface TerminalPanelProps {
  /** Workspace whose directory the shell runs in (falls back to the root dir). */
  workspaceId?: string
}

/**
 * A live, interactive terminal wired to a real PTY on the backend.
 *
 * Owns an xterm.js instance for its whole lifetime: keystrokes stream out as
 * binary frames, PTY output streams back in, and resizes (from the FitAddon +
 * a ResizeObserver) are sent as JSON control frames. Each mounted instance is
 * its own shell, so multiple terminal tabs are independent sessions.
 */
export function TerminalPanel({ workspaceId }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

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
    term.open(host)

    const ws = new WebSocket(terminalWsUrl(workspaceId))
    ws.binaryType = "arraybuffer"
    const encoder = new TextEncoder()

    /** Fit to the container, then tell the PTY its new dimensions. */
    const syncSize = () => {
      // Not just zero: a pane too short for a single row has no size worth
      // reporting, and telling the PTY it is one row high reflows the shell's whole
      // output — so a panel collapsed and expanded again would come back mangled. Below
      // a line, the last real size is the right one to keep.
      if (host.clientWidth === 0 || host.clientHeight < 24) return
      try {
        fit.fit()
      } catch {
        return
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }))
      }
    }

    ws.onopen = () => {
      syncSize()
      term.focus()
    }
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data))
      } else if (typeof event.data === "string") {
        term.write(event.data)
      }
    }
    ws.onclose = () => {
      term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n")
    }

    // Keystrokes → PTY (binary frames keep control chars byte-exact).
    const dataSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data))
    })

    // Refit when the dock is resized or the tab becomes visible.
    const resizeObserver = new ResizeObserver(() => syncSize())
    resizeObserver.observe(host)

    // Follow light/dark toggles (next-themes flips the `.dark` class on <html>).
    const themeObserver = new MutationObserver(() => {
      term.options.theme = readTheme()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })

    return () => {
      dataSub.dispose()
      resizeObserver.disconnect()
      themeObserver.disconnect()
      ws.onclose = null
      ws.close()
      term.dispose()
    }
  }, [workspaceId])

  // `bg-card` matches the xterm background so xterm's leftover partial-cell
  // space (and the small left inset) reads as one continuous surface.
  return <div ref={hostRef} className="h-full w-full overflow-hidden bg-card pl-2" />
}
