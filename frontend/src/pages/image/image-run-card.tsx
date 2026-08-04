import {
  ArrowsClockwise,
  Copy,
  DownloadSimple,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { imageContentUrl, isImageActive, useDeleteImage } from "@/api/images"
import type { LaiosImageRun } from "@/api/types"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  formatDuration,
  formatShortEstimate,
  measured,
  parseUtc,
  relativeTime,
  runEstimate,
  runSummary,
} from "./image-settings"

/**
 * One generation, as a card: the image (or the wait for it) above, what produced
 * it below.
 *
 * The frame is a fixed square for every run rather than the size it was submitted
 * with, for the reason the video grid landed on a fixed 16:9 — a 9:16 card in a row
 * of 16:9 ones is three times as tall, so the grid stretches its neighbours and
 * leaves them with a footer full of nothing. A square is the right uniform here
 * because 1024² is the default and the measured size, so most cards fill it
 * exactly; the rest letterbox, and the meta line names the real dimensions.
 *
 * The image links to its own bytes so a click opens it full size. That is not
 * decoration on this page: the thing these two models are actually being compared
 * on is fine detail — rendered glyphs — which a card-width thumbnail cannot show.
 */
export function ImageRunCard({
  connectionId,
  run,
  onReuse,
}: {
  connectionId: string
  run: LaiosImageRun
  onReuse: (run: LaiosImageRun) => void
}) {
  const remove = useDeleteImage(connectionId)
  const active = isImageActive(run)
  const now = useTicker(active)

  const startedAt = parseUtc(run.created_at)
  const elapsed = Number.isNaN(startedAt)
    ? 0
    : Math.max(0, Math.floor((now - startedAt) / 1000))

  const src = imageContentUrl(connectionId, run.id)
  const stats = measured(run)

  async function onDelete() {
    try {
      await remove.mutateAsync(run.id)
      toast.success(active ? "Run removed — the box finishes it regardless" : "Run deleted")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  async function onCopyPrompt() {
    try {
      await navigator.clipboard.writeText(run.prompt)
      toast.success("Prompt copied")
    } catch {
      toast.error("Could not copy to the clipboard")
    }
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="relative aspect-square w-full bg-muted/50">
        {run.status === "completed" ? (
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="absolute inset-0 outline-none ring-ring focus-visible:ring-2"
            title="Open full size"
          >
            <img
              src={src}
              alt={run.prompt || "generated image"}
              loading="lazy"
              className="h-full w-full bg-black/90 object-contain"
            />
          </a>
        ) : active ? (
          <PendingFrame elapsed={elapsed} estimate={runEstimate(run)} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4">
            <WarningCircle className="h-7 w-7 text-destructive" />
            <span className="text-xs font-medium text-muted-foreground">
              failed
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <p
          className={cn(
            "line-clamp-2 text-sm leading-snug",
            run.prompt ? "text-foreground" : "italic text-muted-foreground"
          )}
          title={run.prompt}
        >
          {run.prompt || "no prompt"}
        </p>

        <p
          className="truncate text-xs text-muted-foreground"
          title={run.upstream_id ?? run.id}
        >
          {run.model} · {runSummary(run)}
        </p>

        {/* The engine's own numbers, and the reason this page exists: comparing
            two models or two step counts is comparing these. Reported in every
            response, so nothing here had to be instrumented. */}
        {stats ? (
          <p className="truncate text-xs tabular-nums text-muted-foreground">
            {stats}
          </p>
        ) : null}

        {run.error ? (
          <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {run.error}
          </p>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
          {run.status === "completed" ? (
            <Button variant="ghost" size="sm" asChild>
              <a href={src} download>
                <DownloadSimple className="h-4 w-4" />
                Save
              </a>
            </Button>
          ) : null}

          {/* The page's editing loop, and on this page also how you compare
              models: reuse a run, change only the model, resubmit. */}
          {!active ? (
            <Button variant="ghost" size="sm" onClick={() => onReuse(run)}>
              <ArrowsClockwise className="h-4 w-4" />
              Reuse
            </Button>
          ) : null}

          {/* Icon-only so they don't crowd Save and Reuse at card width; the
              tooltips are what make them findable. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onCopyPrompt}
                aria-label="Copy prompt"
                className="size-8 text-muted-foreground hover:text-foreground"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Copy prompt</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onDelete}
                disabled={remove.isPending}
                aria-label="Delete run"
                className="size-8 text-muted-foreground hover:text-destructive"
              >
                <Trash className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            {/* Honest about what it can promise while a generation is in flight:
                the image API has no cancel, so the GPU keeps working either way. */}
            <TooltipContent side="top">
              {active
                ? "Remove this run — the box keeps rendering it"
                : "Delete this run"}
            </TooltipContent>
          </Tooltip>

          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {relativeTime(run.created_at, now)}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * The frame while a generation is in flight.
 *
 * Elapsed against the estimate, same as the video page — but without its "why is
 * there no percentage" tooltip. There is nothing to explain here: the engine holds
 * one synchronous call open and reports nothing until it returns, and at 7 seconds
 * for the default model nobody is left wondering.
 */
function PendingFrame({
  elapsed,
  estimate,
}: {
  elapsed: number
  estimate: number | null
}) {
  // Capped short of full, because time running out is not the same as the job
  // finishing — a bar at 100% while the box is still working reads as stuck.
  const fraction = estimate ? Math.min(elapsed / estimate, 0.97) : 0
  const overrun = estimate !== null && elapsed > estimate

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4">
      <DotGridLoader size="sm" />
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium tabular-nums text-foreground">
          {formatDuration(elapsed)}
        </span>
        {estimate !== null ? (
          <span className="text-sm tabular-nums text-muted-foreground">
            / {formatShortEstimate(estimate)}
          </span>
        ) : null}
      </div>

      <div className="h-1 w-full max-w-[16rem] overflow-hidden rounded-full bg-border">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-1000 ease-linear",
            overrun ? "bg-muted-foreground" : "bg-primary"
          )}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>

      <p className="text-center text-[11px] text-muted-foreground">
        {overrun ? "Running longer than estimated" : "Generating on the box"}
      </p>
    </div>
  )
}

/**
 * A clock that ticks every second while `running`, and stops when it isn't.
 *
 * Returns `Date.now()` rather than an elapsed count so one hook serves both the
 * live timer and the "3m ago" stamp — and a settled card still gets one correct
 * reading without holding an interval open for a row that will never change.
 */
function useTicker(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) {
      // One catch-up read on settle, so a card that just finished isn't stamped
      // with whatever second it last rendered on.
      setNow(Date.now())
      return
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [running])

  return now
}
