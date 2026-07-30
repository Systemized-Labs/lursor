import { useAgents } from "@/api/agents"
import { useGitHubConfig } from "@/api/github"
import { useProviders } from "@/api/providers"
import { useOpenRouterSettings } from "@/api/settings"
import { useWorkspaces } from "@/api/workspaces"

/**
 * Whether the first-run walkthrough has been seen. Kept in localStorage rather
 * than the database, like the other purely-local UI state (dock layout,
 * appearance, the active LAIOS connection): losing it costs nothing, because
 * every step's real state is derived from the backend below — a user who lands
 * back on the walkthrough sees each step already satisfied and one button to
 * leave.
 */
const COMPLETED_KEY = "lursor.onboarding.completed"

export function isOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(COMPLETED_KEY) === "1"
  } catch {
    // Private-mode / disabled storage: treat as complete so a broken localStorage
    // can never trap someone on the walkthrough.
    return true
  }
}

export function completeOnboarding(): void {
  try {
    localStorage.setItem(COMPLETED_KEY, "1")
  } catch {
    // Nothing to do — see above.
  }
}

export interface OnboardingStatus {
  /** A model source exists: an OpenRouter key (saved or from .env) or a custom endpoint. */
  modelReady: boolean
  /** A GitHub account is connected. Optional — it only unlocks the clone shortcut. */
  githubReady: boolean
  /** At least one workspace the user made. */
  workspaceReady: boolean
  /** At least one agent exists — without one, a conversation has nothing to run. */
  agentReady: boolean
  /** The workspace to open at the end (the first non-system one), if any. */
  firstWorkspaceId: string | null
  /** True until every underlying query has resolved once. */
  loading: boolean
}

/**
 * Live readiness of each onboarding step, derived entirely from state the app
 * already fetches — nothing about progress is stored. This is what makes the
 * walkthrough safe to re-enter and invisible to existing installs: someone who
 * already has a key and a workspace is, by definition, done.
 */
export function useOnboardingStatus(): OnboardingStatus {
  const openrouter = useOpenRouterSettings()
  const providers = useProviders()
  const github = useGitHubConfig()
  const workspaces = useWorkspaces()
  const agents = useAgents()

  // The skills catalog registers itself as a workspace on every boot (see
  // `ensure_skills_workspace`), so a fresh install is never empty — "has a
  // workspace" has to mean one the user chose.
  const own = (workspaces.data ?? []).filter((ws) => !ws.is_system)

  return {
    modelReady:
      Boolean(openrouter.data?.configured) || (providers.data ?? []).length > 0,
    githubReady: Boolean(github.data?.connected),
    workspaceReady: own.length > 0,
    agentReady: (agents.data ?? []).length > 0,
    firstWorkspaceId: own[0]?.id ?? null,
    loading:
      openrouter.isLoading ||
      providers.isLoading ||
      github.isLoading ||
      workspaces.isLoading ||
      agents.isLoading,
  }
}
