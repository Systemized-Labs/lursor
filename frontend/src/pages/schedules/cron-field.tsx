import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  buildCron,
  defaultInterval,
  describeDraft,
  formatHour,
  HOUR_INTERVALS,
  MINUTE_CHOICES,
  MINUTE_INTERVALS,
  parseCron,
  WEEKDAYS,
  type CronDraft,
  type CronFrequency,
} from "./cron-builder"
import { CronPreview } from "./cron-preview"
import { CRON_PRESETS } from "./schedule-format"

const FREQUENCY_LABELS: Record<CronFrequency, string> = {
  minutes: "Minutes",
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  custom: "Custom cron",
}

const FREQUENCY_ORDER: CronFrequency[] = [
  "minutes",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "custom",
]

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)
const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1)

interface CronFieldProps {
  /** The expression. Always a valid-shaped 5-field string unless hand-typed. */
  value: string
  onChange: (cron: string) => void
  /** The zone the preview resolves in — owned by the form, not by this field. */
  timezone: string
  /** Put on the frequency control, so an outer `<Label>` can point at it. */
  id?: string
  /** Shorter controls, for the detail pane's field grid. */
  dense?: boolean
  /** How many upcoming fires to list underneath. */
  previewCount?: number
}

/**
 * How often a schedule fires, asked as a question instead of as five numbers.
 *
 * The controls are a view over a cron string, not a replacement for it: every
 * change writes a real expression back through `onChange`, the expression is shown
 * next to the plain-English summary, and Custom hands over the raw field for
 * anything the pickers can't say. So the storage format never changes, a schedule
 * made here can be edited by hand later, and one written by hand opens on whichever
 * control produced it.
 *
 * The occurrence preview stays — a summary derived from the same fields that built
 * the expression can only ever agree with itself, and the thing worth checking
 * before an unattended agent run is when it actually lands, which only the server
 * can answer.
 */
export function CronField({
  value,
  onChange,
  timezone,
  id,
  dense = false,
  previewCount,
}: CronFieldProps) {
  const [draft, setDraft] = useState<CronDraft>(() => parseCron(value))

  // The expression is the source of truth, and it moves underneath us: a preset,
  // a revert, or the pane switching to another schedule. Re-derive only when the
  // incoming value isn't the one this draft produced, so ordinary edits keep the
  // fields the user set (`0 9 * * *` parses back as daily, not as the weekly
  // selection they were halfway through building).
  useEffect(() => {
    setDraft((current) => (buildCron(current) === value ? current : parseCron(value)))
  }, [value])

  function update(patch: Partial<CronDraft>) {
    const next = { ...draft, ...patch }
    setDraft(next)
    onChange(buildCron(next))
  }

  function changeFrequency(frequency: CronFrequency) {
    if (frequency === "custom") {
      // Hand the text field what the pickers were saying, so Custom is a place to
      // keep editing rather than a blank box.
      update({ frequency, expression: buildCron(draft) })
      return
    }
    // Leaving Custom, adopt whatever the typed expression can tell us — its time
    // of day, its days — instead of resetting to the seed. Only on that edge:
    // between two structured frequencies the live fields are ahead of
    // `expression`, and re-parsing it would undo the time the user just picked.
    const recovered =
      draft.frequency === "custom" ? parseCron(draft.expression) : null
    const base =
      recovered && recovered.frequency !== "custom" ? recovered : draft
    update({
      ...(base === draft ? {} : base),
      frequency,
      interval: defaultInterval(frequency, base.interval),
    })
  }

  function toggleWeekday(day: number) {
    const on = draft.weekdays.includes(day)
    // Turning the last day off would build an every-day expression, which is not
    // what unchecking the only checked box means.
    if (on && draft.weekdays.length === 1) return
    update({
      weekdays: on
        ? draft.weekdays.filter((value) => value !== day)
        : [...draft.weekdays, day].sort((a, b) => a - b),
    })
  }

  const control = dense ? "h-8" : "h-10"
  const summary = describeDraft(draft)
  const expression = buildCron(draft)

  const timeOfDay = (
    <>
      <span className="shrink-0 text-xs text-muted-foreground">at</span>
      <Select
        value={String(draft.hour)}
        onValueChange={(next) => update({ hour: Number(next) })}
      >
        <SelectTrigger
          className={cn(control, "w-[6.5rem] text-sm")}
          aria-label="Hour"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {HOURS.map((hour) => (
            <SelectItem key={hour} value={String(hour)}>
              {formatHour(hour)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={String(draft.minute)}
        onValueChange={(next) => update({ minute: Number(next) })}
      >
        <SelectTrigger
          className={cn(control, "w-[5rem] text-sm")}
          aria-label="Minute"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {/* A minute the expression already carries but the list doesn't offer
              (typed by hand, or set elsewhere) stays selectable rather than
              snapping to :00 the moment this renders. */}
          {[...new Set([...MINUTE_CHOICES, draft.minute])]
            .sort((a, b) => a - b)
            .map((minute) => (
              <SelectItem key={minute} value={String(minute)}>
                :{String(minute).padStart(2, "0")}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </>
  )

  return (
    <div className="w-full min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select value={draft.frequency} onValueChange={changeFrequency}>
          <SelectTrigger
            id={id}
            className={cn(control, "w-[8.5rem] shrink-0 text-sm")}
            aria-label="How often"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FREQUENCY_ORDER.map((frequency) => (
              <SelectItem key={frequency} value={frequency}>
                {FREQUENCY_LABELS[frequency]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {draft.frequency === "minutes" ? (
          <>
            <span className="shrink-0 text-xs text-muted-foreground">every</span>
            <Select
              value={String(draft.interval)}
              onValueChange={(next) => update({ interval: Number(next) })}
            >
              <SelectTrigger
                className={cn(control, "w-[5rem] text-sm")}
                aria-label="Minutes between fires"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...new Set([...MINUTE_INTERVALS, draft.interval])]
                  .sort((a, b) => a - b)
                  .map((step) => (
                    <SelectItem key={step} value={String(step)}>
                      {step}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <span className="shrink-0 text-xs text-muted-foreground">minutes</span>
          </>
        ) : null}

        {draft.frequency === "hourly" ? (
          <>
            <span className="shrink-0 text-xs text-muted-foreground">every</span>
            <Select
              value={String(draft.interval)}
              onValueChange={(next) => update({ interval: Number(next) })}
            >
              <SelectTrigger
                className={cn(control, "w-[4.5rem] text-sm")}
                aria-label="Hours between fires"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...new Set([...HOUR_INTERVALS, draft.interval])]
                  .sort((a, b) => a - b)
                  .map((step) => (
                    <SelectItem key={step} value={String(step)}>
                      {step}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <span className="shrink-0 text-xs text-muted-foreground">
              {draft.interval === 1 ? "hour, at" : "hours, at"}
            </span>
            <Select
              value={String(draft.minute)}
              onValueChange={(next) => update({ minute: Number(next) })}
            >
              <SelectTrigger
                className={cn(control, "w-[5rem] text-sm")}
                aria-label="Minute past the hour"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {[...new Set([...MINUTE_CHOICES, draft.minute])]
                  .sort((a, b) => a - b)
                  .map((minute) => (
                    <SelectItem key={minute} value={String(minute)}>
                      :{String(minute).padStart(2, "0")}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <span className="shrink-0 text-xs text-muted-foreground">past</span>
          </>
        ) : null}

        {draft.frequency === "daily" || draft.frequency === "weekly"
          ? timeOfDay
          : null}

        {draft.frequency === "monthly" ? (
          <>
            <span className="shrink-0 text-xs text-muted-foreground">on day</span>
            <Select
              value={String(draft.monthDay)}
              onValueChange={(next) => update({ monthDay: Number(next) })}
            >
              <SelectTrigger
                className={cn(control, "w-[4.5rem] text-sm")}
                aria-label="Day of the month"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {MONTH_DAYS.map((day) => (
                  <SelectItem key={day} value={String(day)}>
                    {day}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {timeOfDay}
          </>
        ) : null}

        {draft.frequency === "custom" ? (
          <>
            <Input
              value={draft.expression}
              onChange={(e) => update({ expression: e.target.value })}
              placeholder="0 9 * * 1-5"
              spellCheck={false}
              aria-label="Cron expression"
              className={cn(control, "min-w-[10rem] flex-1 font-mono text-sm")}
            />
            {/* A menu, not a second Select: picking a preset fills the field and
                then gets out of the way. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(control, "shrink-0 text-xs")}
                >
                  Presets
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {CRON_PRESETS.map((preset) => (
                  <DropdownMenuItem
                    key={preset.cron}
                    onSelect={() => update({ expression: preset.cron })}
                  >
                    {preset.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}
      </div>

      {draft.frequency === "weekly" ? (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Days">
          {WEEKDAYS.map((day) => {
            const on = draft.weekdays.includes(day.value)
            return (
              <button
                key={day.value}
                type="button"
                aria-pressed={on}
                aria-label={day.long}
                onClick={() => toggleWeekday(day.value)}
                className={cn(
                  "h-7 rounded-md border px-2.5 text-[11px] font-medium transition-colors",
                  on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {day.short}
              </button>
            )
          })}
        </div>
      ) : null}

      {summary ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {summary}
          {" · "}
          <code className="font-mono text-foreground">{expression}</code>
          {draft.frequency === "minutes" ? (
            <>
              {" — "}
              {Math.floor(60 / Math.max(1, draft.interval))} fires an hour, each a
              full agent run.
            </>
          ) : null}
        </p>
      ) : null}

      <CronPreview cron={value} timezone={timezone} count={previewCount} />
    </div>
  )
}
