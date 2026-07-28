import type { Schedule, ScheduleFireStatus, ScheduleRun } from "@/api/types"

/**
 * A handful of expressions covering what people actually schedule, so the common
 * case is a click and the text field is for everything else. Deliberately short:
 * a long menu is a cron builder in disguise, and the occurrence preview is what
 * makes an arbitrary expression safe anyway.
 */
export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 9am", cron: "0 9 * * *" },
  { label: "Every day at 2am", cron: "0 2 * * *" },
  { label: "Weekdays at 9am", cron: "0 9 * * 1-5" },
  { label: "Every Monday at 9am", cron: "0 9 * * 1" },
  { label: "First of the month, 9am", cron: "0 9 1 * *" },
]

/** IANA zone names the runtime knows, with the host's zone first. */
export function timezoneOptions(): string[] {
  const local = hostTimezone()
  let all: string[] = []
  try {
    all = Intl.supportedValuesOf("timeZone")
  } catch {
    // Older runtimes without `supportedValuesOf`: the local zone plus UTC is
    // still enough to save a schedule, and the field accepts any valid name.
    all = ["UTC"]
  }
  const rest = all.filter((zone) => zone !== local && zone !== "UTC")
  return [local, ...(local === "UTC" ? [] : ["UTC"]), ...rest]
}

/** The browser's IANA zone, which is the zone the user means by "9am". */
export function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/** Compact relative time, forwards or backwards: "in 4h" / "2d ago" / "now". */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ""
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const deltaSeconds = Math.round((then - Date.now()) / 1000)
  const ahead = deltaSeconds >= 0
  const s = Math.abs(deltaSeconds)
  if (s < 45) return "now"
  const shape = (value: number, unit: string) =>
    ahead ? `in ${value}${unit}` : `${value}${unit} ago`
  if (s < 3600) return shape(Math.round(s / 60), "m")
  if (s < 86400) return shape(Math.round(s / 3600), "h")
  return shape(Math.round(s / 86400), "d")
}

/** An absolute instant in the schedule's own zone — the clock it was set by. */
export function formatInZone(iso: string, timezone: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    }).format(date)
  } catch {
    // An unknown zone can only reach here from a row edited outside the app.
    return date.toLocaleString()
  }
}

export const FIRE_STATUS_LABELS: Record<ScheduleFireStatus, string> = {
  launched: "Launched",
  skipped: "Skipped",
  missed: "Missed",
  error: "Failed",
}

/**
 * Tailwind classes for a fire outcome's dot. Semantic tokens only — an absolute
 * colour would invert wrongly between light and dark.
 */
export const FIRE_STATUS_DOT: Record<ScheduleFireStatus, string> = {
  launched: "bg-primary",
  skipped: "bg-muted-foreground",
  missed: "bg-muted-foreground",
  error: "bg-destructive",
}

/** Outcomes worth flagging in the rail: something didn't run as intended. */
export function isFireProblem(status: ScheduleFireStatus | undefined): boolean {
  return status === "missed" || status === "skipped" || status === "error"
}

/** One line summarizing a fire, for the rail's marker and the history rows. */
export function fireSummary(run: ScheduleRun): string {
  if (run.status === "missed") {
    const n = run.missed_count
    return `Missed ${n} fire${n === 1 ? "" : "s"} — Lursor wasn't running`
  }
  if (run.status === "skipped") return "Skipped — the previous run was still going"
  if (run.status === "error") return run.detail || "The run failed to start"
  return "Launched"
}

/** What the schedule will do, in a sentence, for the rail's second line. */
export function runTypeSummary(schedule: Schedule): string {
  return schedule.run_type === "goal"
    ? `Autonomous goal, up to ${schedule.max_iterations} turns`
    : "One turn"
}
