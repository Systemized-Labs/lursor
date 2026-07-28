import { WarningCircle } from "@phosphor-icons/react"

import { useCronPreview } from "@/api/schedules"
import { formatInZone, relativeTime } from "./schedule-format"

interface CronPreviewProps {
  cron: string
  timezone: string
  /** How many upcoming fires to show. */
  count?: number
}

/**
 * The next few fires for an expression, resolved by the backend.
 *
 * This is the whole reason the cron input can stay a plain text field. A cron
 * string is unreadable — `0 9 * * 1-5` and `0 9 1-5 * *` differ by a space and by
 * a month — and this is an unattended agent run with real cost, so the user needs
 * to *see* when it lands before saving. Asking the server rather than parsing in
 * the browser also means the preview is computed by the same code that will fire
 * it, DST and all.
 */
export function CronPreview({ cron, timezone, count = 5 }: CronPreviewProps) {
  const preview = useCronPreview(cron, timezone)

  if (!cron.trim()) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Enter an expression to see when it fires.
      </p>
    )
  }

  if (preview.isError) {
    return (
      <p className="flex items-start gap-1 text-[11px] leading-snug text-destructive">
        <WarningCircle className="mt-px h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1">
          {preview.error instanceof Error
            ? preview.error.message
            : "Not a valid expression"}
        </span>
      </p>
    )
  }

  // Keep the last good list visible while a keystroke refetches, so the block
  // doesn't flicker between valid states as the user edits.
  const occurrences = (preview.data?.occurrences ?? []).slice(0, count)
  if (occurrences.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {preview.isLoading ? "Working out the next fires…" : "No upcoming fires."}
      </p>
    )
  }

  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium text-muted-foreground">
        Next {occurrences.length === 1 ? "fire" : `${occurrences.length} fires`}
      </p>
      <ul className="space-y-0.5">
        {occurrences.map((iso) => (
          <li
            key={iso}
            className="flex items-baseline justify-between gap-3 text-[11px] text-foreground"
          >
            <span className="min-w-0 truncate tabular-nums">
              {formatInZone(iso, timezone)}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {relativeTime(iso)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
