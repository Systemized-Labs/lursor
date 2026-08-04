import {
  CaretDown,
  DiceFive,
  Sparkle,
  WarningCircle,
} from "@phosphor-icons/react"
import { useEffect, useRef } from "react"
import { toast } from "sonner"

import { useImageModels, useSubmitImage } from "@/api/images"
import { AspectGlyph, Field, Segmented } from "@/components/generation-controls"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { ImageComposer } from "./use-image-composer"
import {
  OUTPUT_FORMATS,
  SIZE_OPTIONS,
  describeEstimate,
  summarize,
  toImageInput,
} from "./image-settings"

const PLACEHOLDER =
  "a paper boat drifting across a puddle at dusk, shallow depth of field"

/**
 * The prompt and the knobs behind it.
 *
 * The same shape as the video composer — prompt always on screen, everything else
 * folded into "Advanced" — because it is the same job. Two things differ, and both
 * come from the models rather than from taste:
 *
 * * The knobs are **per model**. Step range, step defaults and whether guidance
 *   exists at all are read from the selected model's profile, so switching model
 *   reshapes the controls (see `image-settings.ts`).
 * * The estimate is in seconds, not minutes. Z-Image finishes in ~7s and Qwen in
 *   ~1–2 minutes, and that gap is the main thing being chosen between, so the
 *   footer states it in units that can tell them apart.
 */
export function ImageComposer({
  connectionId,
  composer,
}: {
  connectionId: string
  composer: ImageComposer
}) {
  const { options, controlReachable } = useImageModels(connectionId)
  const submit = useSubmitImage(connectionId)
  const {
    model,
    setModel,
    profile,
    prompt,
    setPrompt,
    settings,
    update,
    advancedOpen,
    toggleAdvanced,
    focusTick,
  } = composer

  const promptRef = useRef<HTMLTextAreaElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  // Preselect the first image model serving. Unlike video there may well be two
  // (both recipes are solo_only but a multi-node box can serve one each), so this
  // picks rather than assumes.
  useEffect(() => {
    if (!model && options.length > 0) setModel(options[0].servedName)
  }, [options, model, setModel])

  // "Reuse" lands the run in the form, which is above the card that was clicked —
  // so bring the form to the eye and put the caret in it.
  useEffect(() => {
    if (focusTick === 0) return
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    promptRef.current?.focus()
  }, [focusTick])

  const estimate = describeEstimate(settings, profile)
  const activeSize = SIZE_OPTIONS.find(
    (option) => option.value === settings.size
  )
  const canSubmit =
    Boolean(model.trim()) && Boolean(prompt.trim()) && !submit.isPending

  async function onSubmit() {
    if (!model.trim()) {
      toast.error("Pick a model to generate with")
      return
    }
    if (!prompt.trim()) {
      toast.error("A prompt is required")
      return
    }
    try {
      await submit.mutateAsync(
        toImageInput(model.trim(), prompt.trim(), settings, profile)
      )
      toast.success("Generating", {
        description: estimate
          ? `Expect ${estimate}. It keeps running if you leave.`
          : "It keeps running if you leave.",
      })
      // The prompt is kept, unlike the video composer's. An image takes seconds,
      // so the loop here is tweak-and-resubmit rather than write-and-wait — and
      // retyping the prompt to change one word would be the whole cost of it.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit")
    }
  }

  return (
    <div
      ref={cardRef}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-2 py-1.5">
        {options.length > 0 ? (
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger
              aria-label="Model"
              className="h-8 w-auto max-w-[11rem] gap-1.5 border-0 bg-transparent px-2 text-sm font-medium sm:max-w-[16rem]"
            >
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.servedName} value={option.servedName}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            aria-label="Model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="z-image-turbo"
            className="h-8 w-44 border-0 bg-transparent px-2 text-sm font-medium"
          />
        )}

        <div className="ml-auto flex items-center gap-1">
          <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
            {summarize(settings, profile)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleAdvanced}
            aria-expanded={advancedOpen}
            className="text-muted-foreground hover:text-foreground"
          >
            Advanced
            <CaretDown
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                advancedOpen && "rotate-180"
              )}
            />
          </Button>
        </div>
      </div>

      {/* Two different reasons the picker can be empty, and the operator needs to
          know which: nothing is serving, or the control plane isn't published
          through the tunnel so we can't tell. */}
      {options.length === 0 ? (
        <p className="flex items-start gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <WarningCircle className="mt-px h-3.5 w-3.5 shrink-0" />
          {controlReachable
            ? "No image-capable model is serving on this box — serve one from the LAIOS page, or name it directly above."
            : "Could not read this box's model inventory (a tunnel without expose_control). Name the served model directly above."}
        </p>
      ) : null}

      {/* What this model is for. The two recipes differ by ~17× in wall clock for
          the same picture, so which one is selected is the most consequential
          choice on the page — worth a line rather than only a name. */}
      {model ? (
        <p className="border-b border-border px-3 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {profile.note}
        </p>
      ) : null}

      <Textarea
        ref={promptRef}
        aria-label="Prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          // ⌘↵ submits, matching the chat and video composers. Plain ↵ has to
          // stay a newline: these prompts are paragraphs, not chat lines.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            if (canSubmit) void onSubmit()
          }
        }}
        placeholder={PLACEHOLDER}
        className="min-h-[110px] resize-none rounded-none border-0 bg-transparent px-3 py-3 text-[15px] leading-relaxed focus-visible:border-0 focus-visible:bg-transparent focus-visible:ring-0"
      />

      {advancedOpen ? (
        <div className="grid gap-5 border-t border-border px-3 py-4 sm:grid-cols-2">
          <Field
            label="Size"
            value={activeSize ? settings.size.replace("x", " × ") : settings.size}
            hint="1024² reshaped, every edge a multiple of 64. Neither image model pins its dimensions the way the video engine does."
          >
            <Segmented
              ariaLabel="Size"
              value={settings.size}
              onChange={(value) => update({ size: value })}
              options={SIZE_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
                glyph: <AspectGlyph w={option.w} h={option.h} />,
              }))}
            />
          </Field>

          <Field
            label="Denoise steps"
            htmlFor="image-steps"
            value={`${settings.steps}${estimate ? ` · ${estimate}` : ""}`}
          >
            <Slider
              id="image-steps"
              min={profile.stepRange.min}
              max={profile.stepRange.max}
              step={1}
              ticks={profile.stepTicks}
              value={settings.steps}
              onChange={(e) => update({ steps: Number(e.target.value) })}
            />
          </Field>

          {/* Only for a model that has guidance at all. Z-Image is CFG-distilled
              and defaults negative_prompt to None, so offering these there would
              switch on something the checkpoint does not want. */}
          {profile.guidance ? (
            <>
              <Field
                label="Guidance (CFG)"
                value={settings.guidance ? "on · 2× cost" : "off · half cost"}
                hint="On is the model's default and runs the transformer twice per step. Off sends true_cfg_scale 1 — half the wall clock, weaker prompt adherence."
              >
                <Segmented
                  ariaLabel="Guidance"
                  value={settings.guidance ? "on" : "off"}
                  onChange={(value) => update({ guidance: value === "on" })}
                  options={[
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                  ]}
                />
              </Field>

              <Field
                label="Negative prompt"
                htmlFor="image-negative"
                value={settings.negativePrompt.trim() ? "set" : "default"}
                hint={
                  settings.guidance
                    ? "What to steer away from. Left empty, the engine's own default applies."
                    : "Ignored while guidance is off — it is guidance that consults it."
                }
              >
                <Input
                  id="image-negative"
                  value={settings.negativePrompt}
                  onChange={(e) => update({ negativePrompt: e.target.value })}
                  placeholder="blurry, watermark, low contrast"
                  disabled={!settings.guidance}
                  className="h-9"
                />
              </Field>
            </>
          ) : null}

          <Field
            label="Seed"
            htmlFor="image-seed"
            value={settings.seed === null ? "random" : "fixed"}
            hint="Fix the seed to change one knob at a time and still recognise the result."
          >
            <div className="flex gap-2">
              <Input
                id="image-seed"
                type="number"
                value={settings.seed ?? ""}
                onChange={(e) =>
                  update({
                    seed: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                placeholder="random"
                className="h-9"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-9 shrink-0"
                onClick={() =>
                  update({ seed: Math.floor(Math.random() * 2_147_483_647) })
                }
              >
                <DiceFive className="h-4 w-4" />
                Roll
              </Button>
            </div>
          </Field>

          <Field
            label="Format"
            value={settings.outputFormat}
            hint="The engine returns JPEG unless asked otherwise. PNG is worth it when judging rendered text."
          >
            <Segmented
              ariaLabel="Output format"
              value={settings.outputFormat}
              onChange={(value) => update({ outputFormat: value })}
              options={OUTPUT_FORMATS}
            />
          </Field>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/30 px-3 py-2.5">
        <p className="text-xs text-muted-foreground">
          {estimate ? (
            <>
              Roughly <span className="text-foreground">{estimate}</span> on the
              box. It keeps running if you navigate away.
            </>
          ) : (
            "No timing measured for this model — it keeps running if you navigate away."
          )}
        </p>
        <Button onClick={onSubmit} disabled={!canSubmit}>
          {submit.isPending ? (
            <DotGridLoader size="xs" />
          ) : (
            <Sparkle className="h-4 w-4" />
          )}
          {submit.isPending ? "Submitting…" : "Generate"}
        </Button>
      </div>
    </div>
  )
}
