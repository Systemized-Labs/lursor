import { useVideoCapability } from "@/api/videos"

/**
 * One line saying what the video toggle will actually reach.
 *
 * The toggle is only half the gate: the tools are built only when the configured
 * source (Settings → Image & video) can actually serve a model the backend knows
 * how to drive, so with the checkbox on and nothing serving, an agent silently
 * has no video tools. That is indistinguishable from a broken checkbox, hence
 * this.
 *
 * One sentence, because it replaces the toggle's static hint on a row that shows
 * exactly one line (see `capability-toggles.tsx`); anything longer is clipped.
 *
 * Shared between the agent and subagent editors so the wording can't drift.
 * Returns `null` while it loads, so the caller keeps showing the static hint
 * rather than a wrong claim.
 */
export function useVideoHint(enabled = true): string | null {
  const { data } = useVideoCapability(enabled)
  if (!data) return null
  if (!data.available) {
    return `No effect yet — ${data.reason}.`
  }
  const where = data.connection_name ? ` on ${data.connection_name}` : ""
  // An assumed profile — the recipe declares none, so the request shape is
  // inferred from the model's identity — is the more actionable caveat of the
  // two, so it takes the line when it applies.
  if (data.assumed) {
    return `Renders ${data.model}${where} with an assumed profile.`
  }
  // Cost first when there is one: a clip is the most expensive thing an agent
  // can do unprompted, and "$0.40 a second" is the number that decides whether
  // this toggle should be on at all.
  if (data.price) {
    const about = data.price.approximate ? "from " : ""
    return `Renders ${data.model}${where} — ${about}$${data.price.amount.toFixed(2)} a second.`
  }
  return `Renders ${data.model}${where} — minutes of GPU per clip.`
}
