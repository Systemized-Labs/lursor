import { useCallback, useEffect, useMemo, useRef } from "react"
import { useNavigate } from "react-router-dom"

import type { Thread, Workspace } from "@/api/types"
import type { WorkspaceVisits } from "@/hooks/use-workspace-visits"
import { isElectron } from "@/lib/platform"
import { resumeHref } from "@/lib/workspace-resume"

/** How long a second ⌘ tap still counts as a double-tap. */
const DOUBLE_TAP_MS = 400

interface UseWorkspaceSwitchOptions {
  visits: WorkspaceVisits
  /** Conversations bucketed by workspace, each newest-first. */
  byWorkspace: Map<string, Thread[]>
  activeWorkspaceId: string | undefined
  /** Workspaces in sidebar tree order, for ⌘⇧1–⌘⇧9 position switching. */
  ordered: Workspace[]
  /**
   * A switch landed — from a tile or double-⌘. Used to point the
   * panel at the workspace's conversations and to close the mobile drawer.
   */
  onNavigate: () => void
}

export interface WorkspaceSwitch {
  /** Go to a workspace, resuming whatever you last had open there. */
  switchTo: (workspaceId: string) => void
  /** The URL {@link switchTo} would visit — for `<Link>`s and middle-click. */
  hrefFor: (workspaceId: string) => string
}

/**
 * Switching workspaces, and the keys that do it.
 *
 * Where a switch *lands* is `resumeHref` in `lib/workspace-resume` — shared with
 * the command palette, so both routes into a workspace agree on where its home
 * is. What's here is the navigation and the bindings.
 *
 * ⌘1–⌘9 are no longer workspace shortcuts — they switch pane tabs instead
 * (see `pane-host.tsx`). The remaining workspace keys are:
 *
 * - **Double-⌘** — the workspace you were in before this one, ⌘-tab style.
 *   Because switching rewrites the MRU chain, tapping it again comes straight
 *   back, so the gesture ping-pongs without any special-casing.
 * - **⌘⇧1–⌘⇧9** — jump to the Nth workspace in the sidebar's tree order.
 */
export function useWorkspaceSwitch({
  visits,
  byWorkspace,
  activeWorkspaceId,
  ordered,
  onNavigate,
}: UseWorkspaceSwitchOptions): WorkspaceSwitch {
  const navigate = useNavigate()

  const hrefFor = useCallback(
    (workspaceId: string) =>
      resumeHref(workspaceId, byWorkspace.get(workspaceId) ?? [], visits.visits),
    [byWorkspace, visits.visits]
  )

  const switchTo = useCallback(
    (workspaceId: string) => {
      navigate(hrefFor(workspaceId))
      onNavigate()
    },
    [navigate, hrefFor, onNavigate]
  )

  // ── Double-⌘ → previous workspace ─────────────────────────────────────────
  const mruTarget = useRef({ mru: visits.mru, activeWorkspaceId, switchTo })
  mruTarget.current = { mru: visits.mru, activeWorkspaceId, switchTo }

  useEffect(() => {
    // A tap is ⌘ down and up with nothing pressed in between. Tracking that is
    // what keeps ⌘K, ⌘B and ⌘-tab from registering as taps — all of them put
    // another key down while ⌘ is held.
    let usedAsModifier = false
    let lastTapAt = 0

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Meta" && e.key !== "Control") usedAsModifier = true
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Meta" && e.key !== "Control") return
      const clean = !usedAsModifier
      usedAsModifier = false
      if (!clean) return

      const now = Date.now()
      if (now - lastTapAt < DOUBLE_TAP_MS) {
        lastTapAt = 0
        const { mru, activeWorkspaceId: active, switchTo: go } = mruTarget.current
        // The chain's head is normally where you already are, so "previous" is
        // the first entry that isn't the current workspace.
        const previous = mru.find((id) => id !== active)
        if (previous) go(previous)
        return
      }
      lastTapAt = now
    }

    // Losing the window mid-chord (⌘-tab to another app) leaves the tracking
    // half-finished; a stale `usedAsModifier` would eat the next real tap.
    const reset = () => {
      usedAsModifier = false
      lastTapAt = 0
    }

    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", reset)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", reset)
    }
  }, [])

  // ── ⌘⇧1…⌘⇧9 switch workspace by sidebar position ────────────────────────
  // Each digit jumps to the Nth workspace in the sidebar's tree order (the same
  // order the rail displays), so ⌘⇧1 is the top row and ⌘⇧9 the ninth.
  // Desktop only: in a browser ⌘⇧+digit belongs to the browser.
  const orderedRef = useRef(ordered)
  orderedRef.current = ordered

  useEffect(() => {
    if (!isElectron) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || !e.shiftKey) return
      const digit = Number(e.key)
      if (!Number.isInteger(digit) || digit < 1 || digit > 9) return

      const target = orderedRef.current[digit - 1]
      if (!target) return

      e.preventDefault()
      mruTarget.current.switchTo(target.id)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return useMemo(() => ({ switchTo, hrefFor }), [switchTo, hrefFor])
}
