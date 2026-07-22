import { useEffect, useState } from "react"
import {
  CaretDown,
  CheckCircle,
  Circle,
  CircleNotch,
  ListChecks,
  Prohibit,
} from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import type { AgentTodo, TodoStatus } from "@/agui/types"

/** Per-status icon for a todo row. In-progress spins to read as "working now". */
export function TodoStatusIcon({ status }: { status: TodoStatus }) {
  switch (status) {
    case "completed":
      return <CheckCircle weight="fill" className="h-4 w-4 shrink-0 text-primary" />
    case "in_progress":
      return (
        <CircleNotch className="h-4 w-4 shrink-0 animate-spin text-primary" />
      )
    case "blocked":
      return <Prohibit className="h-4 w-4 shrink-0 text-muted-foreground" />
    default:
      return <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
  }
}

/**
 * The agent's live task list, rendered as a compact, collapsible panel. Fed by
 * the backend's `todos` CUSTOM event (see `stream-reader`): each `write_todos`
 * / status update the agent makes re-renders this in place. The header shows
 * completed-vs-total progress; the in-progress task uses its present-continuous
 * `activeForm` label so the panel reads as a running status.
 */
export function ChatTodoList({ todos }: { todos: AgentTodo[] }) {
  const [open, setOpen] = useState(true)

  const completed = todos.filter((t) => t.status === "completed").length
  const active = todos.find((t) => t.status === "in_progress")
  const allDone = todos.length > 0 && completed === todos.length

  // Collapse once every task is done to reduce clutter; the user can reopen it.
  useEffect(() => {
    if (allDone) setOpen(false)
  }, [allDone])

  if (!todos.length) return null

  return (
    <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-xl border border-border/60 bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
      >
        <ListChecks className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">
          {allDone
            ? "Tasks complete"
            : active
              ? active.activeForm || active.content
              : "Tasks"}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {completed}/{todos.length}
        </span>
        <CaretDown
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <div className="border-t border-border/60 px-3 py-2.5">
          <TodoRows todos={todos} />
        </div>
      )}
    </div>
  )
}

/** The bare list of todo rows, without any card chrome. Reused by the run deck. */
export function TodoRows({ todos }: { todos: AgentTodo[] }) {
  return (
    <ul className="space-y-1.5">
      {todos.map((todo) => (
        <li key={todo.id} className="flex items-start gap-2">
          <span className="mt-0.5">
            <TodoStatusIcon status={todo.status} />
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
  )
}
