import { cn } from "@/lib/utils"

/**
 * Animated 3x3 dot grid used as the app's primary loading indicator.
 *
 * A diagonal wave sweeps across the grid (delay keyed to `row + col`), giving a
 * calm, professional pulse rather than a spinning icon. Colors are theme-aware
 * so it reads correctly in both light and dark mode.
 */

type DotGridLoaderSize = "2xs" | "xs" | "sm" | "md" | "lg"

const SIZES: Record<
  DotGridLoaderSize,
  { dot: string; gap: string }
> = {
  "2xs": { dot: "size-1", gap: "gap-px" }, // ~14px, fits inline status badges
  xs: { dot: "size-1", gap: "gap-0.5" }, // fits a size-4 icon slot
  sm: { dot: "size-1", gap: "gap-1" },
  md: { dot: "size-1.5", gap: "gap-1.5" },
  lg: { dot: "size-2.5", gap: "gap-2" },
}

// 3x3 grid, delay driven by the diagonal so the wave travels corner-to-corner.
const CELLS = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3)
  const col = i % 3
  return { i, delay: (row + col) * 120 }
})

export interface DotGridLoaderProps {
  size?: DotGridLoaderSize
  className?: string
  /** Optional label announced to assistive tech. Defaults to "Loading". */
  label?: string
}

export function DotGridLoader({
  size = "md",
  className,
  label = "Loading",
}: DotGridLoaderProps) {
  const { dot, gap } = SIZES[size]
  return (
    <div
      role="status"
      aria-label={label}
      // Dots inherit `currentColor`, so the loader takes on the surrounding
      // text color by default (e.g. a button's foreground) and callers can
      // override via `text-*`. Opacity is driven by the wave keyframe.
      className={cn("grid grid-cols-3", gap, className)}
    >
      {CELLS.map(({ i, delay }) => (
        <span
          key={i}
          className={cn(
            "rounded-full bg-current",
            "[animation:dot-grid-wave_1.4s_ease-in-out_infinite]",
            dot
          )}
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  )
}

/**
 * Full-screen / full-container centered variant for use as a route or Suspense
 * fallback. Fills its parent and centers the dot grid.
 */
export function DotGridLoaderScreen({
  label,
  size = "lg",
  className,
}: DotGridLoaderProps) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center p-8 text-foreground",
        className
      )}
    >
      <DotGridLoader size={size} label={label} />
    </div>
  )
}
