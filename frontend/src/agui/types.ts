export type ChatRole = "user" | "assistant" | "system" | "tool"

export interface ChatToolCall {
  id: string
  name: string
  args: string
  result?: string
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  toolCalls: ChatToolCall[]
  streaming?: boolean
}
