import { useEffect, useRef } from "react"

import { mountTerminal } from "@/components/shell/terminal-cache"

interface TerminalPanelProps {
  /** Workspace whose directory the shell runs in (falls back to the root dir). */
  workspaceId?: string
  /** The pane's id — the terminal session's identity, on both ends. */
  paneId: string
}

/**
 * A live, interactive terminal wired to a real PTY on the backend.
 *
 * Deliberately almost nothing. The xterm instance, the socket and the reconnect
 * loop all live in `terminal-cache.ts`, keyed by pane id, because they have to
 * outlive this component: switching workspaces rebuilds every pane
 * (`use-pane-layout.ts`), which unmounts this one, and a terminal that restarted
 * every time you looked away is not a terminal. What is left here is the part
 * React should own — putting the cached node in the DOM and taking it out again.
 *
 * The shell outlives even the cache, on the backend
 * (`app/terminal_sessions.py`), so a session survives a page reload too. It is
 * killed only when the pane is genuinely closed; see `releaseTerminal`.
 */
export function TerminalPanel({ workspaceId, paneId }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    return mountTerminal(host, paneId, workspaceId).unmount
  }, [paneId, workspaceId])

  // `bg-card` matches the xterm background so xterm's leftover partial-cell
  // space (and the small left inset) reads as one continuous surface.
  return <div ref={hostRef} className="h-full w-full overflow-hidden bg-card pl-2" />
}
