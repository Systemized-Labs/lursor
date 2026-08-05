import { useCallback, useEffect, useRef, useState } from "react"

import {
  readThemeSchedule,
  THEME_SCHEDULE_EVENT,
  THEME_SCHEDULE_STORAGE_KEY,
  writeThemeSchedule,
  type ThemeSchedule,
} from "@/lib/theme-schedule"

/**
 * Reads and writes the time-of-day theme schedule. State is seeded from
 * localStorage and persisted on every change; a `storage` listener keeps other
 * tabs in sync and {@link THEME_SCHEDULE_EVENT} keeps every hook instance in
 * *this* tab in sync. Applying the schedule is the scheduler's job — see
 * {@link file://../components/theme-scheduler.tsx}.
 */
export function useThemeSchedule() {
  const [schedule, setScheduleState] = useState<ThemeSchedule>(readThemeSchedule)
  // Mirrors state so the functional setter form stays side-effect free.
  const latest = useRef(schedule)
  latest.current = schedule

  const setSchedule = useCallback(
    (next: ThemeSchedule | ((prev: ThemeSchedule) => ThemeSchedule)) => {
      const resolved = typeof next === "function" ? next(latest.current) : next
      latest.current = resolved
      setScheduleState(resolved)
      writeThemeSchedule(resolved)
    },
    [],
  )

  useEffect(() => {
    // Same tab: adopt the writer's own object. Re-reading storage here would
    // normalize away an in-progress edit (e.g. a momentarily blank time field)
    // and delete the row the user is typing into. The writer itself lands on
    // the identical reference, so React bails out of that render.
    function onLocal(e: Event) {
      const next = (e as CustomEvent<ThemeSchedule>).detail
      setScheduleState(next ?? readThemeSchedule())
    }
    // Another tab: storage is all we have, and normalizing it is correct.
    function onStorage(e: StorageEvent) {
      if (e.key !== THEME_SCHEDULE_STORAGE_KEY) return
      setScheduleState(readThemeSchedule())
    }
    window.addEventListener("storage", onStorage)
    window.addEventListener(THEME_SCHEDULE_EVENT, onLocal)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener(THEME_SCHEDULE_EVENT, onLocal)
    }
  }, [])

  return { schedule, setSchedule }
}
