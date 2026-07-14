import { streamUrl } from "./agent"
import type { AgentGoalStatus, AgentTodo, GoalRunStatus, TodoStatus } from "./types"

const TODO_STATUSES: TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
]

const GOAL_STATUSES: GoalRunStatus[] = [
  "planning",
  "awaiting_approval",
  "running",
  "completed",
  "blocked",
  "failed",
  "stopped",
]

/** The name of the AG-UI CUSTOM event carrying the agent's live todo list. */
export const TODOS_EVENT_NAME = "todos"

/** The name of the AG-UI CUSTOM event carrying goal lifecycle updates. */
export const GOAL_STATUS_EVENT_NAME = "goal_status"

/**
 * Normalizes the `value` of a `goal_status` CUSTOM event. Tolerant of missing
 * fields so a wire change can't crash the stream; returns `null` when the
 * payload doesn't carry a recognized status.
 */
export function parseGoalStatus(value: unknown): AgentGoalStatus | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (!GOAL_STATUSES.includes(v.status as GoalRunStatus)) return null
  return {
    status: v.status as GoalRunStatus,
    condition: typeof v.condition === "string" ? v.condition : "",
    iteration: typeof v.iteration === "number" ? v.iteration : 0,
    maxIterations: typeof v.maxIterations === "number" ? v.maxIterations : 0,
    reason: typeof v.reason === "string" ? v.reason : "",
  }
}

/**
 * Normalizes the `value` of a `todos` CUSTOM event into a list of {@link AgentTodo}.
 * Tolerant of missing/extra fields so a wire change can't crash the stream: an
 * unrecognized status falls back to "pending", and non-conforming entries are
 * dropped. Returns `null` when the payload isn't a todo list at all.
 */
export function parseTodos(value: unknown): AgentTodo[] | null {
  const raw =
    value && typeof value === "object" && "todos" in value
      ? (value as { todos: unknown }).todos
      : value
  if (!Array.isArray(raw)) return null
  const todos: AgentTodo[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const t = item as Record<string, unknown>
    const content = typeof t.content === "string" ? t.content : ""
    if (!content) continue
    const status = TODO_STATUSES.includes(t.status as TodoStatus)
      ? (t.status as TodoStatus)
      : "pending"
    todos.push({
      id: typeof t.id === "string" ? t.id : content,
      content,
      activeForm: typeof t.activeForm === "string" ? t.activeForm : undefined,
      status,
    })
  }
  return todos
}

/**
 * Sink for AG-UI stream events, expressed in terms of *accumulated* values so a
 * single implementation serves both transports: the `@ag-ui/client` `HttpAgent`
 * (which hands us running buffers) and the raw reconnect reader below (which
 * accumulates deltas itself). Keeping the sink shape identical means the UI
 * reducer wiring lives in exactly one place.
 */
export interface ChatEventHandlers {
  onTextStart: (messageId: string) => void
  onTextContent: (messageId: string, content: string) => void
  onToolStart: (
    parentMessageId: string | undefined,
    toolCallId: string,
    toolName: string
  ) => void
  onToolArgs: (toolCallId: string, args: string) => void
  onToolResult: (toolCallId: string, result: string) => void
  onTodos: (todos: AgentTodo[]) => void
  onGoalStatus: (status: AgentGoalStatus) => void
  onError: (message: string) => void
}

interface AguiWireEvent {
  type?: string
  messageId?: string
  parentMessageId?: string
  toolCallId?: string
  toolCallName?: string
  delta?: string
  content?: string
  message?: string
  name?: string
  value?: unknown
}

/**
 * Reconnects to a thread's in-flight run over a plain GET SSE stream and feeds
 * the same {@link ChatEventHandlers} sink as the live send path.
 *
 * The `HttpAgent` can't be used here: it always POSTs, which would start a
 * second run (409). This parses the wire format directly instead — the backend
 * emits one `data: {json}\n\n` frame per AG-UI event, plus `: keepalive`
 * comment lines we skip. Resolves when the stream closes (run finished/stopped).
 */
export async function consumeThreadStream(
  threadId: string,
  handlers: ChatEventHandlers,
  signal: AbortSignal
): Promise<void> {
  const res = await fetch(streamUrl(threadId), { signal })
  if (!res.ok || !res.body) {
    throw new Error(`Reconnect failed with status ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  // Deltas arrive incrementally; accumulate to the absolute value the sink wants.
  const textBuffers = new Map<string, string>()
  const argBuffers = new Map<string, string>()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split("\n")
      buffer = lines.pop() ?? "" // keep the trailing partial line
      for (const line of lines) {
        const trimmed = line.trimEnd()
        if (!trimmed.startsWith("data:")) continue // ": keepalive" comments, blanks
        const json = trimmed.slice("data:".length).trim()
        if (!json) continue
        let event: AguiWireEvent
        try {
          event = JSON.parse(json)
        } catch {
          continue
        }
        dispatch(event, handlers, textBuffers, argBuffers)
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

function dispatch(
  event: AguiWireEvent,
  handlers: ChatEventHandlers,
  textBuffers: Map<string, string>,
  argBuffers: Map<string, string>
): void {
  switch (event.type) {
    case "TEXT_MESSAGE_START": {
      if (event.messageId) {
        textBuffers.set(event.messageId, "")
        handlers.onTextStart(event.messageId)
      }
      break
    }
    case "TEXT_MESSAGE_CONTENT":
    case "TEXT_MESSAGE_CHUNK": {
      const id = event.messageId
      if (!id) break
      if (!textBuffers.has(id)) handlers.onTextStart(id)
      const next = (textBuffers.get(id) ?? "") + (event.delta ?? "")
      textBuffers.set(id, next)
      handlers.onTextContent(id, next)
      break
    }
    case "TOOL_CALL_START":
    case "TOOL_CALL_CHUNK": {
      const id = event.toolCallId
      if (!id) break
      if (!argBuffers.has(id)) {
        argBuffers.set(id, "")
        handlers.onToolStart(
          event.parentMessageId,
          id,
          event.toolCallName ?? "tool"
        )
      }
      if (event.delta) {
        const next = (argBuffers.get(id) ?? "") + event.delta
        argBuffers.set(id, next)
        handlers.onToolArgs(id, next)
      }
      break
    }
    case "TOOL_CALL_ARGS": {
      const id = event.toolCallId
      if (!id) break
      const next = (argBuffers.get(id) ?? "") + (event.delta ?? "")
      argBuffers.set(id, next)
      handlers.onToolArgs(id, next)
      break
    }
    case "TOOL_CALL_RESULT": {
      if (event.toolCallId) {
        handlers.onToolResult(event.toolCallId, event.content ?? "")
      }
      break
    }
    case "CUSTOM": {
      if (event.name === TODOS_EVENT_NAME) {
        const todos = parseTodos(event.value)
        if (todos) handlers.onTodos(todos)
      } else if (event.name === GOAL_STATUS_EVENT_NAME) {
        const goal = parseGoalStatus(event.value)
        if (goal) handlers.onGoalStatus(goal)
      }
      break
    }
    case "RUN_ERROR": {
      handlers.onError(event.message ?? "Run error")
      break
    }
    default:
      break
  }
}
