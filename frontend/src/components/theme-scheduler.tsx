import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"

import { useThemeSchedule } from "@/hooks/use-theme-schedule"
import { activeSlotAt, nextBoundaryAt } from "@/lib/theme-schedule"

/**
 * Headless driver for the time-of-day theme schedule. Renders nothing; it just
 * calls next-themes' `setTheme` when the active slot changes.
 *
 * Deliberately *not* a tight leash: within a slot the user stays free to pick
 * any theme by hand, and that choice survives until the next boundary (the
 * macOS auto-appearance behaviour). Editing the schedule re-applies immediately
 * so settings changes are visible as you make them.
 */
export function ThemeScheduler() {
  const { setTheme } = useTheme()
  const { schedule } = useThemeSchedule()
  const appliedSlotId = useRef<string | null>(null)

  useEffect(() => {
    if (!schedule.enabled) {
      appliedSlotId.current = null
      return
    }
    // The schedule object changed (config edit, or another tab) — force a pass.
    appliedSlotId.current = null

    let timer: ReturnType<typeof setTimeout> | undefined

    function tick() {
      // `tick` is also called ad hoc on wake — never leave a second chain running.
      if (timer) clearTimeout(timer)
      const now = new Date()
      const slot = activeSlotAt(schedule, now)
      if (slot && slot.id !== appliedSlotId.current) {
        appliedSlotId.current = slot.id
        setTheme(slot.theme)
      }
      // Wake at the boundary, but never sleep longer than a minute: laptop
      // suspend and clock changes both stretch timers unpredictably.
      const boundary = nextBoundaryAt(schedule, now)
      const untilBoundary = boundary ? boundary.getTime() - now.getTime() : Number.POSITIVE_INFINITY
      const delay = Math.max(1_000, Math.min(untilBoundary + 500, 60_000))
      timer = setTimeout(tick, delay)
    }

    tick()

    // A machine waking from sleep can skip several boundaries at once.
    function onWake() {
      if (document.visibilityState === "visible") tick()
    }
    document.addEventListener("visibilitychange", onWake)
    window.addEventListener("focus", onWake)

    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onWake)
      window.removeEventListener("focus", onWake)
    }
  }, [schedule, setTheme])

  return null
}
