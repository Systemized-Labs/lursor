/**
 * Theme schedule — cycle the active theme by local time of day.
 *
 * A schedule is an ordered set of *slots*, each pinning a theme to a wall-clock
 * start time. The active slot is the last one whose start has passed; before the
 * first start of the day the schedule wraps around to the final slot (so a
 * `07:00 light / 19:00 dark` pair correctly reads as "dark" at 02:00).
 *
 * Two slots is the light/dark day-night case; any number of slots gives an
 * arbitrary rotation through the theme registry (see {@link file://./themes.ts}).
 *
 * The schedule persists to `localStorage` under {@link THEME_SCHEDULE_STORAGE_KEY}.
 * next-themes still owns the *active* theme — the scheduler simply calls
 * `setTheme()` when a boundary is crossed. A matching inline script in
 * `index.html` resolves the schedule before first paint and seeds next-themes'
 * own storage key, so a scheduled theme never flashes on load; keep that script
 * in sync with {@link resolveScheduledTheme}.
 */

import { THEME_NAMES } from "@/lib/themes"

export const THEME_SCHEDULE_STORAGE_KEY = "lursor-theme-schedule"

/**
 * Fired on `window` after a write, carrying the schedule as `detail`. `storage`
 * events only reach *other* documents, so this is what keeps the settings UI and
 * the scheduler in step inside the same tab.
 *
 * Listeners must take `detail` rather than re-reading storage: a half-finished
 * edit (a cleared time field, say) is deliberately kept in memory but would be
 * normalized away on the way back out, deleting the row mid-edit.
 */
export const THEME_SCHEDULE_EVENT = "lursor:theme-schedule"

export interface ThemeScheduleSlot {
  /** Stable local id; only used to key rows and detect boundary crossings. */
  id: string
  /** Local wall-clock start time as `HH:MM` (24h). */
  start: string
  /** A concrete theme value — must be one of {@link THEME_NAMES}. */
  theme: string
}

export interface ThemeSchedule {
  enabled: boolean
  slots: ThemeScheduleSlot[]
}

/** Max slots in one schedule — a guard rail, not a meaningful limit. */
export const MAX_SCHEDULE_SLOTS = 12

let idCounter = 0

function slotId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `slot-${crypto.randomUUID()}`
  }
  idCounter += 1
  return `slot-${idCounter}-${Math.random().toString(36).slice(2, 8)}`
}

export function createSlot(start: string, theme: string): ThemeScheduleSlot {
  return { id: slotId(), start, theme }
}

// ── Time helpers ────────────────────────────────────────────────────────────

/** Parse `HH:MM` into minutes since midnight, or `null` if malformed. */
export function parseTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** Minutes since midnight → `HH:MM`. */
export function formatTime(totalMinutes: number): string {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440
  const hours = Math.floor(wrapped / 60)
  const minutes = wrapped % 60
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
}

/** `HH:MM` → a friendly `7:00 AM` for display. */
export function formatTimeLabel(value: string): string {
  const minutes = parseTime(value)
  if (minutes === null) return value
  const date = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60)
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
}

function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

// ── Presets ─────────────────────────────────────────────────────────────────

export interface SchedulePreset {
  id: string
  label: string
  description: string
  slots: { start: string; theme: string }[]
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  {
    id: "day-night",
    label: "Day / night",
    description: "Light through the day, dark after sundown.",
    slots: [
      { start: "07:00", theme: "light" },
      { start: "19:00", theme: "dark" },
    ],
  },
  {
    id: "golden-hours",
    label: "Golden hours",
    description: "Warm at the edges of the day, neutral in the middle.",
    slots: [
      { start: "06:00", theme: "golden-hour" },
      { start: "09:00", theme: "clean-slate" },
      { start: "17:00", theme: "sunset-horizon" },
      { start: "21:00", theme: "cosmic-night" },
    ],
  },
  {
    id: "deep-focus",
    label: "Deep focus",
    description: "Bright mornings, low-glare evenings, near-black at night.",
    slots: [
      { start: "07:00", theme: "arctic" },
      { start: "12:00", theme: "modern-minimal" },
      { start: "18:00", theme: "charcoal" },
      { start: "23:00", theme: "obsidian" },
    ],
  },
]

export const DEFAULT_THEME_SCHEDULE: ThemeSchedule = {
  enabled: false,
  slots: SCHEDULE_PRESETS[0].slots.map((s) => createSlot(s.start, s.theme)),
}

/** Materialise a preset into slots with fresh ids. */
export function slotsFromPreset(preset: SchedulePreset): ThemeScheduleSlot[] {
  return preset.slots.map((s) => createSlot(s.start, s.theme))
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** Slots that parse and name a real theme, in chronological order. */
export function sortedValidSlots(schedule: ThemeSchedule): ThemeScheduleSlot[] {
  return schedule.slots
    .filter((slot) => parseTime(slot.start) !== null && THEME_NAMES.includes(slot.theme))
    .sort((a, b) => (parseTime(a.start) ?? 0) - (parseTime(b.start) ?? 0))
}

/**
 * The slot in effect at `date`. Wraps around midnight: any time before the
 * earliest start belongs to the last slot of the previous day.
 */
export function activeSlotAt(schedule: ThemeSchedule, date: Date): ThemeScheduleSlot | null {
  const slots = sortedValidSlots(schedule)
  if (slots.length === 0) return null
  const now = minutesOfDay(date)
  let active = slots[slots.length - 1]
  for (const slot of slots) {
    if ((parseTime(slot.start) ?? 0) <= now) active = slot
    else break
  }
  return active
}

/** The theme the schedule wants right now, or `null` if it can't decide. */
export function resolveScheduledTheme(schedule: ThemeSchedule, date: Date): string | null {
  if (!schedule.enabled) return null
  return activeSlotAt(schedule, date)?.theme ?? null
}

export interface NextChange {
  /** The slot that takes over at {@link at}. */
  slot: ThemeScheduleSlot
  at: Date
}

/**
 * The next slot boundary after `date`, wrapping to tomorrow's earliest slot once
 * today's are exhausted. `null` if the schedule has no usable slots.
 */
export function nextChangeAt(schedule: ThemeSchedule, date: Date): NextChange | null {
  const slots = sortedValidSlots(schedule)
  if (slots.length === 0) return null
  const now = minutesOfDay(date)
  const upcoming = slots.find((slot) => (parseTime(slot.start) ?? 0) > now)
  const slot = upcoming ?? slots[0]
  const minutes = parseTime(slot.start) ?? 0
  const at = new Date(date)
  at.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  // No slot left today (or a single slot that already started) → same time tomorrow.
  if (!upcoming) at.setDate(at.getDate() + 1)
  return { slot, at }
}

/** The next moment the active slot changes, or `null` if the schedule is inert. */
export function nextBoundaryAt(schedule: ThemeSchedule, date: Date): Date | null {
  return nextChangeAt(schedule, date)?.at ?? null
}

// ── Persistence ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Coerce arbitrary parsed JSON into a usable schedule, dropping junk slots. */
export function normalizeSchedule(raw: unknown): ThemeSchedule {
  if (!isRecord(raw)) return DEFAULT_THEME_SCHEDULE
  const rawSlots = Array.isArray(raw.slots) ? raw.slots : []
  const slots: ThemeScheduleSlot[] = []
  for (const entry of rawSlots) {
    if (slots.length >= MAX_SCHEDULE_SLOTS) break
    if (!isRecord(entry)) continue
    const start = typeof entry.start === "string" ? entry.start : ""
    const theme = typeof entry.theme === "string" ? entry.theme : ""
    if (parseTime(start) === null || !THEME_NAMES.includes(theme)) continue
    const id = typeof entry.id === "string" && entry.id ? entry.id : slotId()
    slots.push({ id, start: formatTime(parseTime(start) ?? 0), theme })
  }
  if (slots.length === 0) {
    return { enabled: false, slots: DEFAULT_THEME_SCHEDULE.slots.map((s) => ({ ...s })) }
  }
  return { enabled: raw.enabled === true, slots }
}

export function readThemeSchedule(): ThemeSchedule {
  if (typeof localStorage === "undefined") return DEFAULT_THEME_SCHEDULE
  try {
    const stored = localStorage.getItem(THEME_SCHEDULE_STORAGE_KEY)
    if (!stored) return { ...DEFAULT_THEME_SCHEDULE, slots: DEFAULT_THEME_SCHEDULE.slots.map((s) => ({ ...s })) }
    return normalizeSchedule(JSON.parse(stored))
  } catch {
    return DEFAULT_THEME_SCHEDULE
  }
}

export function writeThemeSchedule(schedule: ThemeSchedule): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(THEME_SCHEDULE_STORAGE_KEY, JSON.stringify(schedule))
  } catch {
    // Storage full or blocked — the in-memory schedule still drives this session.
  }
  window.dispatchEvent(new CustomEvent<ThemeSchedule>(THEME_SCHEDULE_EVENT, { detail: schedule }))
}

// ── Manual override ─────────────────────────────────────────────────────────
/**
 * A schedule must never take the theme away from someone who just picked one.
 * Choosing a theme by hand while the schedule is on parks an override that
 * holds until the schedule's *next* boundary — the macOS auto-appearance rule.
 *
 * It has to be persisted rather than kept in memory: the pre-paint script would
 * otherwise stomp the hand-picked theme on the next reload, and a schedule edit
 * would revert it. Expiry is stored as an absolute timestamp so a reload (or a
 * few hours asleep) resolves it correctly without any elapsed-time bookkeeping.
 */

export const THEME_OVERRIDE_STORAGE_KEY = "lursor-theme-override"

/** Fired on `window` when the override is set or cleared; `detail` is the new value. */
export const THEME_OVERRIDE_EVENT = "lursor:theme-override"

export interface ThemeOverride {
  theme: string
  /** Epoch ms at which the schedule takes back control. */
  expiresAt: number
}

/** The live override, or `null` if there is none or it has lapsed. */
export function readThemeOverride(now: Date = new Date()): ThemeOverride | null {
  if (typeof localStorage === "undefined") return null
  try {
    const stored = localStorage.getItem(THEME_OVERRIDE_STORAGE_KEY)
    if (!stored) return null
    const raw: unknown = JSON.parse(stored)
    if (!isRecord(raw)) return null
    const theme = typeof raw.theme === "string" ? raw.theme : ""
    const expiresAt = typeof raw.expiresAt === "number" ? raw.expiresAt : 0
    if (!THEME_NAMES.includes(theme) || !Number.isFinite(expiresAt)) return null
    if (expiresAt <= now.getTime()) return null
    return { theme, expiresAt }
  } catch {
    return null
  }
}

/** Persist an override, or clear it by passing `null`. */
export function writeThemeOverride(override: ThemeOverride | null): void {
  if (typeof localStorage === "undefined") return
  try {
    if (override) {
      localStorage.setItem(THEME_OVERRIDE_STORAGE_KEY, JSON.stringify(override))
    } else {
      localStorage.removeItem(THEME_OVERRIDE_STORAGE_KEY)
    }
  } catch {
    // Storage blocked — the schedule simply reasserts itself sooner.
  }
  window.dispatchEvent(
    new CustomEvent<ThemeOverride | null>(THEME_OVERRIDE_EVENT, { detail: override }),
  )
}

/**
 * Record a hand-picked theme. A no-op unless a schedule is actually running —
 * with no schedule there is nothing to override, and next-themes already
 * remembers the choice on its own.
 */
export function recordManualTheme(theme: string, now: Date = new Date()): void {
  const schedule = readThemeSchedule()
  if (!schedule.enabled) return
  const boundary = nextChangeAt(schedule, now)
  if (!boundary) return
  writeThemeOverride({ theme, expiresAt: boundary.at.getTime() })
}
