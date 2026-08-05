import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"

import { useThemeOverride } from "@/hooks/use-theme-override"
import { useThemeSchedule } from "@/hooks/use-theme-schedule"
import {
  activeSlotAt,
  nextBoundaryAt,
  readThemeOverride,
  THEME_OVERRIDE_STORAGE_KEY,
  writeThemeOverride,
} from "@/lib/theme-schedule"

/**
 * Headless driver for the time-of-day theme schedule. Renders nothing; it just
 * calls next-themes' `setTheme` when the active slot changes.
 *
 * Deliberately not a tight leash: a theme the user picked by hand parks an
 * override (see `recordManualTheme`) that this loop refuses to overrule until
 * the next boundary. The schedule is a default, never a lock.
 */
export function ThemeScheduler() {
  const { setTheme } = useTheme()
  const { schedule } = useThemeSchedule()
  // Only used to re-run the effect when the override is set or cleared
  // elsewhere (a hand-picked theme, or "Resume schedule" in settings).
  const { override } = useThemeOverride()
  const appliedSlotId = useRef<string | null>(null)

  useEffect(() => {
    if (!schedule.enabled) {
      appliedSlotId.current = null
      return
    }
    // The schedule or override changed — force a fresh pass.
    appliedSlotId.current = null

    let timer: ReturnType<typeof setTimeout> | undefined

    function tick() {
      // `tick` is also called ad hoc on wake — never leave a second chain running.
      if (timer) clearTimeout(timer)
      const now = new Date()

      // A live hand-picked theme wins outright. Re-read rather than closing over
      // the value: this loop outlives any single render.
      const held = readThemeOverride(now)
      if (held) {
        appliedSlotId.current = null
        const delay = Math.max(1_000, Math.min(held.expiresAt - now.getTime() + 500, 60_000))
        timer = setTimeout(tick, delay)
        return
      }
      // Lapsed — drop the record so the UI stops advertising an override.
      if (localStorage.getItem(THEME_OVERRIDE_STORAGE_KEY)) writeThemeOverride(null)

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
  }, [schedule, override, setTheme])

  return null
}
