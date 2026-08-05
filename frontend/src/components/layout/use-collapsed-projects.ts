import { useCallback } from "react"

import { useStoredSet } from "@/hooks/use-stored"

/**
 * Which projects have their sessions hidden, by id. A view preference, so it
 * stays on the device — the same treatment (and the same shape) as the folder
 * collapse set in `use-workspace-tree`.
 */
const COLLAPSED_KEY = "lursor:projects-collapsed"

export interface CollapsedProjects {
  isCollapsed: (workspaceId: string) => boolean
  toggle: (workspaceId: string) => void
}

/**
 * Whether a project shows its sessions inline.
 *
 * Stores the *shut* ones, not the open ones, so absence means expanded: a
 * project you have never touched — and one that only just appeared — shows its
 * sessions, which is what the list is for. Storing the open set would mean every
 * new project arrived silent, and the fix for that ("expand it") is work the user
 * did not ask to do.
 *
 * Unlike the drill (`use-project-drill`), this *is* persisted. Collapsing is a
 * standing judgement about a project — "I am not working in that one" — and
 * having to re-tidy sixteen repos on every launch would make the arrow not worth
 * clicking.
 */
export function useCollapsedProjects(): CollapsedProjects {
  const [collapsed, toggle] = useStoredSet(COLLAPSED_KEY)

  const isCollapsed = useCallback(
    (workspaceId: string) => collapsed.has(workspaceId),
    [collapsed]
  )

  return { isCollapsed, toggle }
}
