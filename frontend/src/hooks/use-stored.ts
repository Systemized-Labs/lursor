import { useCallback, useEffect, useRef, useState } from "react"
import type { Dispatch, SetStateAction } from "react"

/**
 * localStorage-backed state, for the sidebar's and the pane layer's device
 * preferences.
 *
 * Four hooks used to hand-roll the same three things — a guarded read on mount, a
 * guarded write when the value changes, and a `toggle` over a `Set<string>`. Two of
 * them (`use-pins`, `use-collapsed-projects`) had byte-identical `load` functions.
 * The storage plumbing lives here now; everything that is actually *about* pins or
 * collapsed projects or saved layouts stays in its own hook.
 *
 * **Every read and write is best-effort.** localStorage throws on a full quota and
 * is absent outright in a private window on some browsers, and none of what is kept
 * here is worth a broken screen: absence means "the default", and a failed write
 * means the preference does not survive the reload. Nothing stored through this is
 * data the user would miss — see the note in `use-pins` on why pins in particular
 * are allowed to be device-local.
 *
 * The pane *layout* does not use this. It is written from dockview's own change
 * event rather than from a state value, and it has a migration path to read through
 * (see `readLayout` in `use-pane-layout`).
 */

/** A raw string from storage, or null when absent or unreadable. */
export function readStored(key: string): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Write a raw string. Silent on failure — see the note above. */
export function writeStored(key: string, value: string): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Ignore quota / disabled-storage errors.
  }
}

/**
 * Write `value` to `key` when it diverges from what storage already holds.
 *
 * Not writing back what was just read is the point. A mount write is harmless in
 * itself, but it stamps a default into storage before the user has touched anything,
 * and then "has this ever been set" stops being a question anyone can ask.
 * `use-collapsed-projects` had grown a guard for that; `use-pins` had not.
 *
 * **Tracking the stored value, rather than skipping "the first run".** A
 * `hydrated` ref is the obvious way to write this and it does not work: StrictMode
 * deliberately double-invokes effects, so the second invocation finds the ref
 * already set and writes the default anyway. Measured, not assumed — `lursor:pins`
 * and `lursor:projects-collapsed` both came back as `[]` on a clean first load with
 * the ref version in place.
 *
 * Comparing values instead is immune to that, and it stays correct in the case a
 * "skip the first write" guard would also get wrong: toggling a preference back to
 * its default writes, because `[]` differs from what storage holds by then.
 */
function useWriteOnChange(key: string, value: string): void {
  // What storage holds, as far as this hook knows. Seeded from the first `value`,
  // which is derived from the read — so an absent key and an empty set start out
  // agreeing, and neither is written.
  const stored = useRef<string | undefined>(undefined)
  if (stored.current === undefined) stored.current = value

  useEffect(() => {
    if (value === stored.current) return
    stored.current = value
    writeStored(key, value)
  }, [key, value])
}

/**
 * A `Set<string>` in storage, as a JSON array of strings.
 *
 * Absence means empty, and so does anything that does not parse as an array — a
 * membership set has no partial state worth salvaging, and refusing to load a
 * corrupt one would leave the sidebar with no way back short of devtools.
 *
 * Returns the set, a `toggle`, and an `update` for the bulk edits that are specific
 * to one caller (`use-pins`' prune). `toggle` covers the common case; `update` is
 * the escape hatch and takes the previous set, so a caller can decide not to change
 * anything by returning it unchanged.
 */
export function useStoredSet(
  key: string
): [Set<string>, (id: string) => void, (next: (prev: Set<string>) => Set<string>) => void] {
  const [ids, setIds] = useState<Set<string>>(() => {
    const raw = readStored(key)
    if (!raw) return new Set()
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return new Set()
      return new Set(parsed.filter((id): id is string => typeof id === "string"))
    } catch {
      return new Set()
    }
  })

  useWriteOnChange(key, JSON.stringify([...ids]))

  const toggle = useCallback((id: string) => {
    setIds((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const update = useCallback((next: (prev: Set<string>) => Set<string>) => {
    setIds(next)
  }, [])

  return [ids, toggle, update]
}

/**
 * A JSON value in storage, validated on read.
 *
 * `parse` is handed whatever `JSON.parse` produced and returns the value or null;
 * null and a parse failure both fall back to `fallback`. Validating on the way in
 * rather than trusting the cast is what stops a key written by an older version —
 * or edited by hand — from reaching a component as the wrong shape.
 *
 * The setter takes React's `SetStateAction`, so callers keep their functional
 * updates: reading the current value to derive the next one is how "delete this
 * saved layout" is written, and it must not race against another update.
 */
export function useStoredJson<T>(
  key: string,
  parse: (raw: unknown) => T | null,
  fallback: T
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const raw = readStored(key)
    if (!raw) return fallback
    try {
      return parse(JSON.parse(raw)) ?? fallback
    } catch {
      return fallback
    }
  })

  useWriteOnChange(key, JSON.stringify(value))

  return [value, setValue]
}
