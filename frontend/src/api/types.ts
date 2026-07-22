export type ThinkingLevel = "off" | "low" | "medium" | "high"

export type ToolChoice = "auto" | "required" | "none"

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
  browser_qa: boolean
  thinking: ThinkingLevel
  tool_choice: ToolChoice
  extra_config: Record<string, unknown>
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
  browser_qa: boolean
  thinking: ThinkingLevel
  tool_choice: ToolChoice
  extra_config: Record<string, unknown>
  tool_ids: string[]
}

/** Where a skill lives: user-global, or scoped to one workspace directory. */
export type SkillScope = "global" | "workspace"

export interface Skill {
  id: string
  slug: string
  name: string
  description: string
  content: string
  // global (~/.lursor/skills) or workspace (<workspace>/.agents/skills). On a
  // slug collision the workspace copy wins at build time.
  scope: SkillScope
  // Owning workspace when scope === "workspace"; null for global skills.
  workspace_id: string | null
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
  // Defaults to "global" on the backend when omitted; set both to create a
  // workspace-scoped skill.
  scope?: SkillScope
  workspace_id?: string | null
}

export interface Subagent {
  id: string
  name: string
  description: string
  instructions: string
  model: string | null
  include_todo: boolean
  include_subagents: boolean
  include_skills: boolean
  include_memory: boolean
  include_plan: boolean
  web_search: boolean
  thinking: ThinkingLevel
  tool_choice: ToolChoice
  /** When off, the subagent is kept but excluded from every agent at build time. */
  enabled: boolean
  extra_config: Record<string, unknown>
  tool_ids: string[]
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
  include_todo: boolean
  include_subagents: boolean
  include_skills: boolean
  include_memory: boolean
  include_plan: boolean
  web_search: boolean
  thinking: ThinkingLevel
  tool_choice: ToolChoice
  enabled: boolean
  extra_config: Record<string, unknown>
  tool_ids: string[]
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
  browser_qa: boolean
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

/** How a user turn was sent, surfaced as a history badge on the bubble. The
 *  assistant-authored `summary` marks a `/compact` digest that stands in for the
 *  messages it condensed (rendered as a distinct card, not a normal reply). */
export type MessageKind = "chat" | "ask" | "plan" | "goal" | "summary"

export interface ThreadMessageToolCall {
  id: string
  name: string
  arguments: string
  result?: string | null
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
  kind?: MessageKind
  /** The agent that ran this turn (snapshot; empty for legacy/system rows). */
  agent_id?: string | null
  agent_name?: string
  // Backend persists this as an opaque JSON object (default `{}`); it is only
  // an array once real tool-call payloads are stored. Callers must narrow.
  tool_calls: ThreadMessageToolCall[] | Record<string, unknown> | null
  attachments?: ThreadMessageAttachment[]
  created_at: string
}

/** How a thread is driven. Retained for backward compatibility with rows written
 *  by older builds — modes are no longer sticky (see {@link TurnIntent}); live
 *  threads stay `chat`. */
export type ThreadMode = "chat" | "plan" | "goal"

/** Per-turn intent sent with a message. `chat` is full tools (default); `ask`
 *  is a read-only turn; `goal` kicks off a one-off autonomous run; `plan`
 *  proposes a plan doc without executing; `execute_plan` carries an approved plan
 *  doc out as a goal (no message body). A plain `chat` turn while a plan is parked
 *  refines the doc rather than implementing it. All are per-turn — none are sticky. */
export type TurnIntent = "chat" | "ask" | "goal" | "plan" | "execute_plan"

/** Lifecycle of a plan/goal run (mirrors backend `ThreadStatus`; `goal_status`
 *  on the wire). */
export type RunStatus =
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
  // Plan/goal mode (a plain chat thread leaves these at their defaults).
  mode: ThreadMode
  goal: string
  success_criteria: string
  status: RunStatus
  // Plan mode: workspace-relative path of this thread's plan doc (else "").
  plan_path: string
  iteration: number
  max_iterations: number
  last_reason: string
  todos_snapshot: unknown[]
  created_at: string
  updated_at: string
}

export interface ThreadInput {
  workspace_id: string
  agent_id: string
  title: string
  // Optional plan/goal config supplied when entering that mode.
  mode?: ThreadMode
  goal?: string
  success_criteria?: string
  max_iterations?: number
}

export interface ThreadUpdate {
  title?: string
  // Swap the agent this conversation talks to; the next message uses it.
  agent_id?: string
  mode?: ThreadMode
  goal?: string
  success_criteria?: string
  max_iterations?: number
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

/** Clone a repo into an existing workspace's directory (as a subfolder). */
export interface GitHubCloneIntoInput {
  repo_full_name?: string
  clone_url?: string
  folder?: string
}

export interface GitHubCloneIntoResult {
  workspace_id: string
  path: string
  folder: string
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

/** App-wide web-search backend used by agents that have web search enabled. */
export type WebSearchProvider = "native" | "duckduckgo" | "tavily" | "exa"

/** Web-search configuration status (raw API keys are never returned). */
export interface WebSearchSettings {
  provider: WebSearchProvider
  tavily_configured: boolean
  tavily_key_hint: string | null
  tavily_source: "database" | "env" | "none"
  exa_configured: boolean
  exa_key_hint: string | null
  exa_source: "database" | "env" | "none"
}

export interface WebSearchSettingsInput {
  provider?: WebSearchProvider
  tavily_api_key?: string | null
  exa_api_key?: string | null
}

/**
 * Default agent per slash command. Each value is an agent id ("" when the
 * command has no default agent). Using a command in the composer switches to
 * (and, for an open thread, reassigns) that command's agent.
 */
export interface DefaultAgentsSettings {
  chat: string
  ask: string
  plan: string
  goal: string
}

export interface DefaultAgentsInput {
  chat?: string
  ask?: string
  plan?: string
  goal?: string
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

/** How far behind the daemon's checkout is; populated only when `?check=true`. */
export interface LaiosDaemonUpdateInfo {
  checked: boolean
  behind_by?: number
  remote?: string
  branch?: string
  error?: string
}

/** Running daemon build + how it's managed + optional update-availability. */
export interface LaiosDaemonVersion {
  version: string
  git_sha: string
  // "systemd" | "standalone" (open string in case the daemon adds modes).
  management_mode: string
  repo_dir: string | null
  update: LaiosDaemonUpdateInfo
}

/** Response of `POST /daemon/restart` (202). */
export interface LaiosDaemonRestart {
  restarting: boolean
  mode?: string
  pid?: number
  note?: string
}

/** Response of `POST /daemon/update` (202) — `log` is the tailable log name. */
export interface LaiosDaemonUpdateStarted {
  started: boolean
  log: string
  mode?: string
}

/** A tail of an in-progress update log; `active` means it was written recently. */
export interface LaiosDaemonUpdateLog {
  logs: string
  active: boolean
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
  /** Bytes on disk for the target so far — live download progress. */
  bytes_done?: number | null
  /** Best-effort total the repo is expected to occupy (null if unknown). */
  bytes_total?: number | null
  created_at: string
  updated_at: string
}
