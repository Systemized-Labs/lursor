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

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  toolCalls: ChatToolCall[]
  attachments?: ChatAttachment[]
  streaming?: boolean
}
