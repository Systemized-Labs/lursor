import { useCallback, useState } from "react"

export interface ProjectDrill {
  /**
   * The project the list is scoped to, or null for every project.
   *
   * Sidebar state, not a route, and this is the load-bearing reason (inherited
   * from the `use-sessions-view` / `use-panel-mode` this replaces): opening a
   * session *navigates*, and a scope derived from the route would snap back to
   * the full list under the cursor every time you clicked a row in a project you
   * were only browsing.
   *
   * Session-only, deliberately: a drill-down is where you are in a browse, not a
   * preference about what the sidebar is for. Restoring it on launch would open
   * the app inside one project with no memory of having asked.
   */
  drilledId: string | null
  drillInto: (workspaceId: string) => void
  drillOut: () => void
}

/**
 * Which project the sidebar list is scoped to.
 *
 * The sidebar has one list now, in two shapes — every project with its recent
 * sessions, or one project with all of them. This is the whole of the state that
 * chooses between them; the Activity feed that used to be the other *view* is
 * gone, and with it the persisted `sidebar:panel` key that remembered which view
 * you left it on.
 */
export function useProjectDrill(): ProjectDrill {
  const [drilledId, setDrilledId] = useState<string | null>(null)

  const drillInto = useCallback(
    (workspaceId: string) => setDrilledId(workspaceId),
    []
  )
  const drillOut = useCallback(() => setDrilledId(null), [])

  return { drilledId, drillInto, drillOut }
}
