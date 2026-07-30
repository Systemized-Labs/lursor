import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { useCreateSchedule } from "@/api/schedules"
import type { Agent, Schedule, ScheduleRunType, Workspace } from "@/api/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/responsive-dialog"
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
import { CronField } from "./cron-field"
import { hostTimezone, timezoneOptions } from "./schedule-format"

interface ScheduleCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaces: Workspace[]
  agents: Agent[]
  /** Preselect this workspace when it exists (e.g. the one you came from). */
  defaultWorkspaceId?: string
  /** Hand the new schedule back so the caller can select it in the rail. */
  onCreated: (schedule: Schedule) => void
}

const DEFAULT_CRON = "0 9 * * *"
// Matches the backend's own default, so the field is prefilled with what an
// unspecified cap would have been rather than a second opinion about it.
const DEFAULT_MAX_ITERATIONS = "25"

/**
 * Everything needed to make a schedule that fires: where, who, when, what to say,
 * and how hard to work at it.
 *
 * A single turn stays the default — cheap and bounded is the right unattended
 * shape — but the autonomous goal is offered here rather than only in the detail
 * pane, because "run until this is true" is usually the reason someone is creating
 * the schedule at all, not an upgrade they think of afterwards. The goal fields
 * stay hidden until it is chosen, so the cheap path is still four fields long.
 */
export function ScheduleCreateDialog({
  open,
  onOpenChange,
  workspaces,
  agents,
  defaultWorkspaceId,
  onCreated,
}: ScheduleCreateDialogProps) {
  const createSchedule = useCreateSchedule()
  const [name, setName] = useState("")
  const [workspaceId, setWorkspaceId] = useState("")
  const [agentId, setAgentId] = useState("")
  const [cron, setCron] = useState(DEFAULT_CRON)
  const [timezone, setTimezone] = useState(hostTimezone())
  const [prompt, setPrompt] = useState("")
  const [runType, setRunType] = useState<ScheduleRunType>("chat")
  const [successCriteria, setSuccessCriteria] = useState("")
  const [maxIterations, setMaxIterations] = useState(DEFAULT_MAX_ITERATIONS)
  const zones = useMemo(() => timezoneOptions(), [])
  const isGoal = runType === "goal"

  // Reset on each open, and default the pickers to something valid so the form is
  // one field away from savable rather than four.
  useEffect(() => {
    if (!open) return
    setName("")
    setCron(DEFAULT_CRON)
    setTimezone(hostTimezone())
    setPrompt("")
    setRunType("chat")
    setSuccessCriteria("")
    setMaxIterations(DEFAULT_MAX_ITERATIONS)
    setWorkspaceId(
      defaultWorkspaceId && workspaces.some((w) => w.id === defaultWorkspaceId)
        ? defaultWorkspaceId
        : (workspaces[0]?.id ?? "")
    )
    setAgentId(agents[0]?.id ?? "")
  }, [open, defaultWorkspaceId, workspaces, agents])

  async function handleSubmit() {
    if (!name.trim()) {
      toast.error("A name is required")
      return
    }
    if (!workspaceId || !agentId) {
      toast.error("Pick a workspace and an agent")
      return
    }
    if (!prompt.trim()) {
      toast.error("A prompt is required — it is the turn each fire sends")
      return
    }
    const parsedIterations = Number(maxIterations)
    if (isGoal && (!Number.isInteger(parsedIterations) || parsedIterations < 1)) {
      toast.error("Max turns must be a whole number of at least 1")
      return
    }
    try {
      const created = await createSchedule.mutateAsync({
        name: name.trim(),
        workspace_id: workspaceId,
        agent_id: agentId,
        cron: cron.trim(),
        timezone,
        prompt: prompt.trim(),
        // Omitted entirely for a single turn: that is already the server's
        // default, and the goal columns it would fill are unread in that mode.
        ...(isGoal
          ? {
              run_type: runType,
              success_criteria: successCriteria.trim(),
              max_iterations: parsedIterations,
            }
          : {}),
      })
      toast.success(`${created.name} scheduled`)
      onOpenChange(false)
      onCreated(created)
    } catch (err) {
      // A malformed expression comes back as a 422 whose detail says what to fix.
      toast.error(err instanceof Error ? err.message : "Failed to create schedule")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New schedule</DialogTitle>
          <DialogDescription>
            A prompt sent to an agent on a repeating schedule. Each fire opens its
            own conversation, and only fires while Lursor is running.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-sched-name">Name</Label>
            <Input
              id="new-sched-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nightly dependency check"
              autoFocus
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-sched-workspace">Workspace</Label>
              <Select value={workspaceId} onValueChange={setWorkspaceId}>
                <SelectTrigger id="new-sched-workspace">
                  <SelectValue placeholder="Pick a workspace" />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sched-agent">Agent</Label>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger id="new-sched-agent">
                  <SelectValue placeholder="Pick an agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Timezone first: it is what "9am" means, and the occurrence preview
              inside the schedule field below is resolved in it. */}
          <div className="space-y-1.5">
            <Label htmlFor="new-sched-tz">Timezone</Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger id="new-sched-tz">
                <SelectValue placeholder="Pick a timezone" />
              </SelectTrigger>
              {/* Hundreds of zones; the list scrolls rather than growing the
                  dialog. The host's own zone is first. */}
              <SelectContent className="max-h-72">
                {zones.map((zone) => (
                  <SelectItem key={zone} value={zone}>
                    {zone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-sched-cron">Schedule</Label>
            {/* Carries its own preview, so an expression is checked before the
                schedule exists rather than after it has fired at the wrong hour. */}
            <CronField
              id="new-sched-cron"
              value={cron}
              onChange={setCron}
              timezone={timezone}
              previewCount={3}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-sched-prompt">Prompt</Label>
            <Textarea
              id="new-sched-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Check for outdated dependencies and open a PR if any are behind."
            />
            <p className="text-[11px] leading-snug text-muted-foreground">
              Every fire starts a brand-new conversation, so this has to stand on
              its own. The agent will have its full toolset in that workspace with
              nobody watching.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-sched-run-type">Run type</Label>
            <Select
              value={runType}
              onValueChange={(value) => setRunType(value as ScheduleRunType)}
            >
              <SelectTrigger id="new-sched-run-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="chat">Single turn</SelectItem>
                <SelectItem value="goal">Autonomous goal</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {isGoal
                ? "The autonomous loop: work, evaluate against the criteria below, repeat until met or the turn cap is spent. Powerful, and the expensive option."
                : "One turn. Bounded and predictable — the right default for anything unattended."}
            </p>
          </div>

          {isGoal ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="new-sched-criteria">Done when</Label>
                <Textarea
                  id="new-sched-criteria"
                  value={successCriteria}
                  onChange={(e) => setSuccessCriteria(e.target.value)}
                  rows={3}
                  placeholder="Every dependency is on its latest minor version and the test suite passes."
                />
                <p className="text-[11px] leading-snug text-muted-foreground">
                  What the evaluator checks each round against. Left empty it falls
                  back to the prompt, which is usually too vague to ever read as met.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="new-sched-iters">Max turns</Label>
                <Input
                  id="new-sched-iters"
                  value={maxIterations}
                  onChange={(e) => setMaxIterations(e.target.value)}
                  inputMode="numeric"
                  className="w-24"
                />
                <p className="text-[11px] leading-snug text-muted-foreground">
                  The hard stop, and the only ceiling on what one unattended fire can
                  cost.
                </p>
              </div>
            </>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={createSchedule.isPending}>
            Create schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
