import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Which projects have their sessions hidden, by id. A view preference, so it
 * stays on the device — the same treatment (and the same shape) as the folder
 * collapse set in `use-workspace-tree`.
 */
const COLLAPSED_KEY = "lursor:projects-collapsed"

function load(): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === "string"))
  } catch {
    return new Set()
  }
}

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
  const [collapsed, setCollapsed] = useState<Set<string>>(load)

  // Skip the first run, which would write back exactly what `load` read.
  const hydrated = useRef(false)
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true
      return
    }
    try {
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
    } catch {
      // Ignore quota / disabled-storage errors — this is best-effort.
    }
  }, [collapsed])

  const isCollapsed = useCallback(
    (workspaceId: string) => collapsed.has(workspaceId),
    [collapsed]
  )

  const toggle = useCallback((workspaceId: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return next
    })
  }, [])

  return { isCollapsed, toggle }
}
