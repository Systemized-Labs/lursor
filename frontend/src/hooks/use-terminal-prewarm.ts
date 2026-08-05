import { useEffect } from "react"

import { api } from "@/api/client"
import { lastTerminalSize } from "@/lib/terminal-session"

/**
 * Workspaces this browser session has already asked the backend to pre-warm.
 *
 * Module scope, not a ref: the point is one request per workspace per *session*,
 * and the shell remounts. The backend is idempotent anyway — this just keeps the
 * request count honest.
 */
const warmed = new Set<string>()

/**
 * A terminal's real cost is the user's own shell rc files — measured at ~1.8s
 * for a plain `zsh -i` on a developer machine, and every millisecond of it is
 * paid before the first prompt is painted. Nothing about that is ours to
 * optimise, so hide it instead: start one shell per workspace in the background
 * when the workspace opens, and by the time anyone clicks Terminal it is already
 * sitting at its prompt, waiting to be claimed.
 *
 * Fire-and-forget in every sense. A failure, an old backend without the
 * endpoint, a workspace nobody opens a terminal in — all of them cost nothing
 * beyond the shell being reaped by the unclaimed-session TTL
 * (`app/terminal_sessions.py`).
 *
 * `cols`/`rows` are the geometry the last terminal settled at, so the warm
 * shell's prompt is not printed at 80×24 and then reflowed the instant a real
 * pane attaches.
 */
export function useTerminalPrewarm(workspaceId?: string): void {
  useEffect(() => {
    if (!workspaceId || warmed.has(workspaceId)) return
    warmed.add(workspaceId)

    const { cols, rows } = lastTerminalSize()
    const query = new URLSearchParams({
      workspace_id: workspaceId,
      cols: String(cols),
      rows: String(rows),
    })
    void api.post(`/terminal/prewarm?${query}`, undefined).catch(() => {
      // Let it be tried again if the user comes back to this workspace.
      warmed.delete(workspaceId)
    })
  }, [workspaceId])
}
