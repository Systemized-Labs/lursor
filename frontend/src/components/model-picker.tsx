import { useCallback, useEffect, useRef, useState } from "react"
import {
  Check,
  ChevronLeft,
  ChevronsUpDown,
  Coins,
  Cpu,
  Layers,
  Search,
  Zap,
} from "lucide-react"

import { useModels } from "@/api/models"
import type { ModelEntry, ModelGroup } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

// Cloud models are served through OpenRouter and carry this prefix (see backend
// `default_model`). The backend now also stamps each catalogue entry with a
// canonical `value` — the exact string to persist — which lets custom
// (locally-hosted) models coexist. Fallback/legacy entries have no `value`, so
// we synthesize the OpenRouter form from the bare id.
const MODEL_PREFIX = "openrouter:"
// Marks a locally-hosted model (see backend). Custom groups get their own
// filter chip keyed by the provider's group label.
const CUSTOM_PREFIX = "custom:"

/** The string to persist / match on for an entry. */
const entryValue = (m: ModelEntry) => m.value ?? `${MODEL_PREFIX}${m.id}`

const isCustomGroup = (g: ModelGroup) =>
  g.models.some((m) => m.value?.startsWith(CUSTOM_PREFIX))

// Fallback static list used when the API is unavailable.
const FALLBACK_MODEL_GROUPS: ModelGroup[] = [
  {
    label: "Anthropic",
    models: [
      { id: "anthropic/claude-opus-4", label: "claude-opus-4", name: "Claude Opus 4" },
      { id: "anthropic/claude-sonnet-4", label: "claude-sonnet-4", name: "Claude Sonnet 4" },
      { id: "anthropic/claude-3.5-haiku", label: "claude-3.5-haiku", name: "Claude 3.5 Haiku" },
    ],
  },
  {
    label: "OpenAI",
    models: [
      { id: "openai/gpt-4.1", label: "gpt-4.1", name: "GPT-4.1" },
      { id: "openai/gpt-4.1-mini", label: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { id: "openai/o3", label: "o3", name: "o3" },
    ],
  },
  {
    label: "Qwen",
    models: [
      { id: "qwen/qwen3.7-max", label: "qwen3.7-max", name: "Qwen3.7 Max" },
    ],
  },
  {
    label: "Google",
    models: [
      { id: "google/gemini-2.5-pro", label: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "google/gemini-2.5-flash", label: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ],
  },
]

function formatPrice(raw: string | undefined): string | null {
  const n = parseFloat(raw ?? "")
  if (isNaN(n) || n === 0) return null
  // OpenRouter prices are per token; display as $/M tokens.
  const perM = n * 1_000_000
  if (perM < 0.01) return `$${(perM * 1000).toFixed(2)}/B`
  if (perM < 1) return `$${perM.toFixed(3)}/M`
  return `$${perM.toFixed(2)}/M`
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

function ModelDetail({
  model,
  group,
  onUse,
  isActive,
}: {
  model: ModelEntry
  group: string
  onUse: () => void
  isActive: boolean
}) {
  const inputPrice = formatPrice(model.pricing?.prompt)
  const outputPrice = formatPrice(model.pricing?.completion)

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
        <div>
          <p className="mb-0.5 text-xs font-medium text-muted-foreground">{group}</p>
          <h2 className="text-lg font-semibold leading-snug text-foreground">
            {model.name}
          </h2>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{model.id}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {model.context_length ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-foreground">
              <Layers className="h-3 w-3 text-muted-foreground" />
              {formatContext(model.context_length)} context
            </span>
          ) : null}
          {model.modality ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-foreground">
              <Cpu className="h-3 w-3 text-muted-foreground" />
              {model.modality}
            </span>
          ) : null}
        </div>

        {inputPrice || outputPrice ? (
          <div>
            <p className="mb-2 flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Coins className="h-3 w-3" /> Pricing
            </p>
            <div className="grid grid-cols-2 gap-2">
              {inputPrice ? (
                <div className="rounded-md bg-muted px-3 py-2">
                  <p className="mb-0.5 text-[10px] text-muted-foreground">Input</p>
                  <p className="font-mono text-sm text-foreground">{inputPrice}</p>
                </div>
              ) : null}
              {outputPrice ? (
                <div className="rounded-md bg-muted px-3 py-2">
                  <p className="mb-0.5 text-[10px] text-muted-foreground">Output</p>
                  <p className="font-mono text-sm text-foreground">{outputPrice}</p>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {model.description ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">About</p>
            <p className="text-sm leading-relaxed text-foreground">{model.description}</p>
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-border/60 px-6 py-4">
        <Button className="w-full gap-2" onClick={onUse}>
          {isActive ? <Check className="h-4 w-4" /> : null}
          {isActive ? "Currently selected" : "Use this model"}
          {isActive ? null : <Zap className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  )
}

const TOP_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "qwen",
  "deepseek",
  "minimax",
  "x-ai",
  "meta-llama",
  "mistralai",
]

interface ModelPickerProps {
  /** Stored model string (may carry the `openrouter:` prefix). Empty = default. */
  value: string
  onChange: (value: string) => void
  /** Optional capability filter — only models passing it are shown. */
  modelFilter?: (m: ModelEntry) => boolean
}

export function ModelPicker({ value, onChange, modelFilter }: ModelPickerProps) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [providerFilter, setProviderFilter] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ model: ModelEntry; group: string } | null>(
    null
  )
  // On mobile the list and detail can't sit side-by-side, so tapping a model
  // pushes a detail view over the list. This tracks which one is showing.
  const [mobileDetail, setMobileDetail] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const { data: modelGroups, isError } = useModels()
  const groups: ModelGroup[] = isError || !modelGroups ? FALLBACK_MODEL_GROUPS : modelGroups

  // Trigger label for the current value.
  const displayLabel = (() => {
    if (!value) return "Default model"
    for (const group of groups) {
      const match = group.models.find((m) => entryValue(m) === value)
      if (match) return `${group.label} — ${match.label}`
    }
    return value
  })()

  const resolveInitialPreview = useCallback(() => {
    for (const group of groups) {
      const match = group.models.find((m) => entryValue(m) === value)
      if (match) return { model: match, group: group.label }
    }
    for (const group of groups) {
      const first = modelFilter
        ? group.models.find((m) => modelFilter(m))
        : group.models[0]
      if (first) return { model: first, group: group.label }
    }
    return null
  }, [groups, value, modelFilter])

  function handleOpen() {
    setSearch("")
    setProviderFilter(null)
    setPreview(resolveInitialPreview())
    setMobileDetail(false)
    setOpen(true)
  }

  useEffect(() => {
    if (open) {
      const id = setTimeout(() => searchRef.current?.focus(), 50)
      return () => clearTimeout(id)
    }
  }, [open])

  // Filter groups by search, provider, and capability.
  const filtered = groups
    .map((g) => ({
      ...g,
      models: g.models.filter((m) => {
        const matchesSearch =
          !search.trim() ||
          m.label.toLowerCase().includes(search.toLowerCase()) ||
          m.name.toLowerCase().includes(search.toLowerCase()) ||
          m.id.toLowerCase().includes(search.toLowerCase()) ||
          g.label.toLowerCase().includes(search.toLowerCase())
        const matchesProvider =
          !providerFilter ||
          g.label.toLowerCase() === providerFilter.toLowerCase() ||
          m.id.toLowerCase().startsWith(providerFilter.toLowerCase() + "/")
        const matchesCapability = !modelFilter || modelFilter(m)
        return matchesSearch && matchesProvider && matchesCapability
      }),
    }))
    .filter((g) => g.models.length > 0)

  // Filter chips: one per custom provider (keyed by its group label) first, then
  // the top cloud providers that actually have models in the current catalogue.
  // `key` is what gets matched in `matchesProvider` above; `capitalize` only
  // affects display (cloud slugs look nicer capitalized, provider names don't).
  const hasVisible = (g: ModelGroup) =>
    !modelFilter || g.models.some((m) => modelFilter(m))

  const availableProviders: { key: string; label: string; capitalize: boolean }[] = [
    ...groups
      .filter((g) => isCustomGroup(g) && hasVisible(g))
      .map((g) => ({ key: g.label, label: g.label, capitalize: false })),
    ...TOP_PROVIDERS.filter((p) =>
      groups.some(
        (g) =>
          !isCustomGroup(g) &&
          (g.label.toLowerCase() === p.toLowerCase() ||
            g.models.some((m) => m.id.toLowerCase().startsWith(p.toLowerCase() + "/"))) &&
          hasVisible(g)
      )
    ).map((p) => ({ key: p, label: p, capitalize: true })),
  ]

  function handleUse() {
    if (preview) {
      onChange(entryValue(preview.model))
      setOpen(false)
    }
  }

  function handleUseDefault() {
    onChange("")
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className="flex h-9 w-full items-center justify-between rounded-lg border border-transparent bg-muted/60 px-3 py-1 text-sm transition-colors hover:bg-muted focus:outline-none focus:border-ring/40 focus:bg-background focus:ring-2 focus:ring-ring/15"
      >
        <span className="truncate text-foreground">{displayLabel}</span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="gap-0 overflow-hidden p-0"
          style={isMobile ? undefined : { width: "62vw", maxWidth: "62vw", height: "80vh" }}
        >
          <DialogTitle className="sr-only">Select model</DialogTitle>
          <div className="flex h-full min-h-0">
            {/* Left — search + list. On mobile this is full-width and hidden
                while the detail view is pushed over it. */}
            <div
              className={cn(
                "flex min-h-0 flex-col border-r border-border/60",
                isMobile ? "w-full" : "w-[55%]",
                isMobile && mobileDetail && "hidden"
              )}
            >
              {/* Search */}
              <div className="shrink-0 space-y-2 border-b border-border/60 px-4 pb-2 pt-3">
                <div className="flex h-9 items-center gap-2 rounded-lg border border-transparent bg-muted/60 px-3 focus-within:border-ring/40 focus-within:bg-background">
                  <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <input
                    ref={searchRef}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search models..."
                    className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  />
                </div>
                {/* Provider filter chips */}
                {availableProviders.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {availableProviders.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() =>
                          setProviderFilter(providerFilter === p.key ? null : p.key)
                        }
                        className={cn(
                          "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                          p.capitalize && "capitalize",
                          providerFilter === p.key
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                        )}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {/* Model list */}
              <ScrollArea className="min-h-0 flex-1">
                <div className="py-2">
                  {/* Default (fall back to the server default model). */}
                  <button
                    type="button"
                    onClick={handleUseDefault}
                    className={cn(
                      "flex w-full items-center gap-2 px-4 text-left transition-colors",
                      isMobile ? "min-h-[44px] py-3" : "py-1.5",
                      "text-foreground hover:bg-muted/60"
                    )}
                  >
                    <span className="flex-1 text-xs font-medium">Default model</span>
                    {!value ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
                  </button>
                  <div className="mx-3 my-1 h-px bg-border" />

                  {filtered.length === 0 ? (
                    <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                      No models found.
                    </p>
                  ) : (
                    filtered.map((group, gi) => (
                      <div key={group.label}>
                        {gi > 0 ? <div className="mx-3 my-1 h-px bg-border" /> : null}
                        <p className="px-4 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                          {group.label}
                        </p>
                        {group.models.map((m) => {
                          const isSelected = entryValue(m) === value
                          const isPreviewed =
                            preview !== null &&
                            entryValue(preview.model) === entryValue(m)
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => {
                                setPreview({ model: m, group: group.label })
                                if (isMobile) setMobileDetail(true)
                              }}
                              onDoubleClick={handleUse}
                              className={cn(
                                "flex w-full items-center gap-2 px-4 text-left transition-colors",
                                isMobile ? "min-h-[44px] py-3" : "py-1.5",
                                isPreviewed
                                  ? "bg-muted text-foreground"
                                  : "text-foreground hover:bg-muted/60"
                              )}
                            >
                              <span className="flex-1 truncate font-mono text-xs">
                                {m.label}
                              </span>
                              {isSelected ? (
                                <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                              ) : null}
                            </button>
                          )
                        })}
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* Right — model detail. On mobile this is full-width and only
                shown after a model is tapped (pushed over the list). */}
            <div
              className={cn(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                isMobile && "w-full",
                isMobile && !mobileDetail && "hidden"
              )}
            >
              {isMobile ? (
                <button
                  type="button"
                  onClick={() => setMobileDetail(false)}
                  className="flex min-h-[44px] shrink-0 items-center gap-1 border-b border-border/60 px-3 py-3 text-sm text-muted-foreground"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Back to models
                </button>
              ) : null}
              {preview ? (
                <ModelDetail
                  model={preview.model}
                  group={preview.group}
                  onUse={handleUse}
                  isActive={entryValue(preview.model) === value}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                  <Cpu className="mb-3 h-8 w-8 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">
                    Select a model to preview details
                  </p>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
