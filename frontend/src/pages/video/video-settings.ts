import type { LaiosVideoInput, LaiosVideoJob } from "@/api/types"

/**
 * Wall-clock cost of one denoise step, measured at 1344×768×107f in the recipe
 * header (docs/inference-matrix.md).
 *
 * This constant is the page's only live signal. MiniMax-H3 reports `queued`/0
 * for the entire run and flips straight to `completed`/100, so elapsed-time
 * against an estimate derived from this is the whole progress story — both
 * before submitting ("what am I about to wait for") and during.
 */
export const SECONDS_PER_STEP = 44

/** The knobs, as the form holds them — numbers, not strings. */
export interface VideoSettings {
  /** Pixels on the short edge; the long edge follows from the aspect ratio. */
  shortEdge: number
  aspectRatio: string
  durationSeconds: number
  steps: number
  /** Null means "let the engine pick", which is the default. */
  seed: number | null
}

/**
 * The one short edge MiniMax-H3 accepts.
 *
 * Not a preference — the engine rejects anything else outright:
 * ``target.short_edge must be 768 for minimax_h3, got 1080``. This page briefly
 * offered 480/576/720/768/1080 as chips, four of which were a guaranteed 400,
 * because the values were guessed from how video is normally named rather than
 * read off the engine.
 *
 * It stays a field in {@link VideoSettings} rather than being inlined at the
 * call site so a past run still round-trips through "reuse", and so the day the
 * model inventory carries real per-model constraints there is somewhere for them
 * to land. Until then the composer states it instead of offering it.
 */
export const FIXED_SHORT_EDGE = 768

/**
 * The recipe's own probe values: 8 steps is the fast smoke test at roughly six
 * minutes, against a 50-step default that runs ~35.
 */
export const DEFAULT_SETTINGS: VideoSettings = {
  shortEdge: FIXED_SHORT_EDGE,
  aspectRatio: "16:9",
  durationSeconds: 4,
  steps: 8,
  seed: null,
}

export interface AspectOption {
  value: string
  label: string
  /** Glyph proportions. */
  w: number
  h: number
  /**
   * The pixel size the engine actually returns for this ratio at
   * {@link FIXED_SHORT_EDGE}, read off its own responses rather than computed.
   *
   * Arithmetic gets this wrong: 768 at 16:9 is 1365 by calculation, and the
   * engine returns 1344. It snaps the long edge to its patch size, so the only
   * trustworthy source for these is the engine.
   */
  size: string
}

export const ASPECT_OPTIONS: readonly AspectOption[] = [
  { value: "16:9", label: "Landscape", w: 16, h: 9, size: "1344 × 768" },
  { value: "9:16", label: "Portrait", w: 9, h: 16, size: "768 × 1344" },
  { value: "1:1", label: "Square", w: 1, h: 1, size: "768 × 768" },
]

export const STEP_RANGE = { min: 4, max: 50 } as const

/**
 * Clip length bounds, enforced by the engine:
 * ``target.duration_seconds must be in [4, 15]``.
 *
 * The slider ran 2–10 before, which both offered two seconds of guaranteed
 * failure at the bottom and hid five usable seconds off the top end.
 */
export const DURATION_RANGE = { min: 4, max: 15, step: 0.5 } as const

/** Landmarks under the steps slider: the smoke test and the recipe default. */
export const STEP_TICKS = [
  { value: 8, label: "8 · fast" },
  { value: 25 },
  { value: 50, label: "50 · full" },
]

export const DURATION_TICKS = [
  { value: 4, label: "4s" },
  { value: 7 },
  { value: 10, label: "10s" },
  { value: 13 },
  { value: 15, label: "15s" },
]

/** Expected wall-clock for a run at this many steps. */
export function estimateSeconds(steps: number): number | null {
  return Number.isFinite(steps) && steps > 0 ? steps * SECONDS_PER_STEP : null
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

/** "1344 × 768 · 4s · 8 steps" — the composer's one-line summary. */
export function summarize(settings: VideoSettings): string {
  // Prefer the size the engine is known to return; fall back to the raw short
  // edge for a run submitted with something this build doesn't recognise. The
  // aspect ratio is not listed separately — the dimensions already say it.
  const size =
    (settings.shortEdge === FIXED_SHORT_EDGE
      ? ASPECT_OPTIONS.find((a) => a.value === settings.aspectRatio)?.size
      : undefined) ?? `${settings.shortEdge}p ${settings.aspectRatio}`
  return [
    size,
    `${formatSeconds(settings.durationSeconds)}s`,
    `${settings.steps} steps`,
    settings.seed !== null ? `seed ${settings.seed}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** Drops the trailing ".0" so 4 reads as "4" but 4.5 survives. */
export function formatSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

/**
 * Read a submitted body back into form values, so a past run can be reopened in
 * the composer and tweaked.
 *
 * The row stores the request verbatim as JSON, so every field here is untrusted
 * and falls back to the default rather than trusting the shape.
 */
export function settingsFromRequest(
  request: Record<string, unknown>
): VideoSettings {
  const target = isRecord(request.target) ? request.target : {}
  const seed = request.seed
  return {
    shortEdge: asNumber(target.short_edge, DEFAULT_SETTINGS.shortEdge),
    aspectRatio:
      typeof target.aspect_ratio === "string"
        ? target.aspect_ratio
        : DEFAULT_SETTINGS.aspectRatio,
    durationSeconds: asNumber(
      target.duration_seconds,
      DEFAULT_SETTINGS.durationSeconds
    ),
    steps: asNumber(request.num_inference_steps, DEFAULT_SETTINGS.steps),
    seed: typeof seed === "number" && Number.isFinite(seed) ? seed : null,
  }
}

/**
 * Coerce settings into something the engine will actually accept.
 *
 * Used on the "reuse" path, not on display. A run in the history may have been
 * submitted with values this engine now rejects — a 1080p attempt from before
 * the constraint was known, or a 2-second clip — and reloading those verbatim
 * would hand back a form whose only outcome is the same 400. Display still shows
 * what was really sent (see {@link settingsFromRequest}); this is for the copy
 * you are about to edit and resubmit.
 */
export function toSubmittable(settings: VideoSettings): VideoSettings {
  const { min, max } = DURATION_RANGE
  return {
    ...settings,
    shortEdge: FIXED_SHORT_EDGE,
    durationSeconds: Math.min(max, Math.max(min, settings.durationSeconds)),
    steps: Math.min(
      STEP_RANGE.max,
      Math.max(STEP_RANGE.min, Math.round(settings.steps))
    ),
    aspectRatio: ASPECT_OPTIONS.some((a) => a.value === settings.aspectRatio)
      ? settings.aspectRatio
      : DEFAULT_SETTINGS.aspectRatio,
  }
}

/** The request body for these settings. `t2va` is prompt-only, which is all we send. */
export function toVideoInput(
  model: string,
  prompt: string,
  settings: VideoSettings
): LaiosVideoInput {
  return {
    model,
    prompt,
    task: "t2va",
    target: {
      short_edge: settings.shortEdge,
      aspect_ratio: settings.aspectRatio,
      duration_seconds: settings.durationSeconds,
    },
    num_inference_steps: settings.steps,
    ...(settings.seed !== null ? { seed: settings.seed } : {}),
  }
}

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

/** Compact "3s" / "5m" / "2h" / "4d" for a run's age. */
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

/** The settings a run was submitted with, for its meta line. */
export function jobSummary(job: LaiosVideoJob): string {
  return summarize(settingsFromRequest(job.request))
}
