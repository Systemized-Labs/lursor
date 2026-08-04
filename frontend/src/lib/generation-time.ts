/**
 * Time formatting for the generation pages (video, image).
 *
 * Separate from {@link import("./time-ago").timeAgo} on two counts, both of which
 * bit the video page before this existed: these read a timestamp the API
 * serialized without an offset, and `relativeTime` takes `now` as an argument so a
 * card that is ticking once a second re-renders from one clock rather than calling
 * `Date.now()` per stamp.
 */

/**
 * Parse a timestamp the API serialized without an offset.
 *
 * The backend's datetimes are UTC but carry no `Z`, which the browser reads as
 * local time — an hours-wrong "elapsed" on any machine that isn't on UTC. Marked
 * explicitly here; a string that already has an offset is left alone.
 */
export function parseUtc(iso: string): number {
  return Date.parse(/[Zz+]|-\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`)
}

/** Compact "3s ago" / "5m ago" / "2h ago" / "4d ago" for a run's age. */
export function relativeTime(iso: string, now: number): string {
  const then = parseUtc(iso)
  if (Number.isNaN(then)) return ""
  const s = Math.max(0, Math.floor((now - then) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** "48s" / "6m 12s" — for elapsed times, where the seconds matter. */
export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/** "under a minute" / "~6 min" — for estimates, where precision would be a lie. */
export function formatEstimate(totalSeconds: number): string {
  const minutes = totalSeconds / 60
  return minutes < 1 ? "under a minute" : `~${Math.round(minutes)} min`
}

/**
 * "7s" / "1m 58s" — for an estimate short enough that seconds are the story.
 *
 * {@link formatEstimate} rounds everything under a minute to "under a minute",
 * which is the right call for a clip that takes six minutes and useless for an
 * image that takes seven seconds — the difference between z-image-turbo's 6.5s
 * and qwen-image-2512's 116s is the main thing an operator is choosing between.
 */
export function formatShortEstimate(totalSeconds: number): string {
  if (totalSeconds < 60) return `~${Math.round(totalSeconds)}s`
  return `~${formatDuration(totalSeconds)}`
}
