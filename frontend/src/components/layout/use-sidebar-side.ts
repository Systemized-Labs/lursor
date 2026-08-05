import { useCallback, useState } from "react"

import { readStored, writeStored } from "@/hooks/use-stored"

const STORAGE_KEY = "lursor:sidebar-side"

export type SidebarSide = "left" | "right"

/**
 * Which edge the sessions sidebar is anchored to.
 *
 * A device preference, like the sidebar's width — kept in localStorage rather than
 * on the server, because which hand you keep your navigation on is about the screen
 * you are looking at.
 *
 * **Outside dockview**, per the resolved open question 6. The reference UI makes the
 * sidebar a draggable pane and gets the side swap as native drag; we deliberately
 * do not, because the app's primary navigation should not be closeable or droppable
 * into a tab strip by accident. The cost is this hook and a DOM-order flip in the
 * shell; the benefit is that the sidebar cannot be lost, and that Phases 1 and 3
 * never had to wait on the pane layer.
 *
 * DOM order rather than `flex-direction: row-reverse`: reversing the visual order
 * of a flex row leaves tab order and screen-reader order pointing the old way, so
 * the sidebar would still be read *after* the content while appearing before it.
 *
 * Stored as a **bare string**, not JSON, which is why this uses `readStored` and
 * `writeStored` rather than `useStoredJson` like its neighbours: `JSON.parse("right")`
 * throws, so moving the format would quietly reset the preference for everyone who
 * has already set it. The two-line saving is not worth that. Writing from the setter
 * rather than from an effect is deliberate for the same reason it is elsewhere —
 * nothing should be written until something is actually chosen.
 */
export function useSidebarSide(): [SidebarSide, (side: SidebarSide) => void] {
  const [side, setSideState] = useState<SidebarSide>(() =>
    readStored(STORAGE_KEY) === "right" ? "right" : "left"
  )

  const setSide = useCallback((next: SidebarSide) => {
    setSideState(next)
    writeStored(STORAGE_KEY, next)
  }, [])

  return [side, setSide]
}
