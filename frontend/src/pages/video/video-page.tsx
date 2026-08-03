import { FilmSlate, Prohibit, Sparkle } from "@phosphor-icons/react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { useLaiosConnections } from "@/api/laios"
import type { LaiosVideoJob } from "@/api/types"
import {
  isVideoActive,
  useCancelVideo,
  useSubmitVideo,
  useVideoJobSync,
  useVideoJobs,
  useVideoModels,
  videoContentUrl,
} from "@/api/videos"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

const DESCRIPTION =
  "Generate audio-video on a LAIOS box. A clip is a job, not a completion — submit, watch it denoise, play it back."

// Shared with the LAIOS page so switching connection there carries over here.
const ACTIVE_KEY = "laios.activeConnectionId"

// The recipe's own probe values (docs/inference-matrix.md): 8 steps is the fast
// smoke test at roughly 6 minutes, against a 50-step default that runs ~35.
const DEFAULTS = {
  shortEdge: 768,
  aspectRatio: "16:9",
  durationSeconds: 4,
  steps: 8,
}

const ASPECT_RATIOS = ["16:9", "9:16", "1:1"]

export function VideoPage() {
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

  const hasConnections = Boolean(connections && connections.length > 0)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Video"
        description={DESCRIPTION}
        actions={
          hasConnections && connections && connections.length > 1 ? (
            <Select
              value={connectionId ?? ""}
              onValueChange={(v) => {
                setConnectionId(v)
                localStorage.setItem(ACTIVE_KEY, v)
              }}
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Connection" />
              </SelectTrigger>
              <SelectContent>
                {connections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : undefined
        }
      />

      {connectionsLoading ? (
        <p className="text-sm text-muted-foreground">Loading connections…</p>
      ) : !hasConnections ? (
        <p className="text-sm text-muted-foreground">
          No LAIOS connection yet. Add one on the LAIOS page, then come back —
          this page talks to that box's inference gateway.
        </p>
      ) : connectionId ? (
        <>
          <SubmitPanel connectionId={connectionId} />
          <JobList connectionId={connectionId} jobs={jobs} />
        </>
      ) : null}
    </div>
  )
}

function SubmitPanel({ connectionId }: { connectionId: string }) {
  const { options, controlReachable } = useVideoModels(connectionId)
  const submit = useSubmitVideo(connectionId)

  const [model, setModel] = useState("")
  const [prompt, setPrompt] = useState("")
  const [shortEdge, setShortEdge] = useState(String(DEFAULTS.shortEdge))
  const [aspectRatio, setAspectRatio] = useState(DEFAULTS.aspectRatio)
  const [duration, setDuration] = useState(String(DEFAULTS.durationSeconds))
  const [steps, setSteps] = useState(String(DEFAULTS.steps))
  const [seed, setSeed] = useState("")

  // Preselect the only video model serving, which is the common case — one
  // MiniMax-H3 instance per box, since the recipe is solo_only.
  useEffect(() => {
    if (!model && options.length > 0) setModel(options[0].servedName)
  }, [options, model])

  const estimate = useMemo(() => {
    const n = Number(steps)
    if (!Number.isFinite(n) || n <= 0) return null
    // ~44 s/denoise step at 1344×768×107f, measured in the recipe header.
    const minutes = (n * 44) / 60
    return minutes < 1 ? "under a minute" : `~${Math.round(minutes)} min`
  }, [steps])

  async function onSubmit() {
    if (!model.trim()) {
      toast.error("Pick a model to generate with")
      return
    }
    if (!prompt.trim()) {
      toast.error("A prompt is required")
      return
    }
    const parsedSeed = seed.trim() === "" ? undefined : Number(seed)
    try {
      await submit.mutateAsync({
        model: model.trim(),
        prompt: prompt.trim(),
        task: "t2va",
        target: {
          short_edge: Number(shortEdge),
          aspect_ratio: aspectRatio,
          duration_seconds: Number(duration),
        },
        num_inference_steps: Number(steps),
        ...(parsedSeed !== undefined && Number.isFinite(parsedSeed)
          ? { seed: parsedSeed }
          : {}),
      })
      toast.success("Generation submitted")
      setPrompt("")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit")
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="space-y-2">
        <Label htmlFor="video-model" className="text-foreground">
          Model
        </Label>
        {options.length > 0 ? (
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger id="video-model">
              <SelectValue placeholder="Select a video model" />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.servedName} value={o.servedName}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <>
            <Input
              id="video-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="minimax-h3"
            />
            {/* Two different reasons the picker can be empty, and the operator
                needs to know which: nothing is serving, or the control plane
                isn't published through the tunnel so we can't tell. */}
            <p className="text-xs text-muted-foreground">
              {controlReachable
                ? "No video-capable model is serving on this box — serve one from the LAIOS page, or name it directly."
                : "Could not read this box's model inventory (a tunnel without expose_control). Name the served model directly."}
            </p>
          </>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="video-prompt" className="text-foreground">
          Prompt
        </Label>
        <Textarea
          id="video-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="a paper boat drifting across a puddle at dusk"
          rows={3}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="space-y-2">
          <Label htmlFor="video-short-edge" className="text-foreground">
            Short edge
          </Label>
          <Input
            id="video-short-edge"
            type="number"
            value={shortEdge}
            onChange={(e) => setShortEdge(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="video-aspect" className="text-foreground">
            Aspect
          </Label>
          <Select value={aspectRatio} onValueChange={setAspectRatio}>
            <SelectTrigger id="video-aspect">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASPECT_RATIOS.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="video-duration" className="text-foreground">
            Seconds
          </Label>
          <Input
            id="video-duration"
            type="number"
            step="0.5"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="video-steps" className="text-foreground">
            Steps
          </Label>
          <Input
            id="video-steps"
            type="number"
            value={steps}
            onChange={(e) => setSteps(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="video-seed" className="text-foreground">
            Seed
          </Label>
          <Input
            id="video-seed"
            type="number"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="random"
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {estimate
            ? `Roughly ${estimate} at ~44s per denoise step. Generation runs on the box; this page polls.`
            : "Steps must be a positive number."}
        </p>
        <Button onClick={onSubmit} disabled={submit.isPending}>
          <Sparkle className="h-4 w-4" />
          {submit.isPending ? "Submitting…" : "Generate"}
        </Button>
      </div>
    </div>
  )
}

function JobList({
  connectionId,
  jobs,
}: {
  connectionId: string
  jobs: LaiosVideoJob[] | undefined
}) {
  if (!jobs) {
    return <p className="text-sm text-muted-foreground">Loading jobs…</p>
  }
  if (jobs.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <FilmSlate className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium text-foreground">
          No clips generated yet
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Submit a prompt above. Runs are kept here so you can compare them.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground">Runs</h2>
      {jobs.map((job) => (
        <JobCard key={job.id} connectionId={connectionId} job={job} />
      ))}
    </div>
  )
}

function JobCard({
  connectionId,
  job,
}: {
  connectionId: string
  job: LaiosVideoJob
}) {
  const cancel = useCancelVideo(connectionId)
  const active = isVideoActive(job)

  async function onCancel() {
    try {
      await cancel.mutateAsync(job.job_id)
      toast.success("Generation cancelled")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel")
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="truncate text-sm font-medium text-foreground">
            {job.prompt || "(no prompt)"}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {job.model} · {job.job_id}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge job={job} />
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
          ) : null}
        </div>
      </div>

      {job.error ? (
        <p className="text-sm text-destructive">{job.error}</p>
      ) : null}

      {job.status === "completed" ? (
        <video
          controls
          preload="metadata"
          className="w-full rounded-md border border-border bg-muted"
          src={videoContentUrl(connectionId, job.job_id)}
        />
      ) : null}
    </div>
  )
}

function StatusBadge({ job }: { job: LaiosVideoJob }) {
  const pct =
    job.progress !== null && job.progress > 0
      ? ` ${Math.round(job.progress * 100)}%`
      : ""

  switch (job.status) {
    case "completed":
      return <Badge variant="success">completed</Badge>
    case "failed":
      return <Badge variant="destructive">failed</Badge>
    case "cancelled":
      return <Badge variant="outline">cancelled</Badge>
    default:
      return (
        <Badge variant="secondary">
          {job.status}
          {pct}
        </Badge>
      )
  }
}
