import { useRef, useState, type KeyboardEvent } from "react"
import {
  CheckCircle,
  Prohibit,
  Target,
  Warning,
} from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { MentionMenu } from "@/components/chat/mentions/MentionMenu"
import { useMentions } from "@/components/chat/mentions/use-mentions"
import type { MentionSource } from "@/components/chat/mentions/types"
import { cn } from "@/lib/utils"
import type { GoalStatus } from "@/api/types"

const NOOP_SOURCES: MentionSource[] = []

/** Config the user fills in to start a goal-mode conversation. */
export interface GoalDraft {
  goal: string
  successCriteria: string
  maxIterations: number
  requirePlanApproval: boolean
}

const DEFAULT_DRAFT: GoalDraft = {
  goal: "",
  successCriteria: "",
  maxIterations: 25,
  requirePlanApproval: true,
}

/** Human-readable label + token-based color for each goal status. */
function statusMeta(status: GoalStatus): { label: string; className: string } {
  switch (status) {
    case "planning":
      return { label: "Planning", className: "bg-primary/10 text-primary" }
    case "awaiting_approval":
      return {
        label: "Awaiting approval",
        className: "bg-primary/15 text-primary",
      }
    case "running":
      return { label: "Running", className: "bg-primary/10 text-primary" }
    case "completed":
      return { label: "Completed", className: "bg-primary/10 text-primary" }
    case "blocked":
      return { label: "Blocked", className: "bg-destructive/10 text-destructive" }
    case "failed":
      return { label: "Failed", className: "bg-destructive/10 text-destructive" }
    case "stopped":
      return { label: "Stopped", className: "bg-muted text-muted-foreground" }
    default:
      return { label: "Idle", className: "bg-muted text-muted-foreground" }
  }
}

/**
 * Setup form for a new goal thread: the objective, optional explicit success
 * criteria, an iteration cap, and whether to pause for plan approval. Shown in
 * place of the composer when the user picks Goal mode on a fresh conversation.
 */
export function GoalSetup({
  disabled,
  onStart,
  mentionSources,
}: {
  disabled?: boolean
  onStart: (draft: GoalDraft) => void
  /** Categories offered by the `@` reference menu on the objective field. */
  mentionSources?: MentionSource[]
}) {
  const [draft, setDraft] = useState<GoalDraft>(DEFAULT_DRAFT)
  const canStart = draft.goal.trim().length > 0 && !disabled

  const objectiveRef = useRef<HTMLTextAreaElement>(null)
  const setGoal = (goal: string) => setDraft((d) => ({ ...d, goal }))
  const mentions = useMentions({
    value: draft.goal,
    setValue: setGoal,
    textareaRef: objectiveRef,
    sources: mentionSources ?? NOOP_SOURCES,
    enabled: (mentionSources?.length ?? 0) > 0,
  })

  // The mention menu claims arrows/enter/tab/escape first so its typeahead
  // works inside the objective field; otherwise the key falls through normally.
  const handleObjectiveKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    mentions.onKeyDown(e)
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-3 rounded-xl border border-border/60 bg-muted/30 p-4">
      <div className="flex items-center gap-2">
        <Target className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-sm font-medium text-foreground">New goal</span>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="goal-objective" className="text-xs text-muted-foreground">
          Objective
        </Label>
        <div className="relative">
          <MentionMenu
            open={mentions.open}
            rows={mentions.rows}
            mode={mentions.mode}
            category={mentions.category}
            loading={mentions.loading}
            activeIndex={mentions.activeIndex}
            onHover={mentions.setActiveIndex}
            onSelect={mentions.selectRow}
          />
          <Textarea
            ref={objectiveRef}
            id="goal-objective"
            value={draft.goal}
            onChange={(e) => {
              setGoal(e.target.value)
              mentions.refresh()
            }}
            onKeyDown={handleObjectiveKeyDown}
            onKeyUp={mentions.refresh}
            onClick={mentions.refresh}
            onSelect={mentions.refresh}
            placeholder="What should the agent accomplish? Reference files with @. e.g. 'Add a health-check endpoint and make its test pass.'"
            rows={3}
            disabled={disabled}
            className="resize-none text-sm"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="goal-criteria" className="text-xs text-muted-foreground">
          Success criteria <span className="opacity-70">(optional)</span>
        </Label>
        <Textarea
          id="goal-criteria"
          value={draft.successCriteria}
          onChange={(e) =>
            setDraft((d) => ({ ...d, successCriteria: e.target.value }))
          }
          placeholder="How completion is judged. Defaults to the objective when left blank."
          rows={2}
          disabled={disabled}
          className="resize-none text-sm"
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <Label
            htmlFor="goal-max"
            className="text-xs text-muted-foreground"
          >
            Max iterations
          </Label>
          <Input
            id="goal-max"
            type="number"
            min={1}
            max={100}
            value={draft.maxIterations}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                maxIterations: Math.max(1, Number(e.target.value) || 1),
              }))
            }
            disabled={disabled}
            className="h-8 w-20 text-sm"
          />
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="goal-approval"
            checked={draft.requirePlanApproval}
            onCheckedChange={(v) =>
              setDraft((d) => ({ ...d, requirePlanApproval: v }))
            }
            disabled={disabled}
          />
          <Label
            htmlFor="goal-approval"
            className="text-xs text-muted-foreground"
          >
            Approve plan before running
          </Label>
        </div>

        <Button
          type="button"
          size="sm"
          className="ml-auto"
          disabled={!canStart}
          onClick={() => onStart(draft)}
        >
          Start goal
        </Button>
      </div>
    </div>
  )
}

/**
 * Live goal banner shown above the composer for a goal thread: the objective,
 * a status pill, the iteration counter, the evaluator's latest reason, and the
 * plan-approval action when the run is parked awaiting it.
 */
export function GoalBanner({
  status,
  condition,
  iteration,
  maxIterations,
  reason,
  approving,
  planUpdated,
  onApprove,
}: {
  status: GoalStatus
  condition: string
  iteration: number
  maxIterations: number
  reason: string
  approving?: boolean
  /** A refinement turn just rewrote the plan doc — surfaced as a subtle pill. */
  planUpdated?: boolean
  onApprove: () => void
}) {
  const meta = statusMeta(status)
  const terminalIcon =
    status === "completed" ? (
      <CheckCircle weight="fill" className="h-4 w-4 shrink-0 text-primary" />
    ) : status === "blocked" || status === "failed" ? (
      <Warning weight="fill" className="h-4 w-4 shrink-0 text-destructive" />
    ) : status === "stopped" ? (
      <Prohibit className="h-4 w-4 shrink-0 text-muted-foreground" />
    ) : (
      <Target className="h-4 w-4 shrink-0 text-primary" />
    )

  return (
    <div className="mx-auto w-full max-w-3xl space-y-2 rounded-xl border border-border/60 bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        {terminalIcon}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {condition || "Goal"}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
            meta.className
          )}
        >
          {meta.label}
        </span>
        {(status === "running" || status === "planning") && maxIterations > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {iteration}/{maxIterations}
          </span>
        )}
        {status === "awaiting_approval" && planUpdated && (
          <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
            Plan updated
          </span>
        )}
      </div>

      {reason && (
        <p className="text-xs leading-5 text-muted-foreground">{reason}</p>
      )}

      {status === "awaiting_approval" && (
        <div className="flex items-center gap-2">
          <p className="flex-1 text-xs text-muted-foreground">
            Review the plan below. Chat to refine it, or approve to start the
            autonomous run.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={approving}
            onClick={onApprove}
          >
            {approving ? "Approving…" : "Approve plan"}
          </Button>
        </div>
      )}
    </div>
  )
}
