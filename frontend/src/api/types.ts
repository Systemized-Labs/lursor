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
  slug: string
  name: string
  description: string
  content: string
  // Bundled files discovered in the skill folder (relative paths). These are
  // what the agent can load via read_skill_resource / run_skill_script.
  resources: string[]
  scripts: string[]
  created_at: string
  updated_at: string
}

export interface SkillInput {
  name: string
  description: string
  content: string
}

export interface Subagent {
  id: string
  name: string
  description: string
  instructions: string
  model: string | null
  /** Set when this row overrides a pydantic-deep built-in of the same name. */
  builtin_name: string | null
  created_at: string
  updated_at: string
}

export interface SubagentInput {
  name: string
  description: string
  instructions: string
  model: string | null
}

/** A single integer default knob: what the library ships vs. the effective value. */
export interface ResolvedInt {
  library_default: number
  override: number | null
  effective: number
}

/** A pydantic-deep built-in subagent: its library default plus current state. */
export interface BuiltinSubagent {
  name: string
  default_description: string
  default_instructions: string
  enabled: boolean
  override: Subagent | null
}

export interface SubagentDefaults {
  max_nesting_depth: ResolvedInt
  builtins: BuiltinSubagent[]
}

export interface SubagentDefaultsUpdate {
  max_nesting_depth?: number | null
  clear_max_nesting_depth?: boolean
  disabled_builtins?: string[]
}

export interface BuiltinOverrideInput {
  description: string
  instructions: string
  model: string | null
}

export interface PromptTemplate {
  id: string
  name: string
  description: string
  category: string
  content: string
  is_builtin: boolean
  created_at: string
  updated_at: string
}

export interface PromptTemplateInput {
  name: string
  description: string
  category: string
  content: string
}

/** Capability subset sent to the prompt generator so output is capability-aware. */
export interface AgentPromptContext {
  name: string
  description: string
  include_todo: boolean
  include_subagents: boolean
  include_skills: boolean
  include_memory: boolean
  include_plan: boolean
  web_search: boolean
  thinking: ThinkingLevel
  skill_names: string[]
  tool_names: string[]
  model: string | null
}

export interface PromptGenerateRequest {
  brief: string
  context: AgentPromptContext
}

export interface PromptImproveRequest {
  current: string
  context: AgentPromptContext
}

export interface PromptResult {
  instructions: string
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

export interface ThreadMessageAttachment {
  media_id: string
  mime_type: string
  filename: string | null
}

export interface ThreadMessage {
  id: string
  thread_id: string
  role: MessageRole
  content: string
  // Backend persists this as an opaque JSON object (default `{}`); it is only
  // an array once real tool-call payloads are stored. Callers must narrow.
  tool_calls: ThreadMessageToolCall[] | Record<string, unknown> | null
  attachments?: ThreadMessageAttachment[]
  created_at: string
}

export type ThreadMode = "chat" | "goal"

/** The mode selected in the composer dropdown. `ask`/`edit` are per-turn
 *  modifiers on a chat thread; `plan` starts a goal thread (see `ThreadMode`). */
export type ChatMode = "ask" | "edit" | "plan"

/** Per-turn modifier sent with a chat message (`plan` is expressed by the
 *  thread being a goal thread, so it is not a TurnMode). */
export type TurnMode = "ask" | "edit"

/** Lifecycle of a goal-mode thread (mirrors backend `GoalStatus`). */
export type GoalStatus =
  | "idle"
  | "planning"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "stopped"

export interface Thread {
  id: string
  workspace_id: string
  agent_id: string
  title: string
  // Goal mode (a plain chat thread leaves these at their defaults).
  mode: ThreadMode
  goal: string
  success_criteria: string
  goal_status: GoalStatus
  iteration: number
  max_iterations: number
  require_plan_approval: boolean
  last_reason: string
  todos_snapshot: unknown[]
  created_at: string
  updated_at: string
}

export interface ThreadInput {
  workspace_id: string
  agent_id: string
  title: string
  // Optional goal-mode config supplied when starting a goal thread.
  mode?: ThreadMode
  goal?: string
  success_criteria?: string
  max_iterations?: number
  require_plan_approval?: boolean
}

export interface ThreadUpdate {
  title?: string
  // Swap the agent this conversation talks to; the next message uses it.
  agent_id?: string
  mode?: ThreadMode
  goal?: string
  success_criteria?: string
  max_iterations?: number
  require_plan_approval?: boolean
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

// --- laios control plane --------------------------------------------------------

/** A connection to a laios daemon control plane (`:7420`). */
export interface LaiosConnection {
  id: string
  name: string
  base_url: string
  // The master_key is never returned to the browser; only whether one is set.
  has_master_key: boolean
  created_at: string
  updated_at: string
}

export interface LaiosConnectionInput {
  name: string
  base_url: string
  master_key?: string | null
}

/** Result of probing a daemon's `/health` (+ `/v1/route`). */
export interface LaiosConnectionStatus {
  status: "ok" | "error"
  reachable: boolean
  role: string | null
  node_id: string | null
  version: string | null
  master_key_set: boolean | null
  error: string | null
}

export type LaiosInstanceStatus =
  | "pending"
  | "pulling"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"

export type LaiosEngine = "vllm" | "llamacpp" | "ollama"

/** A model instance served by the daemon (subset of the daemon's InstanceRecord). */
export interface LaiosInstance {
  id: string
  recipe_id: string
  model_id: string | null
  served_name: string
  engine: LaiosEngine
  status: LaiosInstanceStatus
  port: number
  host: string
  max_model_len: number
  vram_allocated_mb: number
  node_id: string
  endpoint: string
  error: string | null
  created_at: string
  updated_at: string
}

/** A curated recipe summary from the catalog. */
export interface LaiosRecipeSummary {
  id: string
  name: string
  engine: LaiosEngine
  model: string | null
  cluster_only: boolean
  description: string | null
  vram_estimate_mb: number | null
}

export interface LaiosBudget {
  total_mb: number
  reserved_mb: number
  allocated_mb: number
}

/** Per-node resource line in the cluster rollup. */
export interface LaiosNodeResources {
  node_id: string
  name: string
  role: "head" | "worker"
  status: string
  online: boolean
  gpus: number
  total_vram_mb: number
  free_vram_mb: number
}

/** Cluster-wide resource rollup; only online nodes contribute to totals. */
export interface LaiosClusterResources {
  node_count: number
  ready_node_count: number
  total_nodes_known: number
  total_gpus: number
  total_vram_mb: number
  free_vram_mb: number
  nodes: LaiosNodeResources[]
}

/** Response of the daemon's cluster/status, proxied through the backend. */
export interface LaiosClusterStatus {
  head_id: string
  role: string
  advertise: string
  workers: unknown[]
  join_token_set: boolean
  remotes: unknown[]
  heartbeat_timeout_secs: number
  resources: LaiosClusterResources
}

/** Serve knobs POSTed to the daemon (all optional except recipe). */
export interface LaiosServeInput {
  recipe: string
  max_model_len?: number
  port?: number
  served_name?: string
  solo?: boolean
}

export interface LaiosInstanceLogs {
  logs: string
}

export type LaiosJobStatus = "queued" | "running" | "succeeded" | "failed"

/** An async daemon job (currently only model pulls/downloads). */
export interface LaiosJob {
  id: string
  kind: string // "pull"
  status: LaiosJobStatus
  recipe_id: string | null
  result: { model_id: string; path: string; already_present: boolean } | null
  error: string | null
  created_at: string
  updated_at: string
}
