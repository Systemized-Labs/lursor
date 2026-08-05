import { api } from "@/api/client"

/**
 * The parts of a terminal session that are *not* xterm.
 *
 * `use-pane-layout` and the shell's pre-warm hook both need to say something
 * about terminals, and both are value imports from the app shell — so they land
 * in the entry chunk on every route. Importing `terminal-cache` from either
 * would drag xterm and its CSS along with them, past the lazy boundary that
 * keeps those in the pane host's chunk. Same rule `pane-kinds.ts` follows for
 * dockview.
 *
 * So the dependency runs the other way: `terminal-cache` registers its disposer
 * here when it loads, and everything in this module is either an HTTP call or a
 * localStorage read.
 */

/**
 * Last known terminal geometry, shared across panes rather than per-pane.
 *
 * Read by the pre-warm call, which fires when a workspace opens — before any
 * pane exists to have a size of its own. It only has to be *close*: without it
 * the warm shell prints its first prompt at 80×24 and visibly reflows the moment
 * a real pane attaches.
 */
const SIZE_KEY = "lursor:terminal:size"

export interface TerminalSize {
  cols: number
  rows: number
}

/** The geometry the last terminal settled at, or xterm's default. */
export function lastTerminalSize(): TerminalSize {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TerminalSize>
      if (parsed.cols && parsed.rows) return { cols: parsed.cols, rows: parsed.rows }
    }
  } catch {
    // Best-effort: the default below only costs one reflow on first attach.
  }
  return { cols: 80, rows: 24 }
}

export function rememberTerminalSize(cols: number, rows: number): void {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify({ cols, rows }))
  } catch {
    // Ignore quota / disabled-storage errors — this is a hint, not state.
  }
}

type Disposer = (paneId: string) => void

let disposeClient: Disposer | null = null

/** Called by `terminal-cache` at import time. */
export function setTerminalDisposer(disposer: Disposer): void {
  disposeClient = disposer
}

/**
 * Dispose the cached terminal for `paneId` and reap the shell behind it.
 *
 * For a pane the user actually closed — never for one being unloaded by a
 * workspace switch, which is exactly the distinction `use-pane-layout` draws
 * with its `loading` ref. The backend's idle TTL is the backstop for the cases
 * this never runs for (a closed browser tab, a crash).
 *
 * The DELETE goes out even when nothing is cached: a pane can outlive its cache
 * entry (LRU eviction), and the shell is still the backend's to kill.
 */
export function releaseTerminal(paneId: string): void {
  disposeClient?.(paneId)
  void api
    .delete(`/terminal/sessions/${encodeURIComponent(paneId)}`)
    .catch(() => undefined)
}
