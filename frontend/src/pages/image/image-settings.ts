import type {
  LaiosImageInput,
  LaiosImageRun,
  MediaModelOption,
} from "@/api/types"

export {
  formatDuration,
  formatShortEstimate,
  parseUtc,
  relativeTime,
} from "@/lib/generation-time"

import { formatShortEstimate } from "@/lib/generation-time"

/**
 * What a given image model costs and which knobs it actually has.
 *
 * The two image recipes are on the same `/v1/images/generations` surface and are
 * *not* interchangeable — 6.5s versus up to 116s for the same picture, and one of
 * them has classifier-free guidance while the other is distilled past needing it.
 * A single set of defaults would be wrong for whichever model it wasn't written
 * for: 50 steps is Qwen's default and 5× overkill on a turbo checkpoint, while 9
 * steps is Z-Image's default and visibly undercooked on Qwen.
 *
 * This is the same lesson the video page learned the hard way (see
 * `video-settings.ts` — knobs guessed from how video is normally named were a
 * guaranteed 400). The difference is that video ended up needing the model to
 * *declare* its shape in the recipe, because MiniMax-H3's request body is unlike
 * any other engine's. Here it does not: both models take the same fields, and only
 * the sensible values differ. So a table keyed on the served name is enough, and
 * an unknown image model still works — it just gets conservative defaults and no
 * cost estimate rather than a confident wrong one.
 *
 * Every number below is measured on a DGX Spark (GB10) at 1024×1024 and recorded
 * in laios's `docs/inference-matrix.md`, not derived from parameter counts.
 */
export interface ImageProfile {
  /** Matched as a substring of the lowercased served name. */
  match: string
  label: string
  defaultSteps: number
  stepRange: { min: number; max: number }
  stepTicks: { value: number; label?: string }[]
  /**
   * Measured wall-clock per denoise step, with the model's default guidance.
   *
   * Null for an unknown model: no estimate at all is honest, and a made-up one
   * would be trusted.
   */
  secondsPerStep: number | null
  /**
   * Per step with CFG disabled, where that is a thing this model can do.
   *
   * Roughly half, because guidance runs the transformer twice per step — Qwen's
   * measured 2.3 s/step is two ~1.16 s forward passes.
   */
  secondsPerStepNoGuidance?: number
  /**
   * Whether guidance is a knob at all here.
   *
   * The engine turns CFG on when `cfg_scale > 1` **and** `negative_prompt is not
   * None`, and Qwen's sampling defaults set `negative_prompt` to `" "` — a space,
   * which is not None — so CFG is on by default and doubles the cost. Z-Image
   * defaults it to None and is CFG-distilled, so sending guidance fields there
   * would switch on something the checkpoint does not want.
   */
  guidance: boolean
  /** One line under the model picker: what this model is for. */
  note: string
}

export const IMAGE_PROFILES: readonly ImageProfile[] = [
  {
    match: "z-image",
    label: "Z-Image-Turbo",
    // Step-distilled to 9. Raising it is not obviously better on a turbo
    // checkpoint, so the range is tight rather than spanning to Qwen's 50.
    defaultSteps: 9,
    stepRange: { min: 4, max: 20 },
    stepTicks: [
      { value: 4 },
      { value: 9, label: "9 · default" },
      { value: 20 },
    ],
    // 6.5s of inference at 9 steps, measured.
    secondsPerStep: 0.72,
    guidance: false,
    note: "6B, step-distilled to 9 — seconds per image. The default for everything except exact glyphs.",
  },
  {
    match: "qwen-image",
    label: "Qwen-Image-2512",
    // The engine's own default, and the expensive one: 50 steps with CFG is 100
    // forward passes of a 20B transformer. Offered as the default anyway because
    // it is what the model was tuned for — the estimate below is what warns you.
    defaultSteps: 25,
    stepRange: { min: 10, max: 50 },
    stepTicks: [
      { value: 10 },
      { value: 25, label: "25 · most of it" },
      { value: 50, label: "50 · full" },
    ],
    // 58s at 25 steps and 116s at 50, measured — ~2.3 s/step with CFG on.
    secondsPerStep: 2.3,
    secondsPerStepNoGuidance: 1.16,
    guidance: true,
    note: "20B with the best open-weight text rendering — but minutes per image, and guidance doubles it.",
  },
]

/**
 * The fallback for a served name that matches no profile.
 *
 * Reachable two ways: a new `capabilities: [image]` recipe this build predates, or
 * a box whose control plane isn't published through the tunnel, where the operator
 * typed the served name by hand. Both want the same thing — the request shape both
 * known models share, no cost claim, and no guidance fields (an omitted field
 * cannot be rejected, while a wrongly-sent one can).
 */
export const GENERIC_PROFILE: ImageProfile = {
  match: "",
  label: "Unknown image model",
  defaultSteps: 20,
  stepRange: { min: 1, max: 50 },
  stepTicks: [{ value: 1 }, { value: 20 }, { value: 50 }],
  secondsPerStep: null,
  guidance: false,
  note: "Not a model this build has measured — steps and size are relayed as sent, with no time estimate.",
}

export function profileFor(model: string): ImageProfile {
  const name = model.trim().toLowerCase()
  return (
    IMAGE_PROFILES.find((profile) => name.includes(profile.match)) ??
    GENERIC_PROFILE
  )
}

/** The knobs, as the form holds them — numbers, not strings. */
export interface ImageSettings {
  /** `"1024x1024"`, as the engine's `size` field wants it. */
  size: string
  steps: number
  /** Null means "let the engine pick", which is the default. */
  seed: number | null
  /**
   * Classifier-free guidance, for a model that has it.
   *
   * On is the engine's own default. Off sends `true_cfg_scale: 1`, which halves
   * the cost and costs prompt adherence — Qwen is not CFG-distilled, so it was
   * trained expecting guidance.
   */
  guidance: boolean
  /** Empty means "don't send one", which is what leaves the engine's default alone. */
  negativePrompt: string
  outputFormat: "jpeg" | "png" | "webp"
}

export interface SizeOption {
  /** The engine's `size` string. */
  value: string
  label: string
  /** Glyph proportions. */
  w: number
  h: number
}

/**
 * The offered output sizes.
 *
 * Only 1024×1024 is measured (both recipes were validated there), so the rest are
 * the same pixel budget reshaped, every edge a multiple of 64 — which is what the
 * diffusion server's patching wants and what the standard SDXL-era buckets use.
 * Unlike MiniMax-H3, neither image model pins its dimensions to one legal value,
 * so these are genuine choices rather than four ways to earn a 400.
 *
 * Bigger than 1024 is deliberately not offered: it scales the latents rather than
 * the weights, and the measured peaks (24.5 GB for Z-Image, 58.5 GB for Qwen)
 * leave headroom that is real but unverified. Nothing stops an operator asking for
 * it — a reused run relays whatever it was submitted with.
 */
export const SIZE_OPTIONS: readonly SizeOption[] = [
  { value: "1024x1024", label: "1:1", w: 1, h: 1 },
  { value: "1344x768", label: "16:9", w: 16, h: 9 },
  { value: "768x1344", label: "9:16", w: 9, h: 16 },
  { value: "1152x896", label: "4:3", w: 4, h: 3 },
  { value: "896x1152", label: "3:4", w: 3, h: 4 },
]

export const OUTPUT_FORMATS = [
  { value: "jpeg" as const, label: "JPEG" },
  { value: "png" as const, label: "PNG" },
  { value: "webp" as const, label: "WebP" },
]

/** Defaults for a model, since the two recipes disagree about steps and guidance. */
export function defaultSettings(profile: ImageProfile): ImageSettings {
  return {
    size: SIZE_OPTIONS[0].value,
    steps: profile.defaultSteps,
    seed: null,
    guidance: profile.guidance,
    negativePrompt: "",
    // JPEG is the engine's own default. PNG is a click away for anyone who cares
    // about a lossless result, which on generated text is a real concern.
    outputFormat: "jpeg",
  }
}

/** Expected wall-clock for a run, or null for a model with no measurement. */
export function estimateSeconds(
  settings: ImageSettings,
  profile: ImageProfile
): number | null {
  if (!Number.isFinite(settings.steps) || settings.steps <= 0) return null
  const perStep =
    profile.guidance && !settings.guidance
      ? (profile.secondsPerStepNoGuidance ?? profile.secondsPerStep)
      : profile.secondsPerStep
  return perStep === null || perStep === undefined
    ? null
    : settings.steps * perStep
}

/** "1024×1024 · 9 steps · seed 7" — the composer's one-line summary. */
export function summarize(
  settings: ImageSettings,
  profile: ImageProfile
): string {
  return [
    settings.size.replace("x", " × "),
    `${settings.steps} steps`,
    // Only worth saying when it is not the engine's default for this model, which
    // is what "guidance" being a knob at all means.
    profile.guidance && !settings.guidance ? "no CFG" : null,
    settings.outputFormat !== "jpeg" ? settings.outputFormat : null,
    settings.seed !== null ? `seed ${settings.seed}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** The engine's own measurements, for a completed run's meta line. */
export function measured(run: LaiosImageRun): string | null {
  const parts: string[] = []
  if (run.inference_time_s !== null) {
    parts.push(`${run.inference_time_s.toFixed(1)}s`)
  }
  if (run.peak_memory_mb !== null) {
    parts.push(`${(run.peak_memory_mb / 1024).toFixed(1)} GB peak`)
  }
  return parts.length > 0 ? parts.join(" · ") : null
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
 * and falls back to the model's default rather than trusting the shape.
 *
 * Guidance is reconstructed the way the engine decides it: `true_cfg_scale: 1`
 * is the off switch, and anything else means the model's default applied.
 */
export function settingsFromRequest(
  request: Record<string, unknown>,
  profile: ImageProfile
): ImageSettings {
  const base = defaultSettings(profile)
  const seed = request.seed
  const format = String(request.output_format ?? "").toLowerCase()
  return {
    size: typeof request.size === "string" ? request.size : base.size,
    steps: asNumber(request.num_inference_steps, base.steps),
    seed: typeof seed === "number" && Number.isFinite(seed) ? seed : null,
    guidance: asNumber(request.true_cfg_scale, 4) !== 1 && profile.guidance,
    negativePrompt:
      typeof request.negative_prompt === "string" ? request.negative_prompt : "",
    outputFormat:
      format === "png" || format === "webp" || format === "jpeg"
        ? format
        : base.outputFormat,
  }
}

/**
 * Coerce settings into something this model will accept.
 *
 * Used on the "reuse" path, not on display. A run may have been submitted against
 * a *different* model — reuse is how you compare the same prompt on Z-Image and
 * Qwen — and 50 steps carried onto a 9-step turbo checkpoint, or guidance carried
 * onto a model that has none, would be the wrong request rather than the one you
 * meant. Clamped to the target model's range; display still shows what was really
 * sent (see {@link settingsFromRequest}).
 */
export function toSubmittable(
  settings: ImageSettings,
  profile: ImageProfile
): ImageSettings {
  const { min, max } = profile.stepRange
  return {
    ...settings,
    steps: Math.min(max, Math.max(min, Math.round(settings.steps))),
    guidance: profile.guidance ? settings.guidance : false,
    size: SIZE_OPTIONS.some((option) => option.value === settings.size)
      ? settings.size
      : SIZE_OPTIONS[0].value,
  }
}

/**
 * The request body for these settings.
 *
 * `response_format` and `n` are absent on purpose — the backend pins both (b64 so
 * the image survives the container, and one image per row), and repeating them
 * here would imply they were negotiable.
 *
 * The guidance fields are only sent to a model that has guidance, and only when
 * they say something: `true_cfg_scale: 1` to turn CFG off, or a negative prompt
 * the operator actually typed. Otherwise the engine's own defaults apply, which
 * is what an omitted field means.
 */
export function toImageInput(
  model: string,
  prompt: string,
  settings: ImageSettings,
  profile: ImageProfile
): LaiosImageInput {
  return {
    model,
    prompt,
    size: settings.size,
    num_inference_steps: settings.steps,
    output_format: settings.outputFormat,
    ...(settings.seed !== null ? { seed: settings.seed } : {}),
    ...(profile.guidance
      ? settings.guidance
        ? settings.negativePrompt.trim()
          ? { negative_prompt: settings.negativePrompt.trim() }
          : {}
        : { true_cfg_scale: 1 }
      : {}),
  }
}

/**
 * The settings a run was submitted with, for its meta line.
 *
 * Branches on the source, because the two request shapes share almost no fields.
 * Reading a hosted body through the laios lens is not a cosmetic mismatch — the
 * defaults would fill in `1024x1024` and `20 steps` for a request that contained
 * neither, so the card would state, in the same voice it states measured facts,
 * two things that never happened.
 */
export function runSummary(run: LaiosImageRun): string {
  if (run.provider === "openrouter") return summarizeHosted(run.request)
  const profile = profileFor(run.model)
  return summarize(settingsFromRequest(run.request, profile), profile)
}

/**
 * `"16:9 · 2K · png"` from a hosted body — only the fields it really carried.
 *
 * Nothing is defaulted in. An omitted `aspect_ratio` means the model's own shape
 * applied, and naming a guess for it would be the same error as inventing steps.
 */
export function summarizeHosted(request: Record<string, unknown>): string {
  const parts = [
    request.aspect_ratio,
    request.resolution,
    request.quality,
    request.output_format,
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map((v) => v.toLowerCase())
  if (typeof request.seed === "number") parts.push(`seed ${request.seed}`)
  return parts.join(" · ") || "model defaults"
}

/**
 * What a run is expected to cost, from the body it was submitted with.
 *
 * Always null for a hosted run: the wall clock is queue time plus hardware we
 * cannot see, and this build has measured neither.
 */
export function runEstimate(run: LaiosImageRun): number | null {
  if (run.provider === "openrouter") return null
  const profile = profileFor(run.model)
  return estimateSeconds(settingsFromRequest(run.request, profile), profile)
}

/**
 * The request body for a hosted model.
 *
 * A different shape from {@link toImageInput}, and the difference is not
 * cosmetic: a hosted model takes an aspect ratio and (sometimes) a resolution
 * tier, never a pixel size, and has no denoise loop — so `size`, `steps` and the
 * guidance fields have nothing to map onto and are simply absent. Every field is
 * gated on the catalogue saying the model accepts it, because a hosted rejection
 * costs a round trip and real money.
 */
export function toHostedInput(
  option: MediaModelOption,
  prompt: string,
  settings: ImageSettings
): LaiosImageInput {
  const caps = option.openrouter
  const ratio = ratioLabel(settings.size)
  return {
    model: option.id,
    prompt,
    ...(caps?.aspect_ratios.includes(ratio) ? { aspect_ratio: ratio } : {}),
    ...(caps?.resolutions.length ? { resolution: caps.resolutions[0] } : {}),
    ...(caps?.formats.includes(settings.outputFormat)
      ? { output_format: settings.outputFormat }
      : {}),
    ...(caps?.seed && settings.seed !== null ? { seed: settings.seed } : {}),
  }
}

/**
 * The aspect ratio a stored `size` means.
 *
 * The composer carries geometry in one field for both sources, so this is either
 * already a ratio (hosted) or a pixel size to look up (laios). `1344x768` is
 * `7:4` by arithmetic and `16:9` by intent, which is why the table is consulted
 * rather than the numbers reduced.
 */
export function ratioLabel(size: string): string {
  if (size.includes(":")) return size
  return SIZE_OPTIONS.find((o) => o.value === size)?.label ?? "1:1"
}

/** "~7s" / "~1m 58s", or null when this model has no measurement behind it. */
export function describeEstimate(
  settings: ImageSettings,
  profile: ImageProfile
): string | null {
  const seconds = estimateSeconds(settings, profile)
  return seconds === null ? null : formatShortEstimate(seconds)
}
