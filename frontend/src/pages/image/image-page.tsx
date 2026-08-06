import { Cpu, ImageSquare } from "@phosphor-icons/react"
import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"

import { isImageActive, useImageRunSync, useImageRuns } from "@/api/images"
import { useLaiosConnections } from "@/api/laios"
import { useMediaSettings } from "@/api/settings"
import type { LaiosImageRun } from "@/api/types"
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
import { ImageComposer } from "./image-composer"
import { ImageRunCard } from "./image-run-card"
import { useImageComposer } from "./use-image-composer"

const DESCRIPTION =
  "Generate images on whichever source is configured in Settings → Image & video. One call per image — seconds on a local Z-Image, longer and priced on a hosted model — kept here with the settings and timings it ran with."

// Shared with the LAIOS and Video pages so switching connection anywhere carries
// over here.
const ACTIVE_KEY = "laios.activeConnectionId"

export function ImagePage({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: media, isLoading: mediaLoading } = useMediaSettings()
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

  // The page follows the configured source rather than offering its own picker —
  // Settings → Image & video is the one place that choice is made, and a second
  // one here would mean an agent and the page could be generating on different
  // models with nothing saying so.
  const onLaios = (media?.image.source ?? "laios") === "laios"
  const source = onLaios
    ? connectionId
      ? `laios:${connectionId}`
      : undefined
    : "openrouter"

  // Unfiltered: history made under the previous source stays visible, because the
  // images are still on disk and a gallery that emptied itself on a settings
  // change would read as data loss.
  const { data: runs } = useImageRuns()
  useImageRunSync(undefined, runs)

  // Held at the page so a run card can load a past run back into the form.
  const composer = useImageComposer()

  const ready = onLaios ? Boolean(connections && connections.length > 0) : true

  return (
    <div className="space-y-6">
      <PageHeader
        title="Image"
        embedded={embedded}
        description={DESCRIPTION}
        actions={
          onLaios && connections && connections.length > 1 ? (
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

      {mediaLoading || (onLaios && connectionsLoading) ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <DotGridLoader size="xs" />
          Loading…
        </div>
      ) : !ready ? (
        <NoConnection />
      ) : source ? (
        <>
          <ImageComposer source={source} composer={composer} />
          <Runs runs={runs} onReuse={composer.loadRun} />
        </>
      ) : null}
    </div>
  )
}

/** There is nothing to generate on yet — with the way out, not just the sentence. */
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
        LAIOS is the configured image source, so images are generated on your own
        GPUs through a daemon\'s inference gateway. Add a connection and serve an
        image-capable model — or switch the source to OpenRouter.
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <Button asChild>
          <Link to="/?settings=laios">Go to LAIOS</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link to="/?settings=media">Change the source</Link>
        </Button>
      </div>
    </div>
  )
}

/**
 * The gallery of runs.
 *
 * Denser than the video grid — up to four columns rather than three. An image is
 * legible small in a way a clip is not, and the comparison this page is for
 * (same prompt, two models or two step counts) works better the more of it fits on
 * one screen.
 */
function Runs({
  runs,
  onReuse,
}: {
  runs: LaiosImageRun[] | undefined
  onReuse: (run: LaiosImageRun) => void
}) {
  const activeCount = useMemo(
    () => (runs ?? []).filter(isImageActive).length,
    [runs]
  )

  if (!runs) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <DotGridLoader size="xs" />
        Loading runs…
      </div>
    )
  }

  if (runs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/50 p-8 text-center">
        <ImageSquare className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium text-foreground">
          No images generated yet
        </p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Describe an image above and hit Generate. Every run is kept here with
          the settings and the timings it used, so you can compare models and
          reuse the ones that work.
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
            {runs.length} {runs.length === 1 ? "run" : "runs"}
          </span>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {runs.map((run) => (
          <ImageRunCard key={run.id} run={run} onReuse={onReuse} />
        ))}
      </div>
    </section>
  )
}
