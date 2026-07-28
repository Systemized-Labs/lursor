import * as React from "react"

import { cn } from "@/lib/utils"

export interface SliderProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Tick marks to draw beneath the track. Ticks with a `label` show it below. */
  ticks?: { value: number; label?: string }[]
}

/**
 * A native range input styled to match the theme, with optional tick marks
 * rendered beneath the track. Ticks are positioned by value across the
 * min/max span, so they line up with the thumb.
 */
const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ className, ticks, min = 0, max = 100, ...props }, ref) => {
    const lo = Number(min)
    const hi = Number(max)
    const span = hi - lo || 1

    return (
      <div className={cn("w-full", className)}>
        <input
          ref={ref}
          type="range"
          min={min}
          max={max}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          {...props}
        />
        {ticks && ticks.length > 0 && (
          <div className="relative mt-1 h-4">
            {ticks.map((tick) => {
              const pct = ((tick.value - lo) / span) * 100
              return (
                <div
                  key={tick.value}
                  className="absolute flex flex-col"
                  style={{ left: `${pct}%` }}
                >
                  {/* The mark itself always sits exactly on the value; only the
                      label below it is pulled inward near the ends, so a tick at
                      0% or 100% doesn't spill its text out of the track. */}
                  <span className="h-1 w-px -translate-x-1/2 bg-border" />
                  {tick.label && (
                    <span
                      className={cn(
                        "mt-0.5 whitespace-nowrap text-[10px] leading-none text-muted-foreground",
                        pct <= 10
                          ? "translate-x-0"
                          : pct >= 90
                            ? "-translate-x-full"
                            : "-translate-x-1/2"
                      )}
                    >
                      {tick.label}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }
)
Slider.displayName = "Slider"

export { Slider }
