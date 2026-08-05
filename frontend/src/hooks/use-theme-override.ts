import { useCallback, useEffect, useState } from "react"

import {
  readThemeOverride,
  THEME_OVERRIDE_EVENT,
  THEME_OVERRIDE_STORAGE_KEY,
  writeThemeOverride,
  type ThemeOverride,
} from "@/lib/theme-schedule"

/**
 * Tracks the hand-picked theme that is currently holding the schedule off.
 * Mirrors {@link file://./use-theme-schedule.ts}: same-tab writes arrive on a
 * custom event, other tabs via `storage`.
 *
 * Note this only reports whether an override *exists* — it does not expire on a
 * timer. The scheduler is what notices the lapse and resumes, and its own tick
 * re-reads storage; consumers here just re-render when that clears the record.
 */
export function useThemeOverride() {
  const [override, setOverrideState] = useState<ThemeOverride | null>(readThemeOverride)

  const clearOverride = useCallback(() => {
    writeThemeOverride(null)
  }, [])

  useEffect(() => {
    function onLocal(e: Event) {
      setOverrideState((e as CustomEvent<ThemeOverride | null>).detail ?? null)
    }
    function onStorage(e: StorageEvent) {
      if (e.key !== THEME_OVERRIDE_STORAGE_KEY) return
      setOverrideState(readThemeOverride())
    }
    window.addEventListener(THEME_OVERRIDE_EVENT, onLocal)
    window.addEventListener("storage", onStorage)
    return () => {
      window.removeEventListener(THEME_OVERRIDE_EVENT, onLocal)
      window.removeEventListener("storage", onStorage)
    }
  }, [])

  return { override, clearOverride }
}
