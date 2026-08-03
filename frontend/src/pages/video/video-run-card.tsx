import {
  ArrowsClockwise,
  Copy,
  DownloadSimple,
  Info,
  Prohibit,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { LaiosVideoJob } from "@/api/types"
import { isVideoActive, useCancelVideo, videoContentUrl } from "@/api/videos"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  estimateSeconds,
  formatDuration,
  jobSummary,
  parseUtc,
  relativeTime,
  settingsFromRequest,
} from "./video-settings"

/**
 * Why a run in flight still says "queued".
 *
 * Worth stating once per card, but not worth a paragraph on each: MiniMax-H3
 * gives no progress until the clip is done, so the honest reading of "queued" is
 * "denoising, no idea how far". It lives behind an info tooltip on the timer,
 * which is exactly where the question gets asked.
 */
const NO_PROGRESS_NOTE =
  "This engine reports no progress until the clip is finished — denoising starts immediately, so a run sitting at “queued” is working. The bar below tracks elapsed time against the estimate, not real progress."

/**
 * One run, as a card: the clip (or the wait for it) above, what produced it
 * below.
 *
 * The frame is a fixed 16:9 for every run, not the ratio it was submitted with.
 * Shaping each frame to its own run sounds better and isn't: a 1:1 card in a row
 * of 16:9 ones is half again as tall, so the grid stretches its neighbours and
 * leaves them with a few hundred pixels of empty footer — and a 9:16 frame at
 * card width is too narrow for the player's own controls to fit. Letterboxing
 * inside a uniform box is what every video gallery does, and the ratio is named
 * in the meta line below anyway.
 */
export function VideoRunCard({
  connectionId,
  job,
  onReuse,
}: {
  connectionId: string
  job: LaiosVideoJob
  onReuse: (job: LaiosVideoJob) => void
}) {
  const cancel = useCancelVideo(connectionId)
  const active = isVideoActive(job)
  const now = useTicker(active)
  const settings = settingsFromRequest(job.request)
  const estimate = estimateSeconds(settings.steps)

  const startedAt = parseUtc(job.created_at)
  const elapsed = Number.isNaN(startedAt)
    ? 0
    : Math.max(0, Math.floor((now - startedAt) / 1000))

  async function onCancel() {
    try {
      await cancel.mutateAsync(job.job_id)
      toast.success("Generation cancelled")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel")
    }
  }

  async function onCopyPrompt() {
    try {
      await navigator.clipboard.writeText(job.prompt)
      toast.success("Prompt copied")
    } catch {
      toast.error("Could not copy to the clipboard")
    }
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="relative aspect-video w-full bg-muted/50">
        {job.status === "completed" ? (
          <video
            controls
            preload="metadata"
            className="absolute inset-0 h-full w-full bg-black/90 object-contain"
            src={videoContentUrl(connectionId, job.job_id)}
          />
        ) : active ? (
          <PendingFrame elapsed={elapsed} estimate={estimate} />
        ) : (
          <TerminalFrame job={job} />
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <p
          className={cn(
            "line-clamp-2 text-sm leading-snug",
            job.prompt ? "text-foreground" : "italic text-muted-foreground"
          )}
          title={job.prompt}
        >
          {job.prompt || "no prompt"}
        </p>

        <p className="truncate text-xs text-muted-foreground" title={job.job_id}>
          {job.model} · {jobSummary(job)}
        </p>

        {job.error ? (
          <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {job.error}
          </p>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
          {active ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
              disabled={cancel.isPending}
            >
              <Prohibit className="h-4 w-4" />
              Cancel
            </Button>
          ) : (
            <>
              {job.status === "completed" ? (
                <Button variant="ghost" size="sm" asChild>
                  <a
                    href={videoContentUrl(connectionId, job.job_id)}
                    download={`${job.job_id}.mp4`}
                  >
                    <DownloadSimple className="h-4 w-4" />
                    Save
                  </a>
                </Button>
              ) : null}
              {/* The page's editing loop: a clip is rarely right first try, and
                  the fix is usually one knob on the run you just watched. */}
              <Button variant="ghost" size="sm" onClick={() => onReuse(job)}>
                <ArrowsClockwise className="h-4 w-4" />
                Reuse
              </Button>
              {/* Icon-only so it doesn't crowd Save and Reuse at card width; the
                  tooltip is what makes it findable. */}
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
            </>
          )}

          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {relativeTime(job.created_at, now)}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * The frame while a run is in flight: a timer against the estimate, and a bar
 * that is honest about being a clock rather than a progress report.
 */
function PendingFrame({
  elapsed,
  estimate,
}: {
  elapsed: number
  estimate: number | null
}) {
  // Capped short of full, because time running out is not the same as the job
  // finishing — a bar that sat at 100% while the clip was still rendering would
  // read as a stuck job rather than an overrunning estimate.
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
            / ~{formatDuration(estimate)}
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Why no progress percentage?"
              className="rounded-full text-muted-foreground/70 outline-none ring-ring transition-colors hover:text-foreground focus-visible:ring-2"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            {NO_PROGRESS_NOTE}
          </TooltipContent>
        </Tooltip>
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

/** The frame for a run that ended without a clip: failed or cancelled. */
function TerminalFrame({ job }: { job: LaiosVideoJob }) {
  const failed = job.status === "failed"
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4">
      {failed ? (
        <WarningCircle className="h-7 w-7 text-destructive" />
      ) : (
        <XCircle className="h-7 w-7 text-muted-foreground" />
      )}
      <Badge variant={failed ? "destructive" : "outline"}>{job.status}</Badge>
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
