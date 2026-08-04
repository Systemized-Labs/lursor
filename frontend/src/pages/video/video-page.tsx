import { Cpu, FilmSlate } from "@phosphor-icons/react"
import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"

import { useLaiosConnections } from "@/api/laios"
import type { LaiosVideoJob } from "@/api/types"
import { isVideoActive, useVideoJobSync, useVideoJobs } from "@/api/videos"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useVideoComposer } from "./use-video-composer"
import { VideoComposer } from "./video-composer"
import { VideoRunCard } from "./video-run-card"

const DESCRIPTION =
  "Generate audio-video on a LAIOS box. A clip is a job, not a completion — submit, watch it denoise, play it back."

// Shared with the LAIOS page so switching connection there carries over here.
const ACTIVE_KEY = "laios.activeConnectionId"

export function VideoPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: connections, isLoading: connectionsLoading } =
    useLaiosConnections()

  const [connectionId, setConnectionId] = useState<string | undefined>(
    () => localStorage.getItem(ACTIVE_KEY) ?? undefined
  )

  // Keep the selection valid as connections load or change.
  useEffect(() => {
    if (!connections) return
    if (!connections.some((c) => c.id === connectionId)) {
      setConnectionId(connections[0]?.id)
    }
  }, [connections, connectionId])

  const { data: jobs } = useVideoJobs(connectionId)
  useVideoJobSync(connectionId, jobs)

  // Held at the page so a run card can load a past run back into the form.
  const composer = useVideoComposer()

  const hasConnections = Boolean(connections && connections.length > 0)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Video"
        embedded={embedded}
        description={DESCRIPTION}
        actions={
          connections && connections.length > 1 ? (
            <Select
              value={connectionId ?? ""}
              onValueChange={(value) => {
                setConnectionId(value)
                localStorage.setItem(ACTIVE_KEY, value)
              }}
            >
              <SelectTrigger className="w-48" aria-label="Connection">
                <SelectValue placeholder="Connection" />
              </SelectTrigger>
              <SelectContent>
                {connections.map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    {connection.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : undefined
        }
      />

      {connectionsLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <DotGridLoader size="xs" />
          Loading connections…
        </div>
      ) : !hasConnections ? (
        <NoConnection />
      ) : connectionId ? (
        <>
          <VideoComposer connectionId={connectionId} composer={composer} />
          <Runs
            connectionId={connectionId}
            jobs={jobs}
            onReuse={composer.loadRun}
          />
        </>
      ) : null}
    </div>
  )
}

/**
 * There is nothing to generate on yet.
 *
 * A card with the way out rather than the sentence this used to be: the page is
 * unusable without a box, so the one thing it owes you is the trip to the page
 * that adds one.
 */
function NoConnection() {
  return (
    <div className="rounded-xl border border-border bg-card p-6 text-center sm:p-10">
      <div className="mx-auto flex size-10 items-center justify-center rounded-lg bg-muted text-foreground">
        <Cpu className="h-5 w-5" />
      </div>
      <h2 className="mt-3 text-base font-semibold text-foreground">
        Connect a LAIOS box first
      </h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Clips are generated on your own GPUs, through a LAIOS daemon's inference
        gateway. Add a connection and serve a video-capable model, then come back.
      </p>
      <Button asChild className="mt-4">
        <Link to="/laios">Go to LAIOS</Link>
      </Button>
    </div>
  )
}

/**
 * The gallery of runs.
 *
 * A grid rather than the full-width stack this was: a 16:9 clip stretched across
 * a 1100px column is a single enormous row, so two runs never fit on screen
 * together — and comparing runs is the entire reason the history is kept. At card
 * width a clip is still comfortably watchable and four of them are visible at
 * once.
 */
function Runs({
  connectionId,
  jobs,
  onReuse,
}: {
  connectionId: string
  jobs: LaiosVideoJob[] | undefined
  onReuse: (job: LaiosVideoJob) => void
}) {
  const activeCount = useMemo(
    () => (jobs ?? []).filter(isVideoActive).length,
    [jobs]
  )

  if (!jobs) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <DotGridLoader size="xs" />
        Loading runs…
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/50 p-8 text-center">
        <FilmSlate className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium text-foreground">
          No clips generated yet
        </p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Describe a shot above and hit Generate. Every run is kept here with the
          settings it used, so you can compare them and reuse the ones that work.
        </p>
      </div>
    )
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">Runs</h2>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {activeCount > 0 ? (
            <span className="flex items-center gap-1.5 text-foreground">
              <DotGridLoader size="2xs" />
              {activeCount} generating
            </span>
          ) : null}
          <span className="tabular-nums">
            {jobs.length} {jobs.length === 1 ? "run" : "runs"}
          </span>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {jobs.map((job) => (
          <VideoRunCard
            key={job.id}
            connectionId={connectionId}
            job={job}
            onReuse={onReuse}
          />
        ))}
      </div>
    </section>
  )
}
