import { useEffect, useMemo, useState } from "react"
import { useTheme } from "next-themes"
import { Plus, X } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
 * same trick the theme picker uses for its list rows.
 */
function ThemeDot({ value }: { value: string }) {
  return (
    <span className={cn(value, "inline-flex")}>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-background">
        <span className="h-4 w-2 bg-primary" />
      </span>
    </span>
  )
}

/** The next slot boundary, phrased for the footer hint. */
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
 * Theme cycling by time of day. The user builds a list of "at this time, use
 * this theme" slots — two of them is the classic light-by-day / dark-by-night
 * setup, more of them rotate through as many themes as they like. Application
 * is handled by {@link file://../../components/theme-scheduler.tsx}.
 */
export function ThemeScheduleSection() {
  const { schedule, setSchedule } = useThemeSchedule()
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

  function toggleEnabled(enabled: boolean) {
    setSchedule((prev) => ({ ...prev, enabled }))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Theme schedule</CardTitle>
        <CardDescription>
          Cycle themes by time of day — light in the morning, dark at night, or any
          rotation you like.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="flex items-start justify-between gap-4 sm:max-w-md">
          <div className="grid gap-1">
            <Label htmlFor="theme-schedule-enabled">Cycle themes automatically</Label>
            <p className="text-xs text-muted-foreground">
              Picking a theme by hand still works — it holds until the next scheduled
              change.
            </p>
          </div>
          <Switch
            id="theme-schedule-enabled"
            checked={schedule.enabled}
            onCheckedChange={toggleEnabled}
          />
        </div>

        {schedule.enabled && (
          <>
            <div className="grid gap-2">
              <Label>Presets</Label>
              <div className="flex flex-wrap gap-2">
                {SCHEDULE_PRESETS.map((preset) => (
                  <Button
                    key={preset.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    title={preset.description}
                    onClick={() => applyPreset(preset.id)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>

            <div className="grid gap-2">
              <Label>Schedule</Label>
              <div className="grid gap-2">
                {schedule.slots.map((slot) => (
                  <div key={slot.id} className="flex items-center gap-2">
                    <Input
                      type="time"
                      aria-label="Start time"
                      value={slot.start}
                      aria-invalid={parseTime(slot.start) === null}
                      onChange={(e) => updateSlot(slot.id, { start: e.target.value })}
                      onBlur={sortSlots}
                      className={cn(
                        "h-9 w-[7.5rem] shrink-0",
                        parseTime(slot.start) === null &&
                          "border-destructive/60 focus-visible:border-destructive/60",
                      )}
                    />
                    <Select
                      value={slot.theme}
                      onValueChange={(theme) => {
                        updateSlot(slot.id, { theme })
                        // Editing the slot that's live right now should show up at once.
                        if (active?.id === slot.id) setTheme(theme)
                      }}
                    >
                      <SelectTrigger className="h-9 min-w-0 flex-1" aria-label="Theme">
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
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addSlot}
                  disabled={schedule.slots.length >= MAX_SCHEDULE_SLOTS}
                >
                  <Plus className="h-4 w-4" />
                  Add time
                </Button>
                {schedule.slots.length >= MAX_SCHEDULE_SLOTS && (
                  <span className="text-xs text-muted-foreground">
                    Maximum of {MAX_SCHEDULE_SLOTS} entries.
                  </span>
                )}
              </div>
              {schedule.slots.some((s) => parseTime(s.start) === null) && (
                <p className="text-xs text-destructive">
                  Entries without a valid time are ignored.
                </p>
              )}
            </div>

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
          </>
        )}
      </CardContent>
    </Card>
  )
}

function themeLabel(value: string): string {
  return THEME_OPTIONS.find((t) => t.value === value)?.label ?? value
}
