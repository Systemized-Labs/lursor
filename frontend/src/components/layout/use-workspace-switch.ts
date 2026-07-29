import { useCallback, useEffect, useMemo, useRef } from "react"
import { useNavigate } from "react-router-dom"

import type { Thread } from "@/api/types"
import type { WorkspaceVisits } from "@/hooks/use-workspace-visits"
import { resumeHref } from "@/lib/workspace-resume"

/** How long a second ⌘ tap still counts as a double-tap. */
const DOUBLE_TAP_MS = 400
/** ⌘1…⌘9 — the tenth tile onward is reachable by click and ⌘K. */
const MAX_DIGIT = 9

interface UseWorkspaceSwitchOptions {
  /** Rail order, so ⌘N lines up with the Nth tile. */
  orderedIds: string[]
  visits: WorkspaceVisits
  /** Conversations bucketed by workspace, each newest-first. */
  byWorkspace: Map<string, Thread[]>
  activeWorkspaceId: string | undefined
  /**
   * A switch landed — from a tile, ⌘1…⌘9 or double-⌘ alike. Used to point the
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
 * Two bindings, because switching between a couple of repos all day is mostly
 * ping-pong between *two* of them, and that deserves a gesture rather than a
 * mouse trip to a 68px column:
 *
 * - **⌘1…⌘9** — the Nth tile, by rail position. Stable, so it can be learned.
 * - **Double-⌘** — the workspace you were in before this one, ⌘-tab style.
 *   Because switching rewrites the MRU chain, tapping it again comes straight
 *   back, so the gesture ping-pongs without any special-casing.
 */
export function useWorkspaceSwitch({
  orderedIds,
  visits,
  byWorkspace,
  activeWorkspaceId,
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

  // ── ⌘1…⌘9 ────────────────────────────────────────────────────────────────
  // Ref'd so the listener can stay mounted for the app's life instead of being
  // torn down and rebuilt every time a run finishes and reorders a thread list.
  const target = useRef({ orderedIds, switchTo })
  target.current = { orderedIds, switchTo }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      const digit = Number(e.key)
      if (!Number.isInteger(digit) || digit < 1 || digit > MAX_DIGIT) return
      const id = target.current.orderedIds[digit - 1]
      if (!id) return
      e.preventDefault()
      target.current.switchTo(id)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

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

  return useMemo(() => ({ switchTo, hrefFor }), [switchTo, hrefFor])
}
