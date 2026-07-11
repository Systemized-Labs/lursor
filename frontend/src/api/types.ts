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
  created_at: string
  updated_at: string
}

export interface WorkspaceInput {
  name: string
  description: string
  // Optional custom folder location. Blank uses the default
  // ~/.lursor/workspaces/{id} location.
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

/** A single model in the catalogue (cloud or custom, grouped by provider). */
export interface ModelEntry {
  id: string
  label: string
  name: string
  /**
   * Exact string to persist on an agent so the run routes to the right backend
   * (e.g. `openrouter:anthropic/claude-opus-4` or `custom:{id}:llama3`). The
   * backend supplies this; older/fallback entries without it default to the
   * OpenRouter prefix.
   */
  value?: string
  description?: string
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
  modality?: string
  input_modalities?: string[]
}

export interface ModelGroup {
  label: string
  models: ModelEntry[]
}

/** A user-added, locally-hosted OpenAI-compatible model endpoint. */
export interface CustomProvider {
  id: string
  name: string
  base_url: string
  api_key: string | null
  created_at: string
  updated_at: string
}

export interface CustomProviderInput {
  name: string
  base_url: string
  api_key?: string | null
}
export interface ProviderHealth {
  status: "ok" | "error"
  model_count: number | null
  error: string | null
}

/** The user's GitHub connection status (token is never returned in full). */
export interface GitHubConfig {
  connected: boolean
  login: string | null
  name: string | null
  email: string | null
  avatar_url: string | null
  token_hint: string | null
  updated_at: string | null
}

export interface GitHubConfigInput {
  token: string
  name?: string | null
  email?: string | null
}

/** A repository the connected account can clone. */
export interface GitHubRepo {
  full_name: string
  name: string
  description: string | null
  private: boolean
  clone_url: string
  default_branch: string
  updated_at: string | null
}

export interface GitHubCloneInput {
  repo_full_name?: string
  clone_url?: string
  name?: string
  path?: string
}

/** OpenRouter API key status (the raw key is never returned). */
export interface OpenRouterSettings {
  configured: boolean
  key_hint: string | null
  // Where the effective key comes from: a UI-saved key, the environment/.env,
  // or nothing. Only a "database" key can be edited/cleared from the UI.
  source: "database" | "env" | "none"
}

export interface OpenRouterSettingsInput {
  api_key?: string | null
}

export interface OpenRouterTestResult {
  status: "ok" | "error"
  label: string | null
  error: string | null
}
