import { useEffect, useMemo, useState } from "react"
import { useTheme } from "next-themes"
import { CalendarBlank, Plus, X } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useThemeOverride } from "@/hooks/use-theme-override"
import { useThemeSchedule } from "@/hooks/use-theme-schedule"
import {
  activeSlotAt,
  createSlot,
  formatTime,
  formatTimeLabel,
  MAX_SCHEDULE_SLOTS,
  nextChangeAt,
  parseTime,
  SCHEDULE_PRESETS,
  slotsFromPreset,
  sortedValidSlots,
  type ThemeScheduleSlot,
} from "@/lib/theme-schedule"
import { THEME_OPTIONS, type ThemeOption } from "@/lib/themes"
import { cn } from "@/lib/utils"

/** Slots name a concrete theme — `system` would just defer the decision again. */
const SLOT_THEMES: ThemeOption[] = THEME_OPTIONS.filter((t) => t.value !== "system")

const THEME_GROUPS: { label: string; mode: "light" | "dark" }[] = [
  { label: "Light", mode: "light" },
  { label: "Dark", mode: "dark" },
]

/**
 * A tiny live swatch: real tokens rendered under the target theme's class, the
 * same trick the theme list uses for its rows.
 *
 * The theme's `background` is the dominant colour with `primary` as a pip
 * inside. Leading with `primary` reads inverted — a light theme's primary is
 * near-black, so the swatch for "Light" came out dark.
 */
function ThemeDot({ value }: { value: string }) {
  return (
    <span className={cn(value, "inline-flex")}>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border bg-background">
        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
      </span>
    </span>
  )
}

/** Recomputes the active/next slot as the clock moves. */
function useNextChange(enabled: boolean, slots: ThemeScheduleSlot[]) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [enabled])

  return useMemo(() => {
    const schedule = { enabled: true, slots }
    const active = activeSlotAt(schedule, now)
    // With a single slot there is no "then" to announce — it never changes.
    const hasCycle = sortedValidSlots(schedule).length > 1
    const next = hasCycle ? nextChangeAt(schedule, now)?.slot : undefined
    return { active, next }
  }, [slots, now])
}

/**
 * The Schedule tab of the theme dialog: theme cycling by time of day. The user
 * builds a list of "at this time, use this theme" slots — two of them is the
 * classic light-by-day / dark-by-night setup, more of them rotate through as
 * many themes as they like.
 *
 * Only editing lives here. Applying the schedule is the scheduler's job, see
 * {@link file://../theme-scheduler.tsx}.
 */
export function ThemeSchedulePanel() {
  const { schedule, setSchedule } = useThemeSchedule()
  const { override, clearOverride } = useThemeOverride()
  const { setTheme } = useTheme()
  const { active, next } = useNextChange(schedule.enabled, schedule.slots)

  function updateSlot(id: string, patch: Partial<ThemeScheduleSlot>) {
    setSchedule((prev) => ({
      ...prev,
      slots: prev.slots.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }))
  }

  /**
   * Rows render in stored order and are only re-sorted once a time edit is
   * committed. Sorting on every keystroke would reshuffle the list mid-edit —
   * a half-typed time reads as invalid and jumps the row to the top.
   */
  function sortSlots() {
    setSchedule((prev) => ({
      ...prev,
      slots: [...prev.slots].sort(
        (a, b) => (parseTime(a.start) ?? -1) - (parseTime(b.start) ?? -1),
      ),
    }))
  }

  function removeSlot(id: string) {
    setSchedule((prev) => ({ ...prev, slots: prev.slots.filter((s) => s.id !== id) }))
  }

  function addSlot() {
    setSchedule((prev) => {
      if (prev.slots.length >= MAX_SCHEDULE_SLOTS) return prev
      // Drop the new slot an hour after the latest one, wrapping at midnight.
      const latest = prev.slots.reduce((max, s) => Math.max(max, parseTime(s.start) ?? 0), -1)
      const start = formatTime(latest < 0 ? 12 * 60 : latest + 60)
      const theme = prev.slots[prev.slots.length - 1]?.theme === "dark" ? "light" : "dark"
      return { ...prev, slots: [...prev.slots, createSlot(start, theme)] }
    })
  }

  function applyPreset(presetId: string) {
    const preset = SCHEDULE_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    setSchedule((prev) => ({ ...prev, slots: slotsFromPreset(preset) }))
  }

  /**
   * Editing the schedule leaves a hand-picked theme alone — it would be jarring
   * to lose the theme you are looking at because you nudged a time. Flipping the
   * feature itself is different: it's an explicit "take over" / "stop", so any
   * held override goes with it.
   */
  function toggleEnabled(enabled: boolean) {
    clearOverride()
    setSchedule((prev) => ({ ...prev, enabled }))
  }

  const hasInvalidTime = schedule.slots.some((s) => parseTime(s.start) === null)

  return (
    <div className="space-y-4 p-4">
      {/* Enable */}
      <label
        htmlFor="theme-schedule-enabled"
        className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-border bg-muted/30 p-3"
      >
        <span className="grid gap-1">
          <span className="text-sm font-medium text-foreground">Cycle by time of day</span>
          <span className="text-xs text-muted-foreground">
            Switch themes automatically as the day goes on.
          </span>
        </span>
        <Switch
          id="theme-schedule-enabled"
          checked={schedule.enabled}
          onCheckedChange={toggleEnabled}
        />
      </label>

      {!schedule.enabled ? (
        <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
          <CalendarBlank className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-foreground">No schedule running</p>
          <p className="text-xs text-muted-foreground">
            Turn cycling on to set light for the morning, dark for the evening, or any
            rotation you like.
          </p>
        </div>
      ) : (
        <>
          {/* Presets */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Start from a preset</p>
            <div className="flex flex-wrap gap-1.5">
              {SCHEDULE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  title={preset.description}
                  onClick={() => applyPreset(preset.id)}
                  className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Slots */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Switch at</p>
            <div className="space-y-1.5">
              {schedule.slots.map((slot) => {
                const isLive = active?.id === slot.id
                return (
                  <div key={slot.id} className="flex items-center gap-1.5">
                    <Input
                      type="time"
                      aria-label="Start time"
                      value={slot.start}
                      aria-invalid={parseTime(slot.start) === null}
                      onChange={(e) => updateSlot(slot.id, { start: e.target.value })}
                      onBlur={sortSlots}
                      className={cn(
                        "h-9 w-[7.25rem] shrink-0 tabular-nums",
                        parseTime(slot.start) === null &&
                          "border-destructive/60 focus-visible:border-destructive/60",
                      )}
                    />
                    <Select
                      value={slot.theme}
                      onValueChange={(theme) => {
                        updateSlot(slot.id, { theme })
                        // Editing the slot that's live right now should show up at
                        // once — unless a hand-picked theme is holding the floor.
                        if (isLive && !override) setTheme(theme)
                      }}
                    >
                      <SelectTrigger
                        className={cn("h-9 min-w-0 flex-1", isLive && "ring-1 ring-primary/40")}
                        aria-label="Theme"
                      >
                        <SelectValue placeholder="Select a theme" />
                      </SelectTrigger>
                      <SelectContent>
                        {THEME_GROUPS.map((group) => (
                          <SelectGroup key={group.mode}>
                            <SelectLabel>{group.label}</SelectLabel>
                            {SLOT_THEMES.filter((t) => t.mode === group.mode).map((t) => (
                              <SelectItem key={t.value} value={t.value}>
                                <span className="flex items-center gap-2">
                                  <ThemeDot value={t.value} />
                                  <span className="truncate">{t.label}</span>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label={`Remove ${formatTimeLabel(slot.start)} entry`}
                      disabled={schedule.slots.length <= 1}
                      onClick={() => removeSlot(slot.id)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                )
              })}
            </div>
            {hasInvalidTime && (
              <p className="text-xs text-destructive">
                Entries without a valid time are ignored.
              </p>
            )}
            <button
              type="button"
              onClick={addSlot}
              disabled={schedule.slots.length >= MAX_SCHEDULE_SLOTS}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-ring/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              {schedule.slots.length >= MAX_SCHEDULE_SLOTS
                ? `Maximum of ${MAX_SCHEDULE_SLOTS} entries`
                : "Add a time"}
            </button>
          </div>

          {/* Status */}
          <div className="rounded-lg bg-muted/40 px-3 py-2">
            {override ? (
              <p className="text-xs text-muted-foreground">
                Holding <span className="text-foreground">{themeLabel(override.theme)}</span>{" "}
                because you picked it by hand — the schedule takes over again at{" "}
                {clockLabel(override.expiresAt)}.{" "}
                <button
                  type="button"
                  onClick={clearOverride}
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  Resume now
                </button>
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {active ? (
                  <>
                    Now using <span className="text-foreground">{themeLabel(active.theme)}</span>
                    {next ? (
                      <>
                        {" "}
                        until {formatTimeLabel(next.start)}, then{" "}
                        <span className="text-foreground">{themeLabel(next.theme)}</span>.
                      </>
                    ) : (
                      "."
                    )}
                  </>
                ) : (
                  "Add at least one entry with a valid time to start cycling."
                )}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function themeLabel(value: string): string {
  return THEME_OPTIONS.find((t) => t.value === value)?.label ?? value
}

/** Epoch ms → a friendly `7:00 PM`. */
function clockLabel(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
}
