/**
 * The knob primitives the generation composers share.
 *
 * Lifted out of `pages/video/` when the image page arrived: both pages are the
 * same problem — a prompt, a handful of engine parameters, and a wait measured in
 * seconds of GPU — so they want the same controls rather than two drifting copies
 * of them.
 */
import type { ReactNode } from "react"

import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/**
 * One labelled knob: name on the left, its current value on the right, control
 * beneath.
 *
 * The value readout is the reason this exists. The old form was five bare number
 * inputs in a row, where the only way to know what "768" meant was to already
 * know — so every control here states its resolved value in the same place, and
 * the sliders and chips below never need a unit in their own label.
 */
export function Field({
  label,
  value,
  hint,
  htmlFor,
  children,
}: {
  label: string
  value?: ReactNode
  hint?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label
          htmlFor={htmlFor}
          className="text-xs font-medium text-foreground"
        >
          {label}
        </Label>
        {value !== undefined ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {value}
          </span>
        ) : null}
      </div>
      {children}
      {hint !== undefined ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export interface SegmentedOption<T extends string | number> {
  value: T
  label: string
  /** Optional mark drawn before the label — e.g. an aspect-ratio outline. */
  glyph?: ReactNode
}

/**
 * A row of mutually exclusive choices, rendered as a filled track with the
 * selection raised out of it.
 *
 * A `<Select>` for three aspect ratios costs a click to see two options; here
 * they are all on screen, and the shape glyph says what "9:16" means faster than
 * the string does. Built on buttons in a `radiogroup` rather than real radios so
 * the selected segment can carry the raised background without fighting an
 * input's own painting.
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("flex gap-1 rounded-lg bg-muted/60 p-1", className)}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium outline-none ring-ring transition-colors focus-visible:ring-2",
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.glyph}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * An aspect ratio drawn as an outline, scaled to fit a fixed square.
 *
 * Fitting the *longest* edge to the box is what keeps the three glyphs the same
 * visual size: scaling the width instead would make 9:16 nearly twice as tall as
 * 16:9 is wide, and the row would step up and down as the eye crossed it.
 */
export function AspectGlyph({ w, h }: { w: number; h: number }) {
  const scale = 13 / Math.max(w, h)
  return (
    <span
      aria-hidden
      className="flex size-[14px] shrink-0 items-center justify-center"
    >
      <span
        className="rounded-[2px] border-[1.5px] border-current"
        style={{ width: w * scale, height: h * scale }}
      />
    </span>
  )
}

