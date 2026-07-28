import type { ReactNode } from "react"

import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"

/**
 * One compaction knob as a labelled slider with a value readout.
 *
 * Shared by the agent/subagent forms (where it edits a per-row override) and the
 * Settings section (where it edits the app-wide default), so both spell the same
 * knob the same way. Purely presentational: the caller owns the value, what a
 * reset means, and the sentence under the track.
 */

/** Range the sliders span. The backend accepts any fraction in (0, 1]; a floor
 *  well above zero keeps the UI away from settings that would compact constantly. */
export const MIN_PERCENT = 10
export const MAX_PERCENT = 100

/** Clamp a percent into the slider's span so an out-of-range value (from an older
 *  client, or a hand-edited row) still lands the thumb somewhere sensible. */
export function clampPercent(percent: number): number {
  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(percent)))
}

interface CompactionSliderProps {
  id: string
  label: string
  /** Trails the value readout, e.g. "full" in "70% full". */
  unit: string
  /** Whole percent to show, or `null` when it isn't known yet — the track parks
   *  and the readout dashes rather than inventing a position. */
  percent: number | null
  onChange: (percent: number) => void
  /** Value to mark under the track (the default this can revert to), if any. */
  markPercent?: number | null
  markLabel?: string
  /** What the knob does, always shown. */
  help: string
  /** Where the current value comes from, appended to `help` when known. */
  hint?: string
  /** Trailing control beside the readout — typically a reset button. */
  action?: ReactNode
}

export function CompactionSlider({
  id,
  label,
  unit,
  percent,
  onChange,
  markPercent,
  markLabel,
  help,
  hint,
  action,
}: CompactionSliderProps) {
  const known = percent !== null
  const shown = known ? clampPercent(percent) : MAX_PERCENT

  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium tabular-nums text-foreground">
            {known ? `${shown}% ${unit}` : "—"}
          </span>
          {action}
        </div>
      </div>
      <Slider
        id={id}
        min={MIN_PERCENT}
        max={MAX_PERCENT}
        step={1}
        value={shown}
        disabled={!known}
        onChange={(e) => onChange(Number(e.target.value))}
        ticks={
          markPercent != null
            ? [{ value: clampPercent(markPercent), label: markLabel }]
            : undefined
        }
      />
      <p className="text-xs text-muted-foreground">
        {help}
        {hint ? ` ${hint}` : ""}
      </p>
    </div>
  )
}
