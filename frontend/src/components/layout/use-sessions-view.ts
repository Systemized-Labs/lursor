import { useCallback, useState } from "react"

/**
 * What the sessions pane is showing.
 *
 * - `projects` — the PROJECTS list, optionally drilled into one project.
 * - `activity` — the cross-workspace log of what has been happening.
 *
 * Sidebar state, not a route, and this is the load-bearing reason (inherited
 * verbatim from the `use-panel-mode` it replaces): opening a conversation from
 * the Activity list *navigates*, and a view derived from the route would flip
 * back to Projects under the cursor the moment you clicked. Only a nav row
 * changes the view.
 */
export type SessionsView = "projects" | "activity"

const VIEW_KEY = "sidebar:panel"
const VIEWS: SessionsView[] = ["projects", "activity"]

/**
 * Reads the key `use-panel-mode` wrote, so a window left on Activity comes back
 * on Activity across the upgrade. `chats` was the old name for `projects`.
 */
function loadView(): SessionsView {
  if (typeof window === "undefined") return "projects"
  try {
    const stored = window.localStorage.getItem(VIEW_KEY)
    if (stored === "chats") return "projects"
    return VIEWS.includes(stored as SessionsView)
      ? (stored as SessionsView)
      : "projects"
  } catch {
    return "projects"
  }
}

export interface SessionsViewState {
  view: SessionsView
  setView: (view: SessionsView) => void
  /**
   * The project the PROJECTS section is scoped to, or null for the whole list.
   *
   * Session-only, unlike {@link SessionsViewState.view}: a drill-down is where
   * you are in a browse, not a preference about what the sidebar is for.
   * Restoring it on launch would open the app inside one project with no memory
   * of having asked.
   */
  drilledId: string | null
  drillInto: (workspaceId: string) => void
  drillOut: () => void
}

export function useSessionsView(): SessionsViewState {
  const [view, setViewState] = useState<SessionsView>(loadView)
  const [drilledId, setDrilledId] = useState<string | null>(null)

  const setView = useCallback((next: SessionsView) => {
    setViewState(next)
    try {
      window.localStorage.setItem(VIEW_KEY, next)
    } catch {
      // Ignore quota / disabled-storage errors — the view is best-effort.
    }
  }, [])

  // Drilling in implies the Projects view: the section being scoped is Projects'.
  const drillInto = useCallback(
    (workspaceId: string) => {
      setDrilledId(workspaceId)
      setView("projects")
    },
    [setView]
  )

  const drillOut = useCallback(() => setDrilledId(null), [])

  return { view, setView, drilledId, drillInto, drillOut }
}
