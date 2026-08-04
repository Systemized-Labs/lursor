import { useCallback, useEffect, useState } from "react"
import type { SerializedDockview } from "dockview-react"

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
 * and a "Terminal deck" you built in one repo is the one you want in the next. So
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

function load(): CustomLayout[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is CustomLayout =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as CustomLayout).id === "string" &&
        typeof (entry as CustomLayout).name === "string" &&
        typeof (entry as CustomLayout).layout === "object"
    )
  } catch {
    return []
  }
}

function newId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `l-${crypto.randomUUID()}`
    }
  } catch {
    // Fall through.
  }
  return `l-${Math.random().toString(36).slice(2)}`
}

export function useCustomLayouts(): CustomLayouts {
  const [items, setItems] = useState<CustomLayout[]>(load)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    } catch {
      // Ignore quota / disabled-storage errors — saved layouts are best-effort.
    }
  }, [items])

  const save = useCallback((name: string, layout: SerializedDockview) => {
    const trimmed = name.trim()
    if (!trimmed) return
    setItems((prev) => [
      ...prev.filter((item) => item.name !== trimmed),
      { id: newId(), name: trimmed, layout },
    ])
  }, [])

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const rename = useCallback((id: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, name: trimmed } : item))
    )
  }, [])

  return { items, save, remove, rename }
}
