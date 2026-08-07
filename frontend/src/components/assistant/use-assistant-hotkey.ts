import { useEffect } from "react"
import { useNavigate } from "react-router-dom"

import { useWorkspaces } from "@/api/workspaces"

/**
 * ⌘⇧A (Ctrl+Shift+A elsewhere) — jump to the Assistant from anywhere.
 *
 * The Assistant is a pinned sidebar row backed by a real workspace, not a modal,
 * so "open it" is a navigation rather than a piece of state. That is what makes
 * its past conversations reachable the same way every other workspace's are —
 * they list under its row and restore in its chat pane — and it is why this hook
 * holds no open/closed flag of its own.
 *
 * Bound on `window` rather than a container because reachable-from-anywhere is
 * the point: a workspace chat, the analytics pane and the settings dialog all
 * have to answer to it. Like every other chord in the app the handler lives with
 * the feature; `lib/shortcuts.ts` documents it.
 *
 * Typing is deliberately not excluded: unlike a bare letter, a modifier chord in
 * a textarea is unambiguous, and having to leave the composer to reach the
 * Assistant would defeat the point of it being global.
 */
export function useAssistantHotkey(): void {
  const navigate = useNavigate()
  const { data: workspaces } = useWorkspaces()

  useEffect(() => {
    const assistant = workspaces?.find((ws) => ws.is_assistant)
    if (!assistant) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return
      // `event.key` is unreliable with Shift held (it arrives upper- or
      // lower-cased depending on layout); `code` is the physical key.
      if (event.code !== "KeyA") return
      event.preventDefault()
      navigate(`/workspaces/${assistant.id}/chat`)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [navigate, workspaces])
}
