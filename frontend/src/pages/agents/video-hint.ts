import { useVideoCapability } from "@/api/videos"

/**
 * One line saying what the video toggle will actually reach.
 *
 * The toggle is only half the gate: the tools are built only when a connected
 * laios box is serving a video model the backend knows how to drive, so with the
 * checkbox on and nothing serving, an agent silently has no video tools. That is
 * indistinguishable from a broken checkbox, hence this.
 *
 * Shared between the agent and subagent editors so the wording can't drift.
 * Returns `null` while it loads, so the caller renders nothing rather than a
 * wrong claim.
 */
export function useVideoHint(enabled = true): string | null {
  const { data } = useVideoCapability(enabled)
  if (!data) return null
  if (!data.available) {
    return `Unavailable: ${data.reason}. The toggle has no effect until then.`
  }
  const where = data.connection_name ? ` on ${data.connection_name}` : ""
  const assumed = data.assumed
    ? " Its recipe declares no video profile, so the request shape is assumed from the model's identity."
    : ""
  return `Will use ${data.model}${where}. Each render runs for minutes on that box's GPU.${assumed}`
}
