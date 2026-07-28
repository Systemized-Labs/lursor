import {
  ArrowSquareOut,
  DotsThree,
  Lightning,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react"
import { useMemo, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { useRunScheduleNow, useScheduleRuns, useUpdateSchedule } from "@/api/schedules"
import type {
  Agent,
  Schedule,
  ScheduleRunType,
  ScheduleUpdateInput,
  Workspace,
} from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { CronField } from "./cron-field"
import {
  FIRE_STATUS_DOT,
  FIRE_STATUS_LABELS,
  fireSummary,
  formatInZone,
  relativeTime,
  timezoneOptions,
} from "./schedule-format"

interface FieldProps {
  label: string
  htmlFor?: string
  children: React.ReactNode
  /** Sits under the control, for the sentence a bare input can't carry. */
  hint?: React.ReactNode
}

function Field({ label, htmlFor, children, hint }: FieldProps) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-3 px-4 py-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
      <label
        htmlFor={htmlFor}
        className="pt-1.5 text-xs font-medium text-muted-foreground"
      >
        {label}
      </label>
      <div className="min-w-0 max-w-xl space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
        {hint ? (
          <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    </div>
  )
}

interface ScheduleDetailPanelProps {
  schedule: Schedule
  /** Selectable workspaces (system ones excluded — see `schedules-page`). */
  workspaces: Workspace[]
  /** Every workspace id → name, including ones not offered in the picker, so an
   *  existing schedule pointed at one still reads correctly. */
  workspaceNames: Map<string, string>
  agents: Agent[]
  /** Thread ids with a live run, for the badge on a history row. */
  runningThreadIds: Set<string>
  /** Focus the name field on mount — Enter or a double click in the rail. */
  autoFocusName: boolean
  onDelete: (schedule: Schedule) => void
}

/**
 * Everything about one schedule, editable in place.
 *
 * The split follows the environment manager: text fields are a draft with an
 * explicit Save (a half-typed cron expression must never be saved on blur, and the
 * server is the only thing that can tell you whether one is valid), while the
 * discrete controls — enabled, run type, workspace, agent, timezone — write
 * immediately, because they can't fail on content and the control itself is the
 * undo.
 *
 * The occurrence preview sits directly under the expression and updates as you
 * type, which is what makes a bare text field an acceptable way to enter one.
 */
export function ScheduleDetailPanel({
  schedule,
  workspaces,
  workspaceNames,
  agents,
  runningThreadIds,
  autoFocusName,
  onDelete,
}: ScheduleDetailPanelProps) {
  const updateSchedule = useUpdateSchedule()
  const runNow = useRunScheduleNow()
  const runsQuery = useScheduleRuns(schedule.id)
  const nameRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  // The pane is keyed by schedule id, so plain initial state is the reset: a new
  // selection is a new component.
  const [name, setName] = useState(schedule.name)
  const [description, setDescription] = useState(schedule.description)
  const [cron, setCron] = useState(schedule.cron)
  const [prompt, setPrompt] = useState(schedule.prompt)
  const [successCriteria, setSuccessCriteria] = useState(schedule.success_criteria)
  const [maxIterations, setMaxIterations] = useState(String(schedule.max_iterations))

  const zones = useMemo(() => timezoneOptions(), [])
  const isGoal = schedule.run_type === "goal"

  const dirty =
    name !== schedule.name ||
    description !== schedule.description ||
    cron.trim() !== schedule.cron ||
    prompt !== schedule.prompt ||
    (isGoal &&
      (successCriteria !== schedule.success_criteria ||
        maxIterations !== String(schedule.max_iterations)))

  const workspaceName =
    workspaceNames.get(schedule.workspace_id) ?? "an unknown workspace"

  function revert() {
    setName(schedule.name)
    setDescription(schedule.description)
    setCron(schedule.cron)
    setPrompt(schedule.prompt)
    setSuccessCriteria(schedule.success_criteria)
    setMaxIterations(String(schedule.max_iterations))
  }

  /** Write one or more fields, surfacing the server's reason on a rejection. */
  async function write(input: ScheduleUpdateInput, successMessage?: string) {
    try {
      await updateSchedule.mutateAsync({ id: schedule.id, input })
      if (successMessage) toast.success(successMessage)
      return true
    } catch (err) {
      // A cron/timezone rejection is a 422 whose detail says what to fix; showing
      // it beats "failed to save".
      toast.error(err instanceof Error ? err.message : "Failed to save schedule")
      return false
    }
  }

  async function save() {
    if (!name.trim()) {
      toast.error("A name is required")
      nameRef.current?.focus()
      return
    }
    if (!prompt.trim()) {
      toast.error("A prompt is required — it is the turn each fire sends")
      return
    }
    const parsed = Number(maxIterations)
    if (isGoal && (!Number.isInteger(parsed) || parsed < 1)) {
      toast.error("Max turns must be a whole number of at least 1")
      return
    }
    await write({
      name: name.trim(),
      description,
      cron: cron.trim(),
      prompt: prompt.trim(),
      ...(isGoal
        ? { success_criteria: successCriteria, max_iterations: parsed }
        : {}),
    })
  }

  /** The conversation a fire opened. */
  function threadHref(threadId: string): string {
    return `/workspaces/${schedule.workspace_id}/chat?c=${threadId}`
  }

  async function handleRunNow() {
    try {
      const run = await runNow.mutateAsync(schedule.id)
      // Go straight into the streaming conversation. Testing a schedule is
      // *about* watching what it does, so a toast alone left you with nothing to
      // look at at the moment you most wanted to see something.
      if (run.thread_id) {
        navigate(threadHref(run.thread_id))
        return
      }
      toast.success(`${schedule.name} fired`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start the run")
    }
  }

  const runs = runsQuery.data ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        data-slot="schedule-detail-header"
        className="flex items-start justify-between gap-3 border-b px-4 py-3"
      >
        <div className="min-w-0 space-y-1">
          <h2 className="truncate text-sm font-semibold text-foreground">
            {schedule.name}
          </h2>
          <p className="text-[11px] text-muted-foreground">
            {schedule.enabled ? (
              schedule.next_fire_at ? (
                <>
                  Next fire {formatInZone(schedule.next_fire_at, schedule.timezone)}{" "}
                  ({relativeTime(schedule.next_fire_at)})
                </>
              ) : (
                "Enabled, but its expression can't be resolved"
              )
            ) : (
              "Paused — nothing will fire until you enable it"
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRunNow}
            disabled={runNow.isPending}
          >
            <Lightning className="h-4 w-4" />
            Run now
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Schedule actions">
                <DotsThree className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => void write({ enabled: !schedule.enabled })}
              >
                {schedule.enabled ? "Pause schedule" : "Enable schedule"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onDelete(schedule)}>
                <Trash className="h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="min-h-0 flex-1 divide-y divide-border/50 overflow-y-auto py-1">
        <Field label="Name" htmlFor={`sched-name-${schedule.id}`}>
          <Input
            id={`sched-name-${schedule.id}`}
            ref={nameRef}
            autoFocus={autoFocusName}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 text-sm"
          />
        </Field>

        <Field
          label="Enabled"
          hint="A paused schedule keeps its configuration and history but never fires."
        >
          <Switch
            checked={schedule.enabled}
            onCheckedChange={(next) => void write({ enabled: next })}
            aria-label="Enabled"
          />
          <span className="text-xs text-foreground">
            {schedule.enabled ? "Firing on schedule" : "Paused"}
          </span>
        </Field>

        <Field
          label="Runs in"
          hint={
            <>
              The agent has its full toolset in <strong>{workspaceName}</strong> —
              files, shell, git — with nobody watching. Point it at a workspace you
              are happy for it to change unattended.
            </>
          }
        >
          <Select
            value={schedule.workspace_id}
            onValueChange={(value) => void write({ workspace_id: value })}
          >
            <SelectTrigger className="h-8 w-full text-sm">
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
        </Field>

        <Field
          label="Agent"
          hint="The run uses this agent's model, instructions and tools."
        >
          <Select
            value={schedule.agent_id}
            onValueChange={(value) => void write({ agent_id: value })}
          >
            <SelectTrigger className="h-8 w-full text-sm">
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
        </Field>

        {/* No hint: the `Field` puts one under the whole control, which here means
            under the list of fires, and the picker says what it does anyway. */}
        <Field label="Schedule" htmlFor={`sched-cron-${schedule.id}`}>
          <CronField
            id={`sched-cron-${schedule.id}`}
            value={cron}
            onChange={setCron}
            timezone={schedule.timezone}
            dense
          />
        </Field>

        <Field
          label="Timezone"
          hint="Fires by this zone's wall clock, so 9am stays 9am across daylight saving."
        >
          <Select
            value={schedule.timezone}
            onValueChange={(value) => void write({ timezone: value })}
          >
            <SelectTrigger className="h-8 w-full text-sm">
              <SelectValue placeholder="Pick a timezone" />
            </SelectTrigger>
            {/* Hundreds of zones; the list scrolls rather than growing the pane. */}
            <SelectContent className="max-h-72">
              {zones.map((zone) => (
                <SelectItem key={zone} value={zone}>
                  {zone}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label="Prompt"
          htmlFor={`sched-prompt-${schedule.id}`}
          hint="Sent as the first message of a brand-new conversation on every fire, so it needs to stand alone — there is no earlier context to refer back to."
        >
          <Textarea
            id={`sched-prompt-${schedule.id}`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            className="min-h-0 w-full text-sm"
          />
        </Field>

        <Field
          label="Run type"
          hint={
            isGoal
              ? "The autonomous loop: work, evaluate against the criteria below, repeat until met or the turn cap is spent. Powerful and the expensive option."
              : "One turn. Bounded and predictable — the right default for anything unattended."
          }
        >
          <Select
            value={schedule.run_type}
            onValueChange={(value) =>
              void write({ run_type: value as ScheduleRunType })
            }
          >
            <SelectTrigger className="h-8 w-full text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="chat">Single turn</SelectItem>
              <SelectItem value="goal">Autonomous goal</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {isGoal ? (
          <>
            <Field
              label="Done when"
              htmlFor={`sched-criteria-${schedule.id}`}
              hint="What the evaluator checks the run against. Left empty it falls back to the prompt, which is usually too vague to ever read as met."
            >
              <Textarea
                id={`sched-criteria-${schedule.id}`}
                value={successCriteria}
                onChange={(e) => setSuccessCriteria(e.target.value)}
                rows={3}
                className="min-h-0 w-full text-sm"
              />
            </Field>
            <Field
              label="Max turns"
              htmlFor={`sched-iters-${schedule.id}`}
              hint="The hard stop, and the only ceiling on what one unattended fire can cost. Scheduled spend shows up in Usage under the “cron” kind."
            >
              <Input
                id={`sched-iters-${schedule.id}`}
                value={maxIterations}
                onChange={(e) => setMaxIterations(e.target.value)}
                inputMode="numeric"
                className="h-8 w-24 text-sm"
              />
            </Field>
          </>
        ) : null}

        <Field label="Notes" htmlFor={`sched-desc-${schedule.id}`}>
          <Textarea
            id={`sched-desc-${schedule.id}`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Why this schedule exists"
            className="min-h-0 w-full text-sm"
          />
        </Field>

        <div className="space-y-2 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">History</h3>
            {schedule.last_fired_at ? (
              <span className="text-[11px] text-muted-foreground">
                Last fired {relativeTime(schedule.last_fired_at)}
              </span>
            ) : null}
          </div>
          {runsQuery.isLoading ? (
            <p className="text-[11px] text-muted-foreground">Loading history…</p>
          ) : runs.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Nothing has fired yet. Use Run now to see what it does.
            </p>
          ) : (
            <>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Each fire opens its own conversation. They also appear in the
                workspace&apos;s list in the sidebar, marked with a clock.
              </p>
              <ul className="space-y-0.5">
                {runs.map((run) => {
                  const live = Boolean(
                    run.thread_id && runningThreadIds.has(run.thread_id)
                  )
                  const body = (
                    <>
                      <span
                        aria-hidden
                        className={cn(
                          "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                          live
                            ? "animate-pulse bg-primary"
                            : FIRE_STATUS_DOT[run.status]
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="text-xs text-foreground">
                            {formatInZone(run.fired_at, schedule.timezone)}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {live ? "running" : FIRE_STATUS_LABELS[run.status]}
                          </span>
                        </span>
                        {run.status !== "launched" ? (
                          <span className="flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
                            <WarningCircle className="mt-px h-3 w-3 shrink-0" />
                            <span className="min-w-0 flex-1">{fireSummary(run)}</span>
                          </span>
                        ) : null}
                      </span>
                    </>
                  )
                  // The whole row is the target when there is a conversation to
                  // open — a 14px icon was the only way into a transcript that is
                  // hidden everywhere else, which is far too little.
                  return (
                    <li key={run.id}>
                      {run.thread_id ? (
                        <Link
                          to={threadHref(run.thread_id)}
                          className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
                        >
                          {body}
                          <span className="flex shrink-0 items-center gap-1 pt-0.5 text-[11px] text-muted-foreground group-hover:text-foreground">
                            Open
                            <ArrowSquareOut className="h-3 w-3" />
                          </span>
                        </Link>
                      ) : (
                        <span className="flex items-start gap-2 px-2 py-1.5">
                          {body}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
      </div>

      {/* Only text fields need an explicit save, so the bar appears only for them. */}
      {dirty ? (
        <div className="flex items-center justify-between gap-2 border-t bg-muted/30 px-4 py-2.5">
          <Badge variant="secondary" className="text-[11px]">
            Unsaved changes
          </Badge>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={revert}>
              Revert
            </Button>
            <Button size="sm" onClick={save} disabled={updateSchedule.isPending}>
              Save
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
