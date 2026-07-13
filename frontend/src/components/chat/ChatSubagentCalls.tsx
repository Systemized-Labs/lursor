import { useState } from "react"
import {
  CaretDown,
  CheckCircle,
  CircleNotch,
  TreeStructure,
  WarningCircle,
} from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import type { ChatToolCall } from "@/agui/types"

/** Tool name the deep agent uses to delegate work to a subagent. */
export const SUBAGENT_TOOL_NAME = "task"

interface ParsedTask {
  subagentType?: string
  description?: string
}

/**
 * Pulls the subagent name and task description out of a `task` tool call's
 * arguments. Arguments stream in incrementally, so the JSON is often partial:
 * we parse when we can and fall back to a lenient field scrape otherwise, so a
 * card can render its heading before the full payload has landed.
 */
function parseTask(args: string): ParsedTask {
  if (args?.trim()) {
    try {
      const obj = JSON.parse(args) as Record<string, unknown>
      return {
        subagentType:
          typeof obj.subagent_type === "string" ? obj.subagent_type : undefined,
        description:
          typeof obj.description === "string" ? obj.description : undefined,
      }
    } catch {
      // Partial JSON mid-stream — scrape the two fields we care about.
    }
  }
  const grab = (key: string) =>
    args.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))?.[1]
  const unescape = (s: string | undefined) =>
    s ? s.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\") : s
  return {
    subagentType: unescape(grab("subagent_type")),
    description: unescape(grab("description")),
  }
}

type TaskState = "running" | "error" | "done"

function taskState(call: ChatToolCall): TaskState {
  if (call.result === undefined || call.result === "") return "running"
  return call.result.startsWith("Error:") ? "error" : "done"
}

/** Status glyph mirroring a subagent task's lifecycle. */
function TaskStatusIcon({ state }: { state: TaskState }) {
  if (state === "running")
    return <CircleNotch className="h-4 w-4 shrink-0 animate-spin text-primary" />
  if (state === "error")
    return <WarningCircle weight="fill" className="h-4 w-4 shrink-0 text-destructive" />
  return <CheckCircle weight="fill" className="h-4 w-4 shrink-0 text-primary" />
}

/** A single subagent delegation card: who ran, the task, and its result. */
function SubagentCard({ call }: { call: ChatToolCall }) {
  const [open, setOpen] = useState(false)
  const { subagentType, description } = parseTask(call.args)
  const state = taskState(call)
  const label = subagentType || "subagent"
  const statusText =
    state === "running" ? "Running…" : state === "error" ? "Failed" : "Done"

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
      >
        <TreeStructure className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Delegated to</span>
        <span className="font-mono text-xs font-medium text-foreground">{label}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <TaskStatusIcon state={state} />
          <span
            className={cn(
              "text-[11px] font-medium",
              state === "error" ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {statusText}
          </span>
          <CaretDown
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
          />
        </span>
      </button>

      {open && (
        <>
          {description && (
            <div className="border-t border-border/60 px-3 py-2">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Task
              </p>
              <p className="text-xs leading-5 text-muted-foreground">{description}</p>
            </div>
          )}

          {call.result !== undefined && call.result !== "" && (
            <div className="border-t border-border/60 px-3 py-2">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Result
              </p>
              <pre
                className={cn(
                  "max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2 py-1.5 font-mono text-[11px]",
                  state === "error" ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {call.result}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Renders `task` tool calls as subagent delegation cards. Each shows which
 * subagent the turn handed work to, the task brief, a live status (spinner while
 * the delegated run is in flight, check/warning when it returns), and the
 * subagent's returned output on expand.
 */
export function ChatSubagentCalls({ calls }: { calls: ChatToolCall[] }) {
  if (!calls.length) return null
  return (
    <div className="space-y-2">
      {calls.map((call) => (
        <SubagentCard key={call.id} call={call} />
      ))}
    </div>
  )
}
