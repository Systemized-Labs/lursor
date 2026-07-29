import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { Workspace } from "@/api/types"
import {
  defaultIconKey,
  iconDef,
  readIconOverrides,
  writeIconOverrides,
  type IconOverrides,
  type WorkspaceIconDef,
} from "@/lib/workspace-icon"

export interface WorkspaceIcons {
  /** The icon to draw for a workspace — its own choice, or the keyword default. */
  iconFor: (workspace: Workspace) => WorkspaceIconDef
  /** Pick an icon, or pass null to fall back to the keyword default. */
  setIcon: (workspaceId: string, key: string | null) => void
  /** Whether this workspace has an explicit choice (drives "Reset icon"). */
  hasOverride: (workspaceId: string) => boolean
}

/**
 * Which icon each workspace wears in the rail.
 *
 * Stored locally rather than on the workspace record: this is a per-device display
 * preference, it needs no migration or endpoint, and getting it wrong costs
 * nothing. `knownIds` prunes deleted workspaces, waiting for a non-empty list so
 * the first render — before the workspaces query resolves — doesn't wipe the
 * record.
 */
export function useWorkspaceIcons(knownIds: string[]): WorkspaceIcons {
  const [overrides, setOverrides] = useState<IconOverrides>(readIconOverrides)

  // Skip the first run: it would write back exactly what the read just returned.
  const loaded = useRef(false)
  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true
      return
    }
    writeIconOverrides(overrides)
  }, [overrides])

  useEffect(() => {
    if (knownIds.length === 0) return
    const known = new Set(knownIds)
    setOverrides((prev) => {
      const next: IconOverrides = {}
      let dropped = false
      for (const [id, key] of Object.entries(prev)) {
        if (known.has(id)) next[id] = key
        else dropped = true
      }
      return dropped ? next : prev
    })
  }, [knownIds])

  const setIcon = useCallback((workspaceId: string, key: string | null) => {
    setOverrides((prev) => {
      if (key === null) {
        if (!(workspaceId in prev)) return prev
        const next = { ...prev }
        delete next[workspaceId]
        return next
      }
      if (prev[workspaceId] === key) return prev
      return { ...prev, [workspaceId]: key }
    })
  }, [])

  const iconFor = useCallback(
    (workspace: Workspace) =>
      iconDef(
        overrides[workspace.id] ?? defaultIconKey(workspace.name, workspace.id)
      ),
    [overrides]
  )

  const hasOverride = useCallback(
    (workspaceId: string) => workspaceId in overrides,
    [overrides]
  )

  return useMemo(
    () => ({ iconFor, setIcon, hasOverride }),
    [iconFor, setIcon, hasOverride]
  )
}
