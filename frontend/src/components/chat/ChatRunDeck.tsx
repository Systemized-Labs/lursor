import { useState } from "react"
import { CaretDown, ListChecks, Wrench } from "@phosphor-icons/react"
import { useShallow } from "zustand/react/shallow"

import { useChatSelector } from "@/agui/chatStore"
import { useWorkspaceProcesses } from "@/lib/processes"
import { cn } from "@/lib/utils"
import type { AgentTodo, ChatMessage } from "@/agui/types"

import { SUBAGENT_TOOL_NAME } from "./ChatSubagentCalls"
import { ChatToolCalls } from "./ChatToolCalls"
import { ProcessRows } from "./running-processes-bar"
import { StreamingDots } from "./StreamingDots"
import { TodoRows } from "./ChatTodoList"

/** Small uppercase section label inside the expanded deck body. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
      {children}
    </div>
  )
}

/**
 * The unified "run deck": a single, height-bounded, collapsible strip that sits
 * just above the composer and consolidates everything that used to be three
 * stacked cards — the agent's task list, its live tool activity, and running
 * background terminals.
 *
 * Streaming chat is the priority, so the deck defaults to collapsed: one summary
 * line (active task / latest tool, plus task + terminal chips and the "working"
 * dots) that never grows. Expanding reveals the full detail in a `max-h`
 * scroll region, so no combination of state can ever push the chat off-screen.
 *
 * Tasks are hidden here while a goal executes — the goal panel owns them then —
 * but tools and terminals still surface.
 */
export function ChatRunDeck({
  workspaceId,
  todos,
  goalExecuting,
}: {
  workspaceId?: string
  todos: AgentTodo[]
  goalExecuting: boolean
}) {
  const [open, setOpen] = useState(false)

  const isStreaming = useChatSelector((s) => s.isStreaming)
  const calls = useChatSelector(
    useShallow((s) =>
      s.order
        .map((id) => s.byId[id])
        .filter((m): m is ChatMessage => Boolean(m?.streaming))
        .flatMap((m) => m.toolCalls)
        .filter((t) => t.name !== SUBAGENT_TOOL_NAME)
    )
  )
  const processes = useWorkspaceProcesses(workspaceId)

  const showTasks = todos.length > 0 && !goalExecuting
  const hasTools = calls.length > 0
  const hasProcesses = Boolean(workspaceId) && processes.length > 0

  const completed = todos.filter((t) => t.status === "completed").length
  const active = todos.find((t) => t.status === "in_progress")
  const allDone = todos.length > 0 && completed === todos.length
  const latestTool = calls[calls.length - 1]
  const procCount = processes.length

  // Nothing to report at all — render nothing.
  if (!showTasks && !hasTools && !hasProcesses && !isStreaming) return null

  // Only the working indicator is live (no tasks, tools, or terminals): keep it
  // lightweight, no heavy card — same as the old bare-dots activity state.
  if (!showTasks && !hasTools && !hasProcesses) {
    return (
      <div className="px-4 pb-2 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <StreamingDots />
        </div>
      </div>
    )
  }

  // Primary one-line status: the most "live" thing happening right now.
  const primary = active
    ? active.activeForm || active.content
    : hasTools && latestTool
      ? latestTool.name
      : allDone
        ? "Tasks complete"
        : hasProcesses
          ? `${procCount} terminal${procCount === 1 ? "" : "s"} running`
          : "Working…"

  return (
    <div className="px-4 pb-2 sm:px-6">
      <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-xl border border-border/60 bg-muted/30">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
        >
          <CaretDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
          />
          {hasTools && !active ? (
            <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {primary}
          </span>

          {/* Glanceable chips: task progress + terminal count. */}
          {showTasks && (
            <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground">
              <ListChecks className="h-3.5 w-3.5" />
              {completed}/{todos.length}
            </span>
          )}
          {hasProcesses && (
            <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_2px] shadow-emerald-500/20" />
              {procCount}
            </span>
          )}
          {isStreaming && (
            <span className="shrink-0 pl-0.5">
              <StreamingDots />
            </span>
          )}
        </button>

        {open && (
          <div className="max-h-[50vh] divide-y divide-border/60 overflow-y-auto border-t border-border/60">
            {showTasks && (
              <div className="pb-2.5">
                <SectionLabel>
                  <ListChecks className="h-3.5 w-3.5" />
                  Tasks {completed}/{todos.length}
                </SectionLabel>
                <div className="px-3">
                  <TodoRows todos={todos} />
                </div>
              </div>
            )}

            {hasTools && (
              <div className="pb-2.5">
                <SectionLabel>
                  <Wrench className="h-3.5 w-3.5" />
                  Tools
                </SectionLabel>
                <div className="px-3">
                  <ChatToolCalls toolCalls={calls} />
                </div>
              </div>
            )}

            {hasProcesses && workspaceId && (
              <div className="pb-1">
                <SectionLabel>
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_2px] shadow-emerald-500/20" />
                  {procCount} Terminal{procCount === 1 ? "" : "s"} Running
                </SectionLabel>
                <ProcessRows workspaceId={workspaceId} processes={processes} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
