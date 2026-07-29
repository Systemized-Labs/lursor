import { useCallback, useState } from "react"

/**
 * Which list the sidebar panel is showing. Deliberately *sidebar state* rather
 * than a route: opening a conversation from the Activity list navigates to that
 * chat, and if the panel were derived from the route it would flip back to
 * Chats under the cursor. Only a rail click changes the mode.
 *
 * "Skills" used to be a third mode, for the Skill Studio's conversations. The
 * studio is a workspace, so it is a rail tile now and its conversations are the
 * Chats list scoped to it — a mode for it was only ever compensating for the
 * studio having no way to be the workspace it is.
 */
export type PanelMode = "chats" | "activity"

const STORAGE_KEY = "sidebar:panel"
const MODES: PanelMode[] = ["chats", "activity"]

function load(): PanelMode {
  if (typeof window === "undefined") return "chats"
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return MODES.includes(stored as PanelMode) ? (stored as PanelMode) : "chats"
  } catch {
    return "chats"
  }
}

/**
 * The panel mode, persisted across reloads — same precedent as the sidebar's
 * `sidebar:width`. Coming back to a window you left on Activity should not
 * silently reset it.
 */
export function usePanelMode(): [PanelMode, (mode: PanelMode) => void] {
  const [mode, setMode] = useState<PanelMode>(load)

  const set = useCallback((next: PanelMode) => {
    setMode(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Ignore quota / disabled-storage errors — the mode is best-effort.
    }
  }, [])

  return [mode, set]
}
