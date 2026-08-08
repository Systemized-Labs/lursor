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
  include_video: boolean
  include_image: boolean
  thinking: ThinkingLevel
  tool_choice: ToolChoice
  /** Fraction of the context window at which this agent compacts, or null to use
   *  the app-wide default (see `useCompactionDefaults`). */
  compaction_threshold: number | null
  /** Fraction of the history compaction folds into the summary (1 = all of it),
   *  or null for the app-wide default. */
  compaction_ratio: number | null
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
  include_video: boolean
  include_image: boolean
  thinking: ThinkingLevel
  tool_choice: ToolChoice
  // Null clears the override and reverts to the app-wide default.
  compaction_threshold: number | null
  compaction_ratio: number | null
  extra_config: Record<string, unknown>
  tool_ids: string[]
}

/** Where a skill folder lives, which decides how it can be assigned.
 *
 *  `managed` — the catalog (`~/.lursor/skills`): one copy, re-pointable at any
 *  set of workspaces. `local` — one of the repo's own skill roots
 *  (`.agents/skills` and the other tools' in-repo conventions): applies only
 *  there and must be brought into the catalog before it can be reassigned.
 *  `external` — a personal directory owned by another tool (`~/.agents/skills`,
 *  `~/.claude/skills`, one per tool beyond that): read in place and in scope
 *  everywhere. */
export type SkillOrigin = "managed" | "local" | "external"

/** Which layer a skill won at when listing for one workspace. */
export type SkillLayer = "user" | "global" | "workspace" | "local"

export interface Skill {
  id: string
  slug: string
  name: string
  description: string
  content: string
  origin: SkillOrigin
  /** Applies in every workspace. Set for `managed` and `external` skills — a
   *  personal skill's reach is editable in place, and defaults to global when it
   *  is first discovered. */
  is_global: boolean
  /** The workspaces it is assigned to (empty if global or parked). */
  workspace_ids: string[]
  /** Local skills: the workspace whose folder holds it. */
  workspace_id: string | null
  /** Which root the folder lives in: workspace-relative for `local`
   *  (".claude/skills"), absolute for `external`, empty for the catalog. */
  root: string
  /** Display form of `root` (".claude", "~/.claude", "~/.config/agents"); empty
   *  for the catalog. */
  root_label: string
  /** False when the folder belongs to another tool: copy it into the catalog
   *  rather than moving it, and a delete removes a real file in the user's repo
   *  or home directory. */
  is_owned_root: boolean
  /** Set when this catalog entry is a *symlink* into another tool's directory: the
   *  absolute folder it points at. Managed in every other respect, but the files
   *  are the original — editing writes through, and deleting only unlinks. */
  link_target: string
  /** Display form of the root `link_target` lives in ("~/.claude"), for a badge
   *  saying whose files these really are. Empty when this is not a link. */
  link_label: string
  /** Off excludes the skill from every run, whatever its layer or assignment.
   *  The only off switch a repo-local skill has; for everything else it is the
   *  second axis — parked says where, this says whether. */
  enabled: boolean
  /** Why this skill's SKILL.md can't be loaded; empty when it parses. Set means
   *  the folder is still indexed and editable but is excluded from every run
   *  whatever its assignment, because the agent library parses frontmatter
   *  strictly and one bad file would fail the whole build. */
  error: string
  /** Set only in a per-workspace listing; null in catalog-wide ones. */
  layer: SkillLayer | null
  /** Env vars attached to this skill (ids only — values never leave the server). */
  env_var_ids: string[]
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
  /** Off keeps the skill but excludes it from every run. */
  enabled?: boolean
  /** Defaults to "managed" on the backend. "local" requires `workspace_id`. */
  origin?: SkillOrigin
  /** Omitted means "global unless workspace_ids were given". */
  is_global?: boolean
  workspace_ids?: string[]
  workspace_id?: string | null
}

export interface SkillAssignmentInput {
  is_global: boolean
  workspace_ids: string[]
}

/** One skill folder found in a workspace directory. */
export interface SkillScanEntry {
  /** Workspace-relative path of the folder (not its SKILL.md). */
  path: string
  slug: string
  name: string
  description: string
  /** Already managed — it lives in a discovered root, or was ingested before. */
  indexed: boolean
}

export interface SkillScanResult {
  skills: SkillScanEntry[]
}

/** Ingest skill folders already on disk inside a workspace. */
export interface SkillIngestInput {
  /** Workspace whose tree holds the folder. */
  workspace_id: string
  /** Workspace-relative folder: a skill folder, or one holding several. */
  path: string
  /** "managed" copies into the catalog, "local" into the repo's .agents/skills. */
  origin?: SkillOrigin
  /** Managed only. Omitted means "assign it to the workspace it came from". */
  is_global?: boolean
}

/** An environment variable Lursor injects into agent runs. */
export interface EnvVar {
  id: string
  key: string
  description: string
  /** Secret values are write-only: reads expose `has_value`, never `value`. */
  is_secret: boolean
  is_global: boolean
  workspace_ids: string[]
  skill_ids: string[]
  has_value: boolean
  /** Present only for non-secret vars. */
  value: string | null
  created_at: string
  updated_at: string
}

export interface EnvVarInput {
  key: string
  value?: string
  description?: string
  is_secret?: boolean
  is_global?: boolean
  workspace_ids?: string[]
  skill_ids?: string[]
}

export interface EnvVarUpdateInput {
  key?: string
  /** Omit to keep the stored value; "" clears it. */
  value?: string
  description?: string
  is_secret?: boolean
}

export interface EnvVarAssignmentInput {
  is_global: boolean
  workspace_ids: string[]
  skill_ids: string[]
}

/** One key in a workspace's effective environment. Never carries a value. */
export interface ResolvedEnvEntry {
  key: string
  description: string
  /** "global" | "workspace" | "skill:<slug>" — the layer that won. */
  source: string
  /** Every layer that set the key, lowest precedence first (>1 means shadowing). */
  overridden: string[]
  has_value: boolean
}

export interface ResolvedEnv {
  workspace_id: string
  entries: ResolvedEnvEntry[]
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
  include_video: boolean
  include_image: boolean
  thinking: ThinkingLevel
  tool_choice: ToolChoice
  /** Compaction overrides for this subagent's own context; null uses the app-wide
   *  default (never the parent agent's override). */
  compaction_threshold: number | null
  compaction_ratio: number | null
  /** When off, the subagent is kept but excluded from every agent at build time. */
  enabled: boolean
  extra_config: Record<string, unknown>
  tool_ids: string[]
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
  include_video: boolean
  include_image: boolean
  thinking: ThinkingLevel
  tool_choice: ToolChoice
  compaction_threshold: number | null
  compaction_ratio: number | null
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

/** A pydantic-deep built-in subagent: its library default plus current state.
 *
 * Read-only apart from `enabled`. To change what a built-in does, switch it off
 * and create an ordinary subagent seeded from these defaults.
 */
export interface BuiltinSubagent {
  name: string
  default_description: string
  default_instructions: string
  enabled: boolean
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
  include_video: boolean
  include_image: boolean
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
  // App-owned workspace (the skills catalog). Computed from the path server
  // side; can be renamed but not deleted or relocated.
  is_system: boolean
  // The Assistant workspace. App-owned like the skills catalog, and pinned
  // beside it in the sidebar rather than listed among your projects. Any agent
  // used in here also holds Lursor's control-plane tools, which is why the
  // server refuses to move or delete it.
  is_assistant?: boolean
  // Sidebar placement: the {@link WorkspaceFolder} this row is filed under (null
  // at the root level), and its slot among its siblings there.
  folder_id: string | null
  position: number
  created_at: string
  updated_at: string
}

/**
 * A sidebar group for workspaces — a name and a place in the list, nothing on
 * disk. Groups live in the same root ordering space as the ungrouped
 * workspaces, so `position` interleaves the two lists.
 */
export interface WorkspaceFolder {
  id: string
  name: string
  position: number
  created_at: string
  updated_at: string
}

/** One row's desired spot, as sent to the layout endpoint after a drop. */
export interface FolderPlacement {
  id: string
  position: number
}

export interface WorkspacePlacement {
  id: string
  folder_id: string | null
  position: number
}

/** The whole workspace tree, sent in full rather than as a delta. */
export interface SidebarLayout {
  folders: FolderPlacement[]
  workspaces: WorkspacePlacement[]
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
/** How a turn was sent. `cron` is a turn a {@link Schedule} fire synthesized, so
 *  it renders as machine-originated rather than as something the user typed. */
export type MessageKind =
  | "chat"
  | "ask"
  | "plan"
  | "goal"
  | "cron"
  | "summary"

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
  /** Set when a {@link Schedule} fire opened this conversation. Scheduled threads
   *  are *included* in a workspace's conversation list by default — they're
   *  ordinary threads, and hiding them hid the only signal that an overnight run
   *  had finished. Pass `include_scheduled=false` to leave them out. */
  schedule_id?: string | null
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

// --- Scheduled jobs -----------------------------------------------------------

/** What a fire runs. `chat` is one turn (cheap, bounded, the default); `goal` runs
 *  the autonomous loop until its success criteria are met or `max_iterations` is
 *  spent. Plan mode isn't offered — a schedule that parks a doc awaiting approval
 *  nobody gives is a trap. */
export type ScheduleRunType = "chat" | "goal"

/** Outcome of one attempted fire. `missed` means the app wasn't running when it
 *  came due (fires are reported, never replayed); `skipped` means the previous
 *  fire was still going; `error` means the launch itself failed. */
export type ScheduleFireStatus = "launched" | "skipped" | "missed" | "error"

/** One attempted fire, including the ones that didn't run. */
export interface ScheduleRun {
  id: string
  schedule_id: string
  /** The conversation it opened — null for a fire that never got that far. */
  thread_id: string | null
  fired_at: string
  status: ScheduleFireStatus
  /** For `missed`: how many occurrences elapsed while the app was closed. */
  missed_count: number
  detail: string
}

export interface Schedule {
  id: string
  name: string
  description: string
  enabled: boolean
  workspace_id: string
  agent_id: string
  /** Standard 5-field cron ("30 9 * * 1-5"). */
  cron: string
  /** IANA zone name — what makes "every day at 9am" survive DST. */
  timezone: string
  prompt: string
  run_type: ScheduleRunType
  success_criteria: string
  max_iterations: number
  /** When it next fires; null while disabled (nothing is ever due). */
  next_fire_at: string | null
  last_fired_at: string | null
  /** Newest attempted fire, inlined so a list can flag a bad last outcome. */
  last_run: ScheduleRun | null
  created_at: string
  updated_at: string
}

export interface ScheduleInput {
  name?: string
  description?: string
  enabled?: boolean
  workspace_id: string
  agent_id: string
  cron: string
  timezone: string
  prompt: string
  run_type?: ScheduleRunType
  success_criteria?: string
  max_iterations?: number
}

/** Partial update. `next_fire_at` is scheduler state and isn't settable — the
 *  backend recomputes it when `cron`, `timezone` or `enabled` changes. */
export type ScheduleUpdateInput = Partial<Omit<ScheduleInput, "workspace_id">> & {
  workspace_id?: string
}

export interface CronPreview {
  cron: string
  timezone: string
  /** ISO instants, ascending. */
  occurrences: string[]
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
  /** Comma/newline-separated model IDs, used when /models isn't readable. */
  manual_models: string
  created_at: string
  updated_at: string
}

export interface CustomProviderInput {
  name: string
  base_url: string
  api_key?: string | null
  manual_models?: string
}
export interface ProviderHealth {
  status: "ok" | "error"
  model_count: number | null
  error: string | null
  /** Caveat on an otherwise-ok result, e.g. discovery fell back to manual IDs. */
  note?: string | null
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

/** The stored GitHub token in full — only from the explicit reveal route. */
export interface GitHubTokenReveal {
  token: string
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

/** The effective OpenRouter key in full — only from the explicit reveal route. */
export interface OpenRouterKeyReveal {
  api_key: string
  source: "database" | "env"
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

/** The web-search providers that hold an API key. */
export type KeyedSearchProvider = "tavily" | "exa"

/** One provider's effective key in full — only from the reveal route. */
export interface WebSearchKeyReveal {
  provider: KeyedSearchProvider
  api_key: string
  source: "database" | "env"
}

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
 * App-wide memory backend for every agent with memory enabled. "file" is the
 * per-workspace `MEMORY.md` the agent library ships; "hindsight" replaces it with
 * retain/recall/reflect against a Hindsight memory bank the user owns.
 */
export type MemoryProvider = "file" | "hindsight"

/**
 * How much of the Hindsight bank a workspace can see. "workspace" partitions it
 * by tag; "shared" puts the whole bank in scope everywhere — the mode for a bank
 * already filled by the user's other tools.
 */
export type MemoryIsolation = "workspace" | "shared"

/** Server-side retrieval effort for recall (and reflect). */
export type RecallBudget = "low" | "mid" | "high"

/** Memory configuration status (the raw Hindsight key is never returned). */
export interface MemorySettings {
  provider: MemoryProvider
  // False when the backend process lacks the optional `hindsight` extra: the
  // provider can be selected but silently degrades to file memory.
  hindsight_installed: boolean
  hindsight_base_url: string | null
  hindsight_configured: boolean
  hindsight_key_hint: string | null
  hindsight_source: "database" | "env" | "none"
  bank_id: string
  isolation: MemoryIsolation
  budget: RecallBudget
  max_tokens: number
  inject_memories: boolean
  include_reflect: boolean
  extra_recall_tags: string[]
  recall_query: string
}

export interface MemorySettingsInput {
  provider?: MemoryProvider
  hindsight_base_url?: string | null
  hindsight_api_key?: string | null
  bank_id?: string | null
  isolation?: MemoryIsolation
  budget?: RecallBudget
  max_tokens?: number
  inject_memories?: boolean
  include_reflect?: boolean
  extra_recall_tags?: string[]
  recall_query?: string | null
}

export interface MemoryTestResult {
  status: "ok" | "error"
  version: string | null
  bank_exists: boolean | null
  memory_count: number | null
  error: string | null
}

/**
 * Default agent per slash command — a command name mapped to an agent id. A key
 * is absent when the command has no default agent. `/plan` reassigns the open
 * thread to its agent (sticky); `/ask` and `/goal` run one-off under their agent;
 * `chat` seeds a new conversation. The backend stores this as an open map, so the
 * known keys below are the current registry commands, not a closed set.
 */
export interface DefaultAgentsSettings {
  chat?: string
  ask?: string
  plan?: string
  goal?: string
}

export type DefaultAgentsInput = DefaultAgentsSettings

/**
 * The app-wide compaction defaults an agent with no override of its own runs on.
 * Editable on the Settings page; each agent and subagent can still override them
 * with its own `compaction_threshold` / `compaction_ratio`.
 */
export interface CompactionDefaults {
  /** Effective fraction of the context window at which compaction fires. */
  threshold: number
  /** Effective fraction of the history folded into the summary (1 = all of it). */
  ratio: number
  /** Model that writes the summary, as a stored routing string
   *  (`openrouter:…` / `custom:{provider}:{model}`) — small and fast by default,
   *  never the thread agent's own (possibly heavy or offline) model. */
  model: string
  /** Whether each effective value was saved here or came from the backend's
   *  environment. Only a `database` value can be reset. */
  threshold_source: "database" | "env"
  ratio_source: "database" | "env"
  model_source: "database" | "env"
  /** What a reset restores. */
  env_threshold: number
  env_ratio: number
  env_model: string
}

/** Partial save: an omitted knob is left alone, an explicit `null` clears it back
 *  to the backend's environment value. */
export interface CompactionDefaultsInput {
  threshold?: number | null
  ratio?: number | null
  model?: string | null
}

// --- laios control plane --------------------------------------------------------

/** A connection to a laios daemon control plane (`:7420`). */
export interface LaiosConnection {
  id: string
  name: string
  base_url: string
  /**
   * Where this box's models are reached, when that differs from the control
   * plane's host on `:4000` — a lastway tunnel, typically. Managing a box and
   * calling its models are independent paths: management stays on the LAN while
   * inference (chat and `/v1/videos`) can go over the tunnel. Null derives it
   * from `base_url`.
   */
  gateway_url: string | null
  // The master_key is never returned to the browser; only whether one is set.
  has_master_key: boolean
  created_at: string
  updated_at: string
}

export interface LaiosConnectionInput {
  name: string
  base_url: string
  master_key?: string | null
  gateway_url?: string | null
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

export type LaiosEngine = "vllm" | "sglang" | "llamacpp" | "ollama"

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

/**
 * Placement constraints a recipe declares. Mirrors the daemon's
 * `RecipeClusterSummary`: which topologies it accepts and, for multi-node, how
 * many nodes it needs and how ranks are wired.
 */
export interface LaiosRecipeCluster {
  /** Refuses single-node serve — needs `nodes[]`. */
  cluster_only: boolean
  /** Refuses `nodes[]` — one node only (but may be placed on a worker). */
  solo_only: boolean
  /** "ray" | "mp" — how a multi-node serve joins ranks. */
  distributed: string
  min_nodes?: number
  max_nodes?: number
  /**
   * Tensor-parallel width. A shard's per-rank VRAM is roughly
   * `vram_estimate_mb / tensor_parallel`, so fit against a multi-node placement
   * can only be predicted with this. Absent on older daemons.
   */
  tensor_parallel?: number
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
  /** Absent on daemons older than the cluster summary — treat as unconstrained. */
  cluster?: LaiosRecipeCluster
}

/** The live instance (if any) serving a model, embedded in a model summary. */
export interface LaiosModelRunningInstance {
  id: string
  status: LaiosInstanceStatus
  endpoint: string
  node_id: string
  served_name: string
  max_model_len: number
}

/**
 * A model in the daemon's on-disk inventory (distinct from a catalog recipe):
 * downloaded weights plus run history (#36) and any live instance. Fields
 * mirror the daemon's `ModelSummary`.
 */
export interface LaiosModel {
  id: string
  recipe_id: string
  model_id: string | null
  name: string
  engine: LaiosEngine
  source: string
  capabilities: string[]
  installed: boolean
  /** Whether a catalog recipe still references this model (else it's orphaned). */
  recipe_present: boolean
  path: string
  bytes_total: number
  served_model_name: string
  running_instance?: LaiosModelRunningInstance
  available_on_nodes: string[]
  /** Other recipe ids that can serve these same weights (e.g. solo vs cluster). */
  usable_recipes: string[]
  /** How many times this recipe has been successfully served (#36). */
  run_count: number
  /** RFC3339 timestamp of the most recent successful serve, if any. */
  last_served_at?: string | null
  /** Context window the most recent run actually used. */
  last_max_model_len?: number | null
  /** Node the most recent run was placed on. */
  last_node_id?: string | null
}

/**
 * A model-data directory on disk with no manifest: a partial/dead download or
 * weights unmatched to any current recipe (#35). `looks_complete` tells the two
 * apart. Mirrors the daemon's `OrphanedModelDir`.
 */
export interface LaiosOrphanedModel {
  dir_name: string
  path: string
  bytes_on_disk: number
  looks_complete: boolean
}

/** Result of deleting a model's weights: how much disk was reclaimed. */
export interface LaiosModelDeleted {
  id: string
  model_id: string | null
  bytes_freed: number
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

export type LaiosWorkerStatus =
  | "joining"
  | "ready"
  | "busy"
  | "unhealthy"
  | "offline"

/** A cluster worker as tracked by the head; mirrors the daemon's `WorkerInfo`. */
export interface LaiosWorker {
  id: string
  name: string
  advertise: string
  status: LaiosWorkerStatus
  last_heartbeat: string
  joined_at: string
}

/** A remote OpenAI-compatible route the head federates to. */
export interface LaiosRemoteRoute {
  name: string
  base_url: string
  models: string[]
  healthy: boolean
  last_checked: string | null
}

/** Response of the daemon's cluster/status, proxied through the backend. */
export interface LaiosClusterStatus {
  head_id: string
  role: string
  advertise: string
  workers: LaiosWorker[]
  join_token_set: boolean
  remotes: LaiosRemoteRoute[]
  heartbeat_timeout_secs: number
  resources: LaiosClusterResources
}

/** The head's cluster join token (what a new worker needs to join). */
export interface LaiosClusterToken {
  join_token: string
}

/** Per-served-model line in the gateway metrics rollup. */
export interface LaiosModelMetrics {
  served_name: string
  instance_id: string
  status: LaiosInstanceStatus
  node_id: string
  uptime_seconds: number
  request_count: number
  input_tokens: number
  output_tokens: number
  tokens_per_second: number
}

/** Response of the daemon's `/v1/metrics/summary`. */
export interface LaiosMetricsSummary {
  metrics_available: boolean
  metrics_enabled: boolean
  gateway_metrics_url: string | null
  models: LaiosModelMetrics[]
}

/** One actionable check in the daemon's `/v1/doctor` diagnostics. */
export interface LaiosDoctorCheck {
  name: string
  ok: boolean
  detail: string
}

/** Daemon self-diagnostics (platform probe + checks). */
export interface LaiosDoctorReport {
  // The full platform probe; we only surface the checks + overall status.
  platform: Record<string, unknown>
  ok: boolean
  checks: LaiosDoctorCheck[]
}

/** Serve knobs POSTed to the daemon (all optional except recipe). */
/**
 * Serve knobs posted to the daemon's `/v1/serve`. Placement is a choice of
 * exactly one of three shapes — the daemon rejects `worker` + `nodes` together:
 *
 * - `solo: true` — one engine on the head.
 * - `worker` — one engine on that peer (id, name, fabric IP, or `"auto"` for
 *   the Ready worker with the most free VRAM). The head's gateway still fronts it.
 * - `nodes` — one model sharded across ranks; `nodes[0]` **must** be the head's
 *   fabric IP, the rest must be Ready workers' fabric IPs.
 */
export interface LaiosServeInput {
  recipe: string
  max_model_len?: number
  port?: number
  served_name?: string
  solo?: boolean
  worker?: string
  nodes?: string[]
  gpu_memory_utilization?: number
  extra_args?: string[]
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

export type LaiosJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"

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

/**
 * Where an audio-video generation has got to. The engine's own vocabulary,
 * relayed as-is; `cancelled` is set by us when a job is cancelled.
 */
export type LaiosVideoStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"

/**
 * One clip we asked a laios gateway to generate.
 *
 * Persisted by Lursor rather than read back from the gateway: the gateway's
 * job → upstream map is in-memory and bounded, so this row is what survives a
 * restart and what gives the page a history of runs.
 */
export interface LaiosVideoJob {
  /** Our row id. */
  id: string
  /** Which source produced it. Every row written before the setting is `laios`. */
  provider: MediaProvider
  /** The box or custom provider it ran on, or `""` on OpenRouter. */
  connection_id: string
  /** What the provider says it cost. Null on laios, which reports no price. */
  cost_usd: number | null
  /** The upstream job id — what every follow-up call routes on. */
  job_id: string
  model: string
  prompt: string
  task: string
  /** The submitted body verbatim, so a run can be repeated or diffed. */
  request: Record<string, unknown>
  status: LaiosVideoStatus
  /**
   * Percent, 0–100 — not a 0–1 fraction.
   *
   * MiniMax-H3 only ever reports 0 or 100: it sits at `queued`/0 for the whole
   * run (denoising starts immediately regardless) and flips straight to
   * `completed`/100. So this is a completion flag in practice, not a progress
   * bar, and elapsed-vs-estimate is the only live signal available.
   */
  progress: number | null
  error: string | null
  /** Content-addressed mp4 in the media store, once downloaded. */
  media_id: string | null
  created_at: string
  updated_at: string
}

/**
 * Whether anything connected can generate video, and what would be used.
 *
 * The `include_video` agent toggle is gated on a box actually serving a model the
 * backend knows how to drive, so the editor states the outcome rather than leaving
 * a checkbox that silently does nothing.
 */
/**
 * Which kind of thing generated (or would generate) a piece of media.
 *
 * `laios` is a self-hosted box (billed in electricity), `openrouter` is the hosted
 * API (billed per image or per second), `custom` is a user-added
 * OpenAI-compatible endpoint (billed in whatever that endpoint bills in — usually
 * nothing, since it is usually also your own hardware).
 */
export type MediaProvider = "laios" | "openrouter" | "custom"

/**
 * Where images and clips are generated — a **source ref**, not just a provider.
 *
 * An app-wide choice, made in Settings → Image & video, not a per-agent or per-run
 * one. `"openrouter"`, `"laios"` / `"laios:{connection}"`, or
 * `"custom:{provider}"`; see `app/media/refs.py` for the grammar. A plain string
 * rather than a union because the custom form carries an id.
 *
 * The source **never falls back**: if the configured one cannot serve, generation
 * fails with a reason rather than quietly using another. Every surface that can
 * report "unavailable" therefore has to show the `reason` alongside it.
 */
export type MediaSource = string

/** A rate, and what it is charged per. Null everywhere nothing is known. */
export interface MediaPrice {
  amount: number
  /** `"image"`, `"megapixel"`, or `"second"` (of output video). */
  unit: string
  /**
   * A floor rather than a quote.
   *
   * Video rates vary by resolution and by whether audio is on, an image rate can
   * vary by resolution or by provider, and an image price with no published rate
   * is the mean of what past runs actually cost — so each is rendered with a
   * qualifier ("from", "about") rather than as an exact number.
   */
  approximate: boolean
}

/** One image or video model, from any source, as the pickers render it. */
export interface MediaModelOption {
  /**
   * The stable id: `openrouter:{slug}`, `laios:{connection}:{served}` or
   * `custom:{provider}:{model}`.
   */
  ref: string
  /** The bare name to put in a request's `model` field. */
  id: string
  label: string
  provider: MediaProvider
  note: string
  price: MediaPrice | null
  connection_name: string
  /** Present only for an OpenRouter image model — the knobs it accepts. */
  openrouter: {
    aspect_ratios: string[]
    resolutions: string[]
    qualities: string[]
    formats: string[]
    seed: boolean
  } | null
  /**
   * Present only for a custom-provider model — how it was identified.
   *
   * `declared: false` means the endpoint says nothing about which of its models
   * generate images and the id merely *looks* like one, so the request may be
   * rejected. Worth surfacing rather than folding into `note`: it is the one thing
   * on this row that can be wrong about the model existing at all.
   */
  custom: { declared: boolean } | null
  /**
   * This build's own measurements. Present for a laios or custom-provider image
   * model (neither endpoint publishes any), null for a hosted one.
   */
  profile: {
    label: string
    default_steps: number
    min_steps: number
    max_steps: number
    guidance: boolean
    seconds_per_step: number | null
  } | null
}

/** The video sibling: one flat shape covering both sources' constraints. */
export interface MediaVideoModelOption {
  ref: string
  id: string
  label: string
  provider: MediaProvider
  note: string
  price: MediaPrice | null
  observed_cost: number | null
  connection_name: string
  resolutions: string[]
  aspect_ratios: string[]
  sizes: string[]
  /** Discrete allowed lengths, not a range. Empty means unconstrained. */
  durations: number[]
  keyframes: boolean
  audio: boolean
  seed: boolean
  /** Present only for a custom-provider model — see {@link MediaModelOption}. */
  custom: { declared: boolean } | null
}

/** What `/media/{images,videos}/models` returns for one source. */
export interface MediaModelList<T> {
  /** Which kind of source answered — the bare provider, not the full ref. */
  source: MediaProvider
  available: boolean
  /** Why not, when `available` is false. Always worth showing. */
  reason: string
  models: T[]
}

/** The configured source and model for one modality, and what it resolves to. */
export interface MediaModalitySettings {
  source: MediaSource
  /** The pinned model ref, or null for "auto — the cheapest the source offers". */
  model: string | null
  model_source: "database" | "auto"
  available: boolean
  reason: string
  effective_model: string | null
}

/** One user-added endpoint the source picker can offer. */
export interface MediaSourceOption {
  /** The source ref to save — `custom:{id}`, already formatted. */
  ref: string
  name: string
  base_url: string
}

export interface MediaSettings {
  image: MediaModalitySettings
  video: MediaModalitySettings
  openrouter_configured: boolean
  laios_connected: boolean
  /**
   * Every custom provider, listed whether or not it currently serves media.
   *
   * Same argument as not disabling OpenRouter without a key: being told what to do
   * next beats a greyed-out row with no explanation, and the backend does not
   * probe these on read, so listing them costs nothing.
   */
  custom_providers: MediaSourceOption[]
}

/** Partial: the image and video choices save independently. */
export interface MediaSettingsInput {
  image_source?: MediaSource
  image_model?: string | null
  video_source?: MediaSource
  video_model?: string | null
}

export interface VideoCapability {
  available: boolean
  /** Which source resolved, or null when none could. */
  source: MediaProvider | null
  /** Served name of the model that would be used, when one resolves. */
  model: string | null
  connection_name: string | null
  /** The request shape was inferred from the model's identity, not declared by its
   *  recipe — the one case where the backend trusts a measurement. */
  assumed: boolean
  /** Published rate per second, when the source quotes one. */
  price: MediaPrice | null
  /** The model was pinned in Settings rather than chosen by the resolver. */
  pinned: boolean
  /** One sentence: which model, or why none. */
  reason: string
}

/**
 * Whether anything connected can generate images, and what would be used.
 *
 * The image sibling of {@link VideoCapability}, gating the `include_image` agent
 * toggle for the same reason: a checkbox with nothing serving is indistinguishable
 * from a broken one.
 */
export interface ImageCapability {
  available: boolean
  /**
   * Which source resolved, or null when none could.
   *
   * The first thing the editor has to say: a "no" that does not name the source
   * reads as broken rather than as a choice, because the source never falls back
   * to the other one.
   */
  source: MediaProvider | null
  /** Served name (laios/custom) or slug (OpenRouter) of the model used. */
  model: string | null
  connection_name: string | null
  /** Every serving image model, so the editor can say there is more than one. */
  models: string[]
  /**
   * The default is a model this build has no measurements for.
   *
   * Not the same as video's `assumed`: an unmeasured image model genuinely works
   * — the request shape is shared across recipes — it just gets conservative
   * defaults and no time estimate.
   */
  unrecognised: boolean
  /** What one image costs, when anything is known. Null is "we do not know". */
  price: MediaPrice | null
  /** The default is a model the user pinned in Settings, not the resolver's pick. */
  pinned: boolean
  /** One sentence: which model, or why none. */
  reason: string
}

/** The knobs the video page sends. Relayed to the engine unaltered. */
export interface LaiosVideoInput {
  /** Source ref (`"openrouter"`, `"laios:{id}"`). Omit for the configured one. */
  source?: string
  model: string
  prompt: string
  /**
   * `t2va` — prompt only, which is all this page sends.
   *
   * `fl2va` (first/last-frame conditioning) goes through the same JSON body with a
   * `conditions` array, and is driven by the agent tools rather than from here; the
   * composer has no frame picker.
   */
  task: string
  target: {
    short_edge: number
    aspect_ratio: string
    duration_seconds: number
  }
  num_inference_steps: number
  seed?: number
}

/**
 * Where an image generation has got to.
 *
 * Ours, not the engine's — `/v1/images/generations` is synchronous and reports no
 * states at all. `running` means the backend is holding that call open; there is
 * deliberately no `cancelled`, because the engine has no cancel and a generation
 * already on a GPU keeps it until it finishes.
 */
export type LaiosImageStatus = "running" | "completed" | "failed"

/**
 * One image we asked a laios gateway to generate.
 *
 * The row is the only record of a generation: unlike a clip there is no upstream
 * job to poll, so if this is `running` it is because a backend task is waiting on
 * the gateway. A `running` row with no task behind it (a restart mid-generation)
 * is failed on the next list rather than left spinning.
 */
export interface LaiosImageRun {
  /** Our row id — what every route here is keyed by. */
  id: string
  /** Which source produced it. Every row written before the setting is `laios`. */
  provider: MediaProvider
  /** The box or custom provider it ran on, or `""` on OpenRouter. */
  connection_id: string
  /** What the provider says it cost. Null on laios, which reports no price. */
  cost_usd: number | null
  model: string
  prompt: string
  /**
   * The gateway's id for the image. Only load-bearing on the `response_format:
   * "url"` path, which the backend does not ask for; kept because it is what
   * correlates a run with the gateway's own logs.
   */
  upstream_id: string | null
  /** The submitted body verbatim, so a run can be repeated or diffed. */
  request: Record<string, unknown>
  status: LaiosImageStatus
  error: string | null
  /** Content-addressed image in the media store, once stored. */
  media_id: string | null
  /** The engine's own measurement, straight off the response. */
  inference_time_s: number | null
  peak_memory_mb: number | null
  created_at: string
  updated_at: string
}

/**
 * The knobs the image page sends. Relayed to the engine unaltered, except that
 * the backend forces `response_format: "b64_json"` and `n: 1` — see
 * `api/images.py`.
 *
 * Every field past `prompt` is optional because the two image recipes do not take
 * the same ones: `negative_prompt` and `true_cfg_scale` only mean anything to
 * `qwen-image-2512` (they are what turn CFG on and off), and sending them to
 * `z-image-turbo` would enable guidance a distilled turbo checkpoint does not
 * want. The composer decides per model; this type just carries the result.
 */
export interface LaiosImageInput {
  /** Source ref (`"openrouter"`, `"laios:{id}"`). Omit for the configured one. */
  source?: string
  model: string
  prompt: string
  /** `"1024x1024"` — the engine also accepts `width`/`height` separately. */
  size?: string
  num_inference_steps?: number
  seed?: number
  negative_prompt?: string
  /** Set to 1 to disable classifier-free guidance outright. */
  true_cfg_scale?: number
  /** `"png" | "jpeg" | "webp"`. The engine defaults to jpeg. */
  output_format?: string
  /** OpenRouter only: a ratio rather than a pixel size, and a quality tier. */
  aspect_ratio?: string
  resolution?: string
  quality?: string
}

/**
 * What Lursor can see of a local Hermes install and of our plugin inside it.
 *
 * Detection only: Lursor reads another tool's directory and never writes to it,
 * so the Integrations page shows these commands for the operator to run rather
 * than running them itself.
 */
export interface HermesIntegration {
  hermes_present: boolean
  home: string
  /** Absolute path to the `hermes` CLI, or "" when it could not be located. */
  cli_path: string
  plugin_installed: boolean
  /** The plugin directory is a symlink, i.e. wired to a working checkout. */
  plugin_linked: boolean
  plugin_enabled: boolean
  installed_version: string
  available_version: string
  update_available: boolean
  install_command: string
  enable_command: string
  detail: string
}
