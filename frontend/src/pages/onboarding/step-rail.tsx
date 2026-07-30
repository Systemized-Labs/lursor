import { Check } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"

export interface RailStep {
  id: string
  label: string
  done: boolean
}

interface StepRailProps {
  steps: RailStep[]
  activeIndex: number
  /** Highest index the user may jump to; later steps stay inert. */
  maxIndex: number
  onSelect: (index: number) => void
}

/**
 * The progress row at the top of the walkthrough: a dot (or tick) per step.
 * Steps up to `maxIndex` are clickable so going back to fix something never
 * means starting over.
 */
export function StepRail({
  steps,
  activeIndex,
  maxIndex,
  onSelect,
}: StepRailProps) {
  return (
    <ol className="flex items-center gap-1">
      {steps.map((step, index) => {
        const active = index === activeIndex
        const reachable = index <= maxIndex
        return (
          <li key={step.id} className="flex items-center gap-1">
            {index > 0 ? (
              <span className="h-px w-4 shrink-0 bg-border sm:w-6" aria-hidden />
            ) : null}
            <button
              type="button"
              disabled={!reachable}
              aria-current={active ? "step" : undefined}
              onClick={() => onSelect(index)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm transition-colors",
                reachable
                  ? "hover:bg-muted/60"
                  : "cursor-default opacity-60",
                active ? "text-foreground" : "text-muted-foreground"
              )}
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-full border",
                  step.done
                    ? "border-success bg-success text-success-foreground"
                    : active
                      ? "border-foreground"
                      : "border-border"
                )}
              >
                {step.done ? (
                  <Check className="size-2.5" weight="bold" />
                ) : active ? (
                  <span className="size-1.5 rounded-full bg-foreground" />
                ) : null}
              </span>
              {/* Labels are the point of the rail on desktop, but four of them
                  crowd a phone — there the dots plus the step heading below
                  carry the position. */}
              <span className="hidden sm:inline">{step.label}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
