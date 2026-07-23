import { useState, type ReactNode } from "react"
import {
  CaretDown,
  CheckCircle,
  Circle,
  CircleNotch,
  Prohibit,
  Square,
  Target,
} from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { AgentTodo, TodoStatus } from "@/agui/types"

/**
 * Goals often arrive as a raw markdown task line (e.g. "- [ ] File `x.txt`
 * exists"). Strip the leading list/checkbox marker and inline-code backticks so
 * the header reads as plain prose in its single truncated line.
 */
function cleanObjective(text: string): string {
  return text
    .trim()
    .replace(/^[-*+]\s+\[[ xX]?\]\s+/, "") // "- [ ] ", "* [x] "
    .replace(/^[-*+]\s+/, "") // "- ", "* "
    .replace(/^\d+[.)]\s+/, "") // "1. ", "2) "
    .replace(/`([^`]+)`/g, "$1") // inline `code` -> code
    .trim()
}

/** Per-status icon for a todo row inside the run panel. */
function TodoIcon({ status }: { status: TodoStatus }) {
  switch (status) {
    case "completed":
      return <CheckCircle weight="fill" className="h-3.5 w-3.5 shrink-0 text-primary" />
    case "in_progress":
      return <CircleNotch className="h-3.5 w-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
    case "blocked":
      return <Prohibit className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    default:
      return <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
  }
}

/**
 * The control deck shown while a goal is executing autonomously. One calm
 * surface that folds together live status, task progress, the steer input, and
 * a stop control.
 *
 * `children` is the embedded steer composer (rendered flush inside the deck).
 */
export function GoalRunPanel({
  objective,
  planName,
  iteration,
  maxIterations,
  reason,
  todos,
  onStop,
  children,
}: {
  objective: string
  planName?: string
  iteration: number
  maxIterations: number
  reason: string
  todos: AgentTodo[]
  onStop: () => void
  children: ReactNode
}) {
  const [tasksOpen, setTasksOpen] = useState(false)
  // Lead the header with the plan doc name when we have one; fall back to the
  // cleaned success criteria only when there's no plan to name.
  const title = planName?.trim() || cleanObjective(objective) || "Goal"
  const total = todos.length
  const completed = todos.filter((t) => t.status === "completed").length
  const active = todos.find((t) => t.status === "in_progress")
  // Lead with what the agent is doing right now (the in-progress task's
  // present-continuous label), falling back to the evaluator's note.
  const activity = active?.activeForm || active?.content || reason || "Working…"
  const pct = total ? Math.round((completed / total) * 100) : 0

  return (
    <div className="px-4 pb-4 pt-1 sm:px-6">
      <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm">
        {/* Status header: plan name, a live pulse, the turn counter, and stop. */}
        <div className="flex items-center gap-2.5 px-3.5 py-2.5">
          <Target className="h-4 w-4 shrink-0 text-primary" />
          <span
            title={title}
            className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
          >
            {title}
          </span>
          <span className="relative flex h-2 w-2 shrink-0" title="Running">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 motion-reduce:hidden" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          {maxIterations > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              turn {iteration}/{maxIterations}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onStop}
            className="-my-0.5 h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
          >
            <Square weight="fill" className="h-3 w-3" />
            Stop
          </Button>
        </div>

        {/* Activity + task progress. */}
        {total > 0 && (
          <div className="space-y-1.5 px-3.5 pb-2.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {activity}
              </span>
              <button
                type="button"
                onClick={() => setTasksOpen((o) => !o)}
                className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground transition-colors hover:text-foreground"
              >
                {completed}/{total} tasks
                <CaretDown
                  className={cn(
                    "h-3 w-3 transition-transform",
                    tasksOpen && "rotate-180"
                  )}
                />
              </button>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            {tasksOpen && (
              <ul className="space-y-1.5 pt-1">
                {todos.map((todo) => (
                  <li key={todo.id} className="flex items-start gap-2">
                    <span className="mt-0.5">
                      <TodoIcon status={todo.status} />
                    </span>
                    <span
                      className={cn(
                        "text-xs leading-5",
                        todo.status === "completed"
                          ? "text-muted-foreground line-through"
                          : todo.status === "in_progress"
                            ? "font-medium text-foreground"
                            : "text-foreground"
                      )}
                    >
                      {todo.status === "in_progress"
                        ? todo.activeForm || todo.content
                        : todo.content}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Steer input (embedded composer). */}
        <div className="border-t border-border/60">{children}</div>
      </div>
    </div>
  )
}
