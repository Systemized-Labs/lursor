/**
 * The model behind the schedule picker: a cron string ⇄ a handful of named fields.
 *
 * `0 9 * * 1-5` is a fine thing to *store* and a terrible thing to ask someone to
 * type — the fields are unlabelled, positional, and two of them mean days, so the
 * common mistakes (day-of-month where day-of-week goes, an hour in the minute slot)
 * produce a valid expression that fires at the wrong time. The picker asks the
 * question people actually have in their head — how often, and when — and this
 * module is the translation in both directions.
 *
 * Round-tripping is the part that matters. `parseCron` recognizes the shapes the
 * picker can express and hands back the fields that produced them, so opening an
 * existing schedule lands you on the right control rather than in the raw text box.
 * Anything it doesn't recognize is reported as `custom` rather than approximated:
 * silently rewriting someone's expression into the nearest one we understand would
 * change when their agent runs, which is the one thing this must never do.
 *
 * Nothing here validates. The server owns that (`backend/app/cron.py`), and the
 * occurrence preview it computes is what the user actually checks against.
 */

export type CronFrequency =
  | "minutes"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "custom"

export interface CronDraft {
  frequency: CronFrequency
  /** Minute of the hour, 0–59. */
  minute: number
  /** Hour of the day, 0–23. */
  hour: number
  /** Step for `minutes` (every N minutes) and `hourly` (every N hours). */
  interval: number
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[]
  /** Day of the month, 1–31. */
  monthDay: number
  /** The raw expression. Authoritative only when `frequency` is `custom`. */
  expression: string
}

// Steps that divide the hour evenly. A step like 7 restarts at the top of every
// hour, so the gap between the last fire and the first of the next hour is short
// and the schedule doesn't mean what its label says.
export const MINUTE_INTERVALS = [5, 10, 15, 20, 30]

/** Steps that divide the day evenly, for the same reason. */
export const HOUR_INTERVALS = [1, 2, 3, 4, 6, 8, 12]

/**
 * Where the step lands when a frequency is chosen and the one carried over from
 * the last one is meaningless in it.
 *
 * `interval` is one field doing two jobs, so switching Hourly → Minutes would
 * otherwise inherit its 1 and quietly propose an agent run *every minute*. The
 * cheap default belongs on the expensive side of that mistake.
 */
export function defaultInterval(frequency: CronFrequency, current: number): number {
  if (frequency === "minutes") {
    return MINUTE_INTERVALS.includes(current) ? current : 15
  }
  if (frequency === "hourly") {
    return HOUR_INTERVALS.includes(current) ? current : 1
  }
  return current
}

/** Offered minutes. Anything else is what the custom expression is for. */
export const MINUTE_CHOICES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]

export const WEEKDAYS: { value: number; short: string; long: string }[] = [
  { value: 0, short: "Sun", long: "Sunday" },
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
]

/** Where an unrecognized expression starts from when you switch off custom. */
const SEED: CronDraft = {
  frequency: "daily",
  minute: 0,
  hour: 9,
  interval: 1,
  weekdays: [1],
  monthDay: 1,
  expression: "0 9 * * *",
}

const DAY_TOKENS: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** A plain integer field within range, or null if it is anything else. */
function integerField(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null
  const value = Number(field)
  return value >= min && value <= max ? value : null
}

/** The step in a bare step field (star, slash, number), or null. */
function stepField(field: string): number | null {
  const match = /^\*\/(\d+)$/.exec(field)
  if (!match) return null
  const value = Number(match[1])
  return value >= 1 ? value : null
}

/** One day-of-week token — a digit (7 meaning Sunday) or a three-letter name. */
function dayToken(token: string): number | null {
  const text = token.trim().toLowerCase()
  if (/^\d+$/.test(text)) {
    const value = Number(text)
    return value >= 0 && value <= 7 ? value % 7 : null
  }
  return text in DAY_TOKENS ? DAY_TOKENS[text] : null
}

/**
 * A day-of-week field as the set of days it selects, or null if it isn't a plain
 * list of days and ranges (`1-5`, `mon,thu`, `5-1` wrapping over the weekend).
 */
function parseWeekdays(field: string): number[] | null {
  if (field === "*") return null
  const days = new Set<number>()
  for (const part of field.split(",")) {
    const bounds = part.split("-").map(dayToken)
    if (bounds.length > 2 || bounds.some((bound) => bound === null)) return null
    const start = bounds[0] as number
    const end = bounds[bounds.length - 1] as number
    if (start <= end) {
      for (let day = start; day <= end; day++) days.add(day)
    } else {
      // A range that wraps the week, e.g. Friday through Monday.
      for (let day = start; day <= 6; day++) days.add(day)
      for (let day = 0; day <= end; day++) days.add(day)
    }
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : null
}

/** The expression a draft describes. Total: every draft yields something. */
export function buildCron(draft: CronDraft): string {
  const minute = clamp(draft.minute, 0, 59)
  const hour = clamp(draft.hour, 0, 23)
  switch (draft.frequency) {
    case "minutes":
      return `*/${clamp(draft.interval, 1, 59)} * * * *`
    case "hourly": {
      const step = clamp(draft.interval, 1, 23)
      return step > 1 ? `${minute} */${step} * * *` : `${minute} * * * *`
    }
    case "daily":
      return `${minute} ${hour} * * *`
    case "weekly": {
      // An empty selection would silently become "every day"; the picker keeps at
      // least one day on, and this is the belt to that pair of braces.
      const days = [...new Set(draft.weekdays)].sort((a, b) => a - b)
      return `${minute} ${hour} * * ${(days.length > 0 ? days : [1]).join(",")}`
    }
    case "monthly":
      return `${minute} ${hour} ${clamp(draft.monthDay, 1, 31)} * *`
    default:
      return draft.expression.trim()
  }
}

/**
 * The draft an expression came from, falling back to `custom` when the expression
 * is richer than the picker (a month field, a list of hours, a `L` or `#`).
 *
 * Unrecognized doesn't mean invalid — it means "edit this as text", and the
 * numeric fields still carry the seed values the structured controls start from
 * if the user switches to one.
 */
export function parseCron(expression: string): CronDraft {
  const raw = (expression ?? "").trim()
  const custom: CronDraft = { ...SEED, frequency: "custom", expression: raw }
  const fields = raw.split(/\s+/)
  if (fields.length !== 5) return custom

  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields
  if (month !== "*") return custom
  const base: CronDraft = { ...SEED, expression: raw }
  const everyDay = dayOfMonth === "*" && dayOfWeek === "*"

  const minuteStep = stepField(minuteField)
  if (minuteStep !== null && hourField === "*" && everyDay) {
    return { ...base, frequency: "minutes", interval: minuteStep }
  }

  const minute = integerField(minuteField, 0, 59)
  if (minute === null) return custom

  if (everyDay && hourField === "*") {
    return { ...base, frequency: "hourly", minute, interval: 1 }
  }
  const hourStep = stepField(hourField)
  if (everyDay && hourStep !== null) {
    return { ...base, frequency: "hourly", minute, interval: hourStep }
  }

  const hour = integerField(hourField, 0, 23)
  if (hour === null) return custom

  if (everyDay) return { ...base, frequency: "daily", minute, hour }

  if (dayOfMonth === "*") {
    const weekdays = parseWeekdays(dayOfWeek)
    return weekdays
      ? { ...base, frequency: "weekly", minute, hour, weekdays }
      : custom
  }

  if (dayOfWeek === "*") {
    const monthDay = integerField(dayOfMonth, 1, 31)
    if (monthDay !== null) {
      return { ...base, frequency: "monthly", minute, hour, monthDay }
    }
  }

  return custom
}

/** A time of day in the viewer's locale — "9:00 AM" or "09:00". */
export function formatTimeOfDay(hour: number, minute: number): string {
  const at = new Date(2000, 0, 1, clamp(hour, 0, 23), clamp(minute, 0, 59))
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(at)
  } catch {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  }
}

/** An hour on its own, for the hour picker — "9 AM" or "09". */
export function formatHour(hour: number): string {
  const at = new Date(2000, 0, 1, clamp(hour, 0, 23), 0)
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(at)
  } catch {
    return `${String(hour).padStart(2, "0")}:00`
  }
}

function ordinal(value: number): string {
  const tens = value % 100
  if (tens >= 11 && tens <= 13) return `${value}th`
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[value % 10] ?? "th"
  return `${value}${suffix}`
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

function describeWeekdays(weekdays: number[]): string {
  const days = [...new Set(weekdays)].sort((a, b) => a - b)
  const key = days.join(",")
  if (key === "0,1,2,3,4,5,6") return "Every day"
  if (key === "1,2,3,4,5") return "Every weekday"
  if (key === "0,6") return "Every weekend day"
  return `Every ${joinNames(days.map((day) => `${WEEKDAYS[day].long}`))}`
}

/**
 * A draft in a sentence, for the line under the controls.
 *
 * Derived from the structured fields rather than from the expression, so it can
 * only ever describe something the picker itself built — a wrong plain-English
 * gloss on a hand-written cron string would be worse than none. Custom returns
 * null and leans on the occurrence preview instead.
 */
export function describeDraft(draft: CronDraft): string | null {
  const time = formatTimeOfDay(draft.hour, draft.minute)
  const past = `:${String(clamp(draft.minute, 0, 59)).padStart(2, "0")}`
  switch (draft.frequency) {
    case "minutes": {
      const step = clamp(draft.interval, 1, 59)
      return step === 1 ? "Every minute" : `Every ${step} minutes`
    }
    case "hourly": {
      const step = clamp(draft.interval, 1, 23)
      return step > 1
        ? `Every ${step} hours, at ${past} past`
        : `Every hour, at ${past} past`
    }
    case "daily":
      return `Every day at ${time}`
    case "weekly":
      return `${describeWeekdays(draft.weekdays)} at ${time}`
    case "monthly":
      return `On the ${ordinal(clamp(draft.monthDay, 1, 31))} of every month at ${time}`
    default:
      return null
  }
}

/** The same sentence straight from an expression, for read-only surfaces. */
export function describeCron(expression: string): string | null {
  return describeDraft(parseCron(expression))
}
