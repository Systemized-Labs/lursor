import { useImageCapability } from "@/api/images"

/**
 * One line saying what the image toggle will actually reach.
 *
 * The sibling of `video-hint.ts`, and it exists for the same reason: the toggle is
 * only half the gate, so with the checkbox on and nothing serving, an agent
 * silently has no image tool — indistinguishable from a broken checkbox.
 *
 * One sentence, because it replaces the toggle's static hint on a row that shows
 * exactly one line (see `capability-toggles.tsx`); anything longer is clipped.
 *
 * Shared between the agent and subagent editors so the wording can't drift.
 * Returns `null` while it loads, so the caller keeps showing the static hint
 * rather than a wrong claim.
 */
export function useImageHint(enabled = true): string | null {
  const { data } = useImageCapability(enabled)
  if (!data) return null
  if (!data.available) {
    return `No effect yet — ${data.reason}.`
  }
  const where = data.connection_name ? ` on ${data.connection_name}` : ""
  // An unmeasured model still works — unlike video's assumed profile, the request
  // shape here is shared across recipes — so this says "untested", not "unusable".
  if (data.unrecognised) {
    return `Generates with ${data.model}${where}, untested by this build.`
  }
  const others = data.models.length - 1
  const extra = others > 0 ? `, +${others} more` : ""
  return `Generates with ${data.model}${where}${extra} — seconds per image.`
}
