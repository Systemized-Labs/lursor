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
 * The recipe's own probe values: 8 steps is the fast smoke test at roughly six
 * minutes, against a 50-step default that runs ~35.
 */
export const DEFAULT_SETTINGS: VideoSettings = {
  shortEdge: 768,
  aspectRatio: "16:9",
  durationSeconds: 4,
  steps: 8,
  seed: null,
}

export interface AspectOption {
  value: string
  label: string
  /** Glyph proportions — also what shapes a run card's frame. */
  w: number
  h: number
}

export const ASPECT_OPTIONS: readonly AspectOption[] = [
  { value: "16:9", label: "Landscape", w: 16, h: 9 },
  { value: "9:16", label: "Portrait", w: 9, h: 16 },
  { value: "1:1", label: "Square", w: 1, h: 1 },
]

/**
 * Short-edge presets, labelled the way video is usually named.
 *
 * Chips rather than a number field: this is not a free dimension — the engine
 * wants a short edge its patch size divides, and a typo like 767 is a failed
 * six-minute job. The five values here are the ones the recipe is tuned for.
 */
export const RESOLUTION_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 480, label: "480p" },
  { value: 576, label: "576p" },
  { value: 720, label: "720p" },
  { value: 768, label: "768p" },
  { value: 1080, label: "1080p" },
]

export const STEP_RANGE = { min: 4, max: 50 } as const
export const DURATION_RANGE = { min: 2, max: 10, step: 0.5 } as const

/** Landmarks under the steps slider: the smoke test and the recipe default. */
export const STEP_TICKS = [
  { value: 8, label: "8 · fast" },
  { value: 25 },
  { value: 50, label: "50 · full" },
]

export const DURATION_TICKS = [
  { value: 2, label: "2s" },
  { value: 4 },
  { value: 6, label: "6s" },
  { value: 8 },
  { value: 10, label: "10s" },
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

/** "768p · 16:9 · 4s · 8 steps" — the composer's one-line summary of its knobs. */
export function summarize(settings: VideoSettings): string {
  const resolution =
    RESOLUTION_OPTIONS.find((r) => r.value === settings.shortEdge)?.label ??
    `${settings.shortEdge}p`
  return [
    resolution,
    settings.aspectRatio,
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
