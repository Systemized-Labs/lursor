import { useCallback } from "react"
import type { SerializedDockview } from "dockview-react"

import { newId } from "@/components/panes/pane-kinds"
import { useStoredJson } from "@/hooks/use-stored"

/** Saved arrangements, shared across workspaces. */
const STORAGE_KEY = "lursor:layouts:custom"

export interface CustomLayout {
  id: string
  name: string
  /** The arrangement as `toJSON()` gave it. */
  layout: SerializedDockview
}

/**
 * "Save current arrangement", and applying one back.
 *
 * **Not per workspace, deliberately.** The pane *layout* is per workspace — that is
 * what `lursor:layout:<id>` is for — but a saved arrangement is a way of working,
 * and a "Terminal below" you built in one repo is the one you want in the next. So
 * these live under a single global key.
 *
 * There is a real consequence, and it is worth stating rather than discovering: a
 * saved layout carries the *pane ids* it was saved with, and those ids belong to
 * the workspace it came from. Applying it verbatim elsewhere would resurrect panes
 * that do not exist there and drop the ones that do. So a custom layout is applied
 * the same way a built-in template is — as a *shape* re-derived over the live pane
 * set — and only its geometry is reused. See `applyCustom` in the layouts dialog.
 */
export interface CustomLayouts {
  items: CustomLayout[]
  save: (name: string, layout: SerializedDockview) => void
  remove: (id: string) => void
  rename: (id: string, name: string) => void
}

/**
 * Entries that are still the right shape, and only those.
 *
 * Per-entry rather than all-or-nothing: one malformed row — a key written by an
 * older version, or a hand edit — should cost that arrangement, not every
 * arrangement. The `layout` itself is checked no further than "it is an object",
 * because what a valid `SerializedDockview` is is dockview's question and it already
 * answers it; `fromJSON` throwing is handled where the layout is applied.
 */
function parseLayouts(raw: unknown): CustomLayout[] | null {
  if (!Array.isArray(raw)) return null
  return raw.filter(
    (entry): entry is CustomLayout =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as CustomLayout).id === "string" &&
      typeof (entry as CustomLayout).name === "string" &&
      typeof (entry as CustomLayout).layout === "object"
  )
}

export function useCustomLayouts(): CustomLayouts {
  const [items, setItems] = useStoredJson<CustomLayout[]>(
    STORAGE_KEY,
    parseLayouts,
    []
  )

  // `setItems` is in every deps list below because it now comes from a hook rather
  // than from `useState` in this file, and the lint rule cannot see through that to
  // know it is stable. It is — `useStoredJson` returns the state setter — so listing
  // it costs nothing and keeps these three genuinely stable.
  const save = useCallback(
    (name: string, layout: SerializedDockview) => {
      const trimmed = name.trim()
      if (!trimmed) return
      setItems((prev) => [
        ...prev.filter((item) => item.name !== trimmed),
        { id: newId("l"), name: trimmed, layout },
      ])
    },
    [setItems]
  )

  const remove = useCallback(
    (id: string) => {
      setItems((prev) => prev.filter((item) => item.id !== id))
    },
    [setItems]
  )

  const rename = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, name: trimmed } : item))
      )
    },
    [setItems]
  )

  return { items, save, remove, rename }
}
