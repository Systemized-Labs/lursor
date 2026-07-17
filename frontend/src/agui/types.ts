import type { MessageKind } from "@/api/types"

export type ChatRole = "user" | "assistant" | "system" | "tool"

export interface ChatToolCall {
  id: string
  name: string
  args: string
  result?: string
}

/** A media attachment rendered on a message, resolved to a displayable URL
 *  (an object/data URL while sending, a server media URL once persisted). */
export interface ChatAttachment {
  url: string
  mimeType: string
  name?: string
}

/** An image staged in the composer, before send. `base64` is the raw payload
 *  (no data-URI prefix) sent to the backend; `dataUrl` is for local preview. */
export interface PendingAttachment {
  id: string
  name: string
  mimeType: string
  dataUrl: string
  base64: string
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "blocked"

/** A single task from the agent's live todo list, mirrored from the backend's
 *  `todos` CUSTOM event (see `stream-reader`). */
export interface AgentTodo {
  id: string
  content: string
  /** Present-continuous label shown while the task is in progress. */
  activeForm?: string
  status: TodoStatus
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  /** Streamed reasoning/thinking tokens for this turn (reasoning models only).
   *  Shown as a collapsible block; transient, so it's not persisted and is absent
   *  after a reload. */
  reasoning?: string
  /** Set once the reasoning phase ends (the model moved on to its answer/tools),
   *  so the block can auto-collapse without waiting for the whole run to finish. */
  reasoningDone?: boolean
  toolCalls: ChatToolCall[]
  attachments?: ChatAttachment[]
  streaming?: boolean
  /** How a user turn was sent (chat/ask/plan/goal), for a history badge. */
  kind?: MessageKind
}

/** Goal lifecycle mirrored from the backend `goal_status` CUSTOM event. */
export type GoalRunStatus =
  | "planning"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "stopped"

/** Live goal state for the open conversation (see `stream-reader`). */
export interface AgentGoalStatus {
  status: GoalRunStatus
  condition: string
  iteration: number
  maxIterations: number
  reason: string
}
