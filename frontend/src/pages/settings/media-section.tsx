import { CheckCircle, Cpu, Warning } from "@phosphor-icons/react"
import { Link } from "react-router-dom"
import { toast } from "sonner"

import { useImageModels } from "@/api/images"
import { useMediaSettings, useSaveMediaSettings } from "@/api/settings"
import type {
  MediaModalitySettings,
  MediaSettings,
  MediaSource,
} from "@/api/types"
import { useVideoModels } from "@/api/videos"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { priceLabel } from "@/lib/media-price"

/** Sentinel for "no pin" — a Radix Select item cannot carry an empty value. */
const AUTO = "__auto__"

interface SourceChoice {
  value: MediaSource
  label: string
  description: string
}

/** The two built-in sources. Custom providers are appended per install. */
const SOURCES: SourceChoice[] = [
  {
    value: "laios",
    label: "LAIOS box",
    description:
      "Your own GPUs, through a connected LAIOS daemon. No per-image cost; an image is seconds and a clip is minutes of your own hardware.",
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    description:
      "Hosted models — Seedream, GPT Image, Veo, Sora, Seedance. Billed per image or per second of video, on your OpenRouter key.",
  },
]

/**
 * The built-ins plus one row per user-added endpoint.
 *
 * A custom provider is offered even when it serves no media, for the same reason
 * OpenRouter is offered without a key: the `reason` line below explains what to do,
 * and a greyed-out row explains nothing. The backend does not probe them to build
 * this list, so the cost of offering them all is zero.
 */
function sourceChoices(settings: MediaSettings): SourceChoice[] {
  return [
    ...SOURCES,
    ...settings.custom_providers.map((provider) => ({
      value: provider.ref,
      label: provider.name,
      description: `Your own OpenAI-compatible endpoint at ${provider.base_url}. Its models are classified by what it publishes about them, falling back to what they are named — see the note under each one.`,
    })),
  ]
}

const COPY = {
  image: {
    title: "Images",
    description:
      "Where generate_image runs, for agents and for the Image page alike.",
  },
  video: {
    title: "Video",
    description:
      "Where generate_video runs, for agents and for the Video page alike.",
  },
} as const

/**
 * The one place the media source is chosen.
 *
 * Save-on-change, the `web-search-section` idiom: a source and a model are each a
 * single decision, not a form of related knobs, so a staged draft with a Save
 * button would only add a step.
 *
 * Two things this deliberately does *not* do:
 *
 * * **It does not disable a source that cannot currently serve.** Someone should
 *   be able to select OpenRouter before adding a key and be told what to do next,
 *   rather than finding the option greyed out with no explanation.
 * * **It does not reuse `components/model-picker.tsx`.** That one is built around
 *   chat provider groups, context length and per-token pricing, and none of the
 *   three applies to a diffusion model.
 *
 * The footer quotes the backend's `reason` verbatim, so this card and the agent
 * editor's capability hint say the same sentence about the same state.
 */
export function MediaSection({ kind }: { kind: "image" | "video" }) {
  const { data, isLoading } = useMediaSettings()
  const save = useSaveMediaSettings()

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <DotGridLoader size="xs" />
        Loading…
      </div>
    )
  }

  return <Body kind={kind} settings={data} save={save} />
}

function Body({
  kind,
  settings,
  save,
}: {
  kind: "image" | "video"
  settings: MediaSettings
  save: ReturnType<typeof useSaveMediaSettings>
}) {
  const modality: MediaModalitySettings = settings[kind]
  const copy = COPY[kind]
  const sources = sourceChoices(settings)

  // Only the *selected* source's models are listed. A picker spanning both would
  // invite pinning a model on a source that is not selected, which the backend
  // rejects on save — better not to offer it.
  const images = useImageModels(kind === "image" ? modality.source : undefined)
  const videos = useVideoModels(kind === "video" ? modality.source : undefined)
  const models = kind === "image" ? images : videos

  async function apply(patch: Parameters<typeof save.mutateAsync>[0]) {
    try {
      await save.mutateAsync(patch)
      toast.success(`${copy.title} settings saved`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save")
    }
  }

  function onSourceChange(value: string) {
    // The pin is cleared with the source. A ref from the old source would be
    // rejected on save, and silently keeping it would mean the next save of an
    // unrelated field failed for a reason nobody could see.
    void apply(
      kind === "image"
        ? { image_source: value as MediaSource, image_model: null }
        : { video_source: value as MediaSource, video_model: null }
    )
  }

  function onModelChange(value: string) {
    const model = value === AUTO ? null : value
    void apply(kind === "image" ? { image_model: model } : { video_model: model })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{copy.title}</CardTitle>
            <CardDescription>{copy.description}</CardDescription>
          </div>
          {modality.available ? (
            <Badge variant="secondary">Ready</Badge>
          ) : (
            <Badge variant="outline">Not available</Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={`${kind}-source`}>Source</Label>
          <Select value={modality.source} onValueChange={onSourceChange}>
            <SelectTrigger id={`${kind}-source`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sources.map((source) => (
                <SelectItem key={source.value} value={source.value}>
                  {source.label}
                </SelectItem>
              ))}
              {/* A source that has since gone — a custom provider deleted while it
                  was selected. Kept selectable so the card shows what is actually
                  stored rather than snapping to LAIOS while the backend still
                  fails on it, the same choice the model picker below makes. */}
              {sources.some((s) => s.value === modality.source) ? null : (
                <SelectItem value={modality.source}>
                  {modality.source} (no longer configured)
                </SelectItem>
              )}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {sources.find((s) => s.value === modality.source)?.description}
          </p>
          <SourceHelp source={modality.source} settings={settings} />
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${kind}-model`}>Model</Label>
          <Select
            value={modality.model ?? AUTO}
            onValueChange={onModelChange}
            disabled={models.isLoading}
          >
            <SelectTrigger id={`${kind}-model`}>
              <SelectValue placeholder="Auto" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>Auto — the cheapest available</SelectItem>
              {models.options.map((option) => (
                <SelectItem key={option.ref} value={option.ref}>
                  {option.label}
                  {priceLabel(option.price) ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · {priceLabel(option.price)}
                    </span>
                  ) : null}
                  {/* The endpoint publishes no modality and this id merely looks
                      like a media model — a caveat that belongs next to the
                      choice, not only in the failure it might cause. */}
                  {option.custom && !option.custom.declared ? (
                    <span className="text-muted-foreground"> · by name</span>
                  ) : null}
                </SelectItem>
              ))}
              {/* A pin whose model has since disappeared. Kept selectable so the
                  card shows what is actually stored rather than snapping the
                  control back to Auto while the backend still fails on it. */}
              {modality.model &&
              !models.options.some((o) => o.ref === modality.model) ? (
                <SelectItem value={modality.model}>
                  {modality.model} (not currently offered)
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {modality.model
              ? "Pinned. If this model stops being offered, generation stops with a message rather than quietly switching to another one — pick Auto if you would rather it chose."
              : "The cheapest model this source offers, re-picked each run."}
          </p>
        </div>

        <Reason modality={modality} />
      </CardContent>
    </Card>
  )
}

/** What to do about a source that cannot serve — not just that it cannot. */
function SourceHelp({
  source,
  settings,
}: {
  source: MediaSource
  settings: MediaSettings
}) {
  if (source === "openrouter" && !settings.openrouter_configured) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Warning className="mt-px h-3.5 w-3.5 shrink-0" />
        <span>
          No OpenRouter key is set.{" "}
          <Link
            to="/?settings=providers"
            className="text-foreground underline underline-offset-2"
          >
            Add one under Providers
          </Link>
          .
        </span>
      </p>
    )
  }
  if (source.startsWith("custom")) {
    // Nothing to warn about — a custom provider exists by definition if it is in
    // this list, and whether it *serves* media is what the reason line says.
    return null
  }
  if (source.startsWith("laios") && !settings.laios_connected) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Cpu className="mt-px h-3.5 w-3.5 shrink-0" />
        <span>
          No LAIOS box is connected.{" "}
          <Link
            to="/?settings=laios"
            className="text-foreground underline underline-offset-2"
          >
            Add a connection
          </Link>
          .
        </span>
      </p>
    )
  }
  return null
}

/**
 * The resolver's own sentence.
 *
 * Verbatim rather than reworded, because the same string is what the agent editor
 * shows under the image/video toggle — two different wordings for one state is
 * how a user ends up believing the two disagree. It also has to carry the
 * no-fallback rule: "OpenRouter's catalogue could not be read" alone would look
 * like a bug rather than a deliberate refusal to use the box instead.
 */
function Reason({ modality }: { modality: MediaModalitySettings }) {
  return (
    <p className="flex items-start gap-1.5 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      {modality.available ? (
        <CheckCircle className="mt-px h-3.5 w-3.5 shrink-0 text-success" />
      ) : (
        <Warning className="mt-px h-3.5 w-3.5 shrink-0" />
      )}
      <span className="first-letter:uppercase">{modality.reason}</span>
    </p>
  )
}
