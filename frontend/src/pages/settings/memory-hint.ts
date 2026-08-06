import { useMemorySettings } from "@/api/settings"

/**
 * One line naming where an agent's memory will actually be stored.
 *
 * The per-agent memory toggle says nothing about *where* memory lives — that is
 * an app-wide provider choice — so the agent and subagent editors show this
 * underneath it. Shared between the two forms so the wording can't drift.
 * Returns `null` while the setting is still loading, so the caller keeps showing
 * the toggle's static hint rather than a wrong claim.
 */
export function useMemoryHint(): string | null {
  const { data } = useMemorySettings()
  if (!data) return null
  if (data.provider === "hindsight" && data.hindsight_installed) {
    return `Stored in Hindsight bank “${data.bank_id}”, shared with your other tools.`
  }
  return "Stored in this workspace's MEMORY.md."
}
