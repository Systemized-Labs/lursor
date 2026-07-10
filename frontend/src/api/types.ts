export type ThinkingLevel = "off" | "low" | "medium" | "high"

export interface Agent {
  id: string
  name: string
  description: string
  model: string | null
  instructions: string
  include_todo: boolean
  include_subagents: boolean
  include_skills: boolean
  include_memory: boolean
  include_plan: boolean
  web_search: boolean
  thinking: ThinkingLevel
  extra_config: Record<string, unknown>
  skill_ids: string[]
  tool_ids: string[]
  created_at: string
  updated_at: string
}

export interface AgentInput {
  name: string
  description: string
  model: string | null
  instructions: string
  include_todo: boolean
  include_subagents: boolean
  include_skills: boolean
  include_memory: boolean
  include_plan: boolean
  web_search: boolean
  thinking: ThinkingLevel
  extra_config: Record<string, unknown>
  skill_ids: string[]
  tool_ids: string[]
}

export interface Skill {
  id: string
  name: string
  description: string
  content: string
  created_at: string
  updated_at: string
}

export interface SkillInput {
  name: string
  description: string
  content: string
}

export type ToolKind = "builtin" | "mcp" | "http"

export interface Tool {
  id: string
  name: string
  description: string
  kind: ToolKind
  config: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface ToolInput {
  name: string
  description: string
  kind: ToolKind
  config: Record<string, unknown>
}

export interface Workspace {
  id: string
  name: string
  description: string
  path: string
  agent_ids: string[]
  created_at: string
  updated_at: string
}

export interface WorkspaceInput {
  name: string
  description: string
  agent_ids: string[]
  // Optional custom folder location. Blank uses the default
  // ~/.hearthstack/workspaces/{id} location.
  path?: string
}

export type MessageRole = "user" | "assistant" | "system" | "tool"

export interface ThreadMessageToolCall {
  id: string
  name: string
  arguments: string
}

export interface ThreadMessage {
  id: string
  thread_id: string
  role: MessageRole
  content: string
  // Backend persists this as an opaque JSON object (default `{}`); it is only
  // an array once real tool-call payloads are stored. Callers must narrow.
  tool_calls: ThreadMessageToolCall[] | Record<string, unknown> | null
  created_at: string
}

export interface Thread {
  id: string
  workspace_id: string
  agent_id: string
  title: string
  created_at: string
  updated_at: string
}

export interface ThreadInput {
  workspace_id: string
  agent_id: string
  title: string
}

export interface ThreadUpdate {
  title?: string
  // Swap the agent this conversation talks to; the next message uses it.
  agent_id?: string
}

export interface HealthResponse {
  status: string
  app: string
}
