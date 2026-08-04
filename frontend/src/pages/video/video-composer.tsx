import {
  CaretDown,
  DiceFive,
  Sparkle,
  WarningCircle,
} from "@phosphor-icons/react"
import { useEffect, useRef } from "react"
import { toast } from "sonner"

import { useSubmitVideo, useVideoModels } from "@/api/videos"
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
import { AspectGlyph, Field, Segmented } from "@/components/generation-controls"
import { cn } from "@/lib/utils"
import type { VideoComposer } from "./use-video-composer"
import {
  ASPECT_OPTIONS,
  DURATION_RANGE,
  DURATION_TICKS,
  FIXED_SHORT_EDGE,
  STEP_RANGE,
  STEP_TICKS,
  estimateSeconds,
  formatEstimate,
  formatSeconds,
  summarize,
  toVideoInput,
} from "./video-settings"

const PLACEHOLDER =
  "a paper boat drifting across a puddle at dusk, shallow depth of field"

/**
 * The prompt and the knobs behind it.
 *
 * Shaped like a composer rather than a form: the prompt is the only field that
 * is always on screen, borderless and full width, because it is the only one you
 * change every time. The five bare number inputs that used to sit under it —
 * short edge, aspect, seconds, steps, seed, in a five-column grid with no units
 * and no idea which values were safe — fold into "Advanced", where each one gets
 * a control that fits its range and states its resolved value.
 *
 * The estimate is the footer's whole job. A run costs minutes and the engine
 * reports nothing while it works, so the number that matters most is the one you
 * see *before* committing.
 */
export function VideoComposer({
  connectionId,
  composer,
}: {
  connectionId: string
  composer: VideoComposer
}) {
  const { options, controlReachable } = useVideoModels(connectionId)
  const submit = useSubmitVideo(connectionId)
  const {
    model,
    setModel,
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

  // Preselect the only video model serving, which is the common case — one
  // MiniMax-H3 instance per box, since the recipe is solo_only.
  useEffect(() => {
    if (!model && options.length > 0) setModel(options[0].servedName)
  }, [options, model, setModel])

  // "Reuse" lands the run in the form, which is halfway up the page from the card
  // that was clicked — so bring the form to the eye and put the caret in it.
  useEffect(() => {
    if (focusTick === 0) return
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    promptRef.current?.focus()
  }, [focusTick])

  const estimate = estimateSeconds(settings.steps)
  const activeAspect = ASPECT_OPTIONS.find(
    (option) => option.value === settings.aspectRatio
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
        toVideoInput(model.trim(), prompt.trim(), settings)
      )
      toast.success("Generation submitted", {
        description: estimate
          ? `Expect ${formatEstimate(estimate)}. It keeps running if you leave.`
          : undefined,
      })
      setPrompt("")
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
            {/* Capped tighter on phones so a long served name ("MiniMax-H3 FL2VA
                SGLang…") doesn't push Advanced onto a second line. */}
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
            placeholder="minimax-h3"
            className="h-8 w-44 border-0 bg-transparent px-2 text-sm font-medium"
          />
        )}

        <div className="ml-auto flex items-center gap-1">
          <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
            {summarize(settings)}
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
            ? "No video-capable model is serving on this box — serve one from the LAIOS page, or name it directly above."
            : "Could not read this box's model inventory (a tunnel without expose_control). Name the served model directly above."}
        </p>
      ) : null}

      <Textarea
        ref={promptRef}
        aria-label="Prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          // ⌘↵ submits, matching the chat composer. Plain ↵ has to stay a
          // newline: these prompts are paragraphs, not chat lines.
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
          <Field label="Aspect ratio" value={settings.aspectRatio}>
            <Segmented
              ariaLabel="Aspect ratio"
              value={settings.aspectRatio}
              onChange={(value) => update({ aspectRatio: value })}
              options={ASPECT_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
                glyph: <AspectGlyph w={option.w} h={option.h} />,
              }))}
            />
          </Field>

          {/* Stated, not offered. The engine takes exactly one short edge and
              rejects the rest outright, so a picker here could only ever hand
              you four ways to get a 400. The sizes are the engine's own, not
              arithmetic on the ratio — see ASPECT_OPTIONS. */}
          <Field
            label="Output size"
            value={activeAspect?.size ?? `${settings.shortEdge}px short edge`}
            hint={`Fixed by ${model || "this model"} — it accepts a ${FIXED_SHORT_EDGE}px short edge only. Use the aspect ratio to change the shape.`}
          >
            <div className="flex h-9 items-center rounded-lg bg-muted/60 px-3 text-xs tabular-nums text-muted-foreground">
              {activeAspect?.size ?? "—"}
            </div>
          </Field>

          <Field
            label="Duration"
            htmlFor="video-duration"
            value={`${formatSeconds(settings.durationSeconds)}s`}
          >
            <Slider
              id="video-duration"
              min={DURATION_RANGE.min}
              max={DURATION_RANGE.max}
              step={DURATION_RANGE.step}
              ticks={DURATION_TICKS}
              value={settings.durationSeconds}
              onChange={(e) =>
                update({ durationSeconds: Number(e.target.value) })
              }
            />
          </Field>

          {/* No hint here on purpose: the readout gives the cost and the tick
              labels name both landmarks, so a sentence repeating them would only
              make this cell taller than the one beside it. */}
          <Field
            label="Denoise steps"
            htmlFor="video-steps"
            value={`${settings.steps} · ${estimate ? formatEstimate(estimate) : "—"}`}
          >
            <Slider
              id="video-steps"
              min={STEP_RANGE.min}
              max={STEP_RANGE.max}
              step={1}
              ticks={STEP_TICKS}
              value={settings.steps}
              onChange={(e) => update({ steps: Number(e.target.value) })}
            />
          </Field>

          <Field
            label="Seed"
            htmlFor="video-seed"
            value={settings.seed === null ? "random" : "fixed"}
            hint="Fix the seed to change one knob at a time and still recognise the result."
          >
            <div className="flex gap-2">
              <Input
                id="video-seed"
                type="number"
                value={settings.seed ?? ""}
                onChange={(e) =>
                  update({
                    seed:
                      e.target.value === "" ? null : Number(e.target.value),
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
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/30 px-3 py-2.5">
        <p className="text-xs text-muted-foreground">
          {estimate ? (
            <>
              Roughly <span className="text-foreground">{formatEstimate(estimate)}</span> on
              the box. It keeps running if you navigate away.
            </>
          ) : (
            "Steps must be a positive number."
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
