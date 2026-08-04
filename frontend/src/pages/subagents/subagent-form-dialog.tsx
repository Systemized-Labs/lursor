import { FileText } from "@phosphor-icons/react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import type {
  Subagent,
  SubagentInput,
  ThinkingLevel,
  ToolChoice,
} from "@/api/types"
import { useCreateSubagent, useUpdateSubagent } from "@/api/subagents"
import { usePromptTemplates } from "@/api/prompt-templates"
import { useTools } from "@/api/tools"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/responsive-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ModelPicker } from "@/components/model-picker"
import { MultiSelect } from "@/components/multi-select"
import {
  CompactionFields,
  fractionToPercentText,
  parsePercentText,
} from "@/components/compaction-fields"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useMemoryHint } from "@/pages/settings/memory-hint"
import { useVideoHint } from "@/pages/agents/video-hint"

const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"]

const TOOL_CHOICES: { value: ToolChoice; label: string }[] = [
  { value: "auto", label: "Auto (model decides)" },
  { value: "required", label: "Required (force a tool)" },
  { value: "none", label: "None (text only)" },
]

type BooleanFieldKey =
  | "include_todo"
  | "include_subagents"
  | "include_skills"
  | "include_memory"
  | "include_plan"
  | "web_search"
  | "include_video"

const BOOLEAN_FIELDS: {
  key: BooleanFieldKey
  label: string
  /** Shown under the label. For a toggle whose cost isn't obvious from its name. */
  hint?: string
}[] = [
  { key: "include_todo", label: "Include todo" },
  { key: "include_subagents", label: "Include subagents" },
  { key: "include_skills", label: "Include skills" },
  // "Memory", not "Include memory": the toggle decides whether this subagent
  // remembers across runs; where that memory lives is an app-wide provider
  // choice named in the hint below it (see ``useMemoryHint``).
  { key: "include_memory", label: "Memory" },
  { key: "include_plan", label: "Include plan" },
  { key: "web_search", label: "Web search" },
  {
    key: "include_video",
    label: "Video generation",
    hint: "Only takes effect when the delegating agent has video on too — it spends that agent's box.",
  },
]

interface FormState {
  name: string
  description: string
  instructions: string
  model: string
  include_todo: boolean
  include_subagents: boolean
  include_skills: boolean
  include_memory: boolean
  include_plan: boolean
  web_search: boolean
  include_video: boolean
  thinking: ThinkingLevel
  tool_choice: ToolChoice
  // Whole-percent text; "" means no override (see ``CompactionFields``).
  compactionThresholdText: string
  compactionRatioText: string
  extraConfigText: string
  tool_ids: string[]
}

function emptyState(): FormState {
  return {
    name: "",
    description: "",
    instructions: "",
    model: "",
    include_todo: true,
    include_subagents: false,
    include_skills: true,
    include_memory: false,
    include_plan: false,
    web_search: false,
    include_video: false,
    thinking: "off",
    tool_choice: "auto",
    compactionThresholdText: "",
    compactionRatioText: "",
    extraConfigText: "{}",
    tool_ids: [],
  }
}

function fromSubagent(subagent: Subagent): FormState {
  return {
    name: subagent.name,
    description: subagent.description,
    instructions: subagent.instructions,
    model: subagent.model ?? "",
    include_todo: subagent.include_todo,
    include_subagents: subagent.include_subagents,
    include_skills: subagent.include_skills,
    include_memory: subagent.include_memory,
    include_plan: subagent.include_plan,
    web_search: subagent.web_search,
    include_video: subagent.include_video,
    thinking: subagent.thinking,
    tool_choice: subagent.tool_choice ?? "auto",
    compactionThresholdText: fractionToPercentText(subagent.compaction_threshold),
    compactionRatioText: fractionToPercentText(subagent.compaction_ratio),
    extraConfigText: JSON.stringify(subagent.extra_config ?? {}, null, 2),
    tool_ids: subagent.tool_ids,
  }
}

interface SubagentFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  subagent?: Subagent
}

export function SubagentFormDialog({
  open,
  onOpenChange,
  subagent,
}: SubagentFormDialogProps) {
  const [form, setForm] = useState<FormState>(emptyState)
  // A pending destructive replace guarded by a confirm dialog when the
  // instructions field already has content.
  const [pendingInstructions, setPendingInstructions] = useState<string | null>(
    null
  )
  const createSubagent = useCreateSubagent()
  const updateSubagent = useUpdateSubagent()
  const toolsQuery = useTools()
  const templatesQuery = usePromptTemplates()
  // Where memory goes if the toggle below is on. A subagent shares its parent's
  // bank and workspace, so this is the same app-wide provider.
  const memoryHint = useMemoryHint()
  // Only resolved while the dialog is open: it reaches the box behind a cache.
  const videoHint = useVideoHint(open)
  const isEdit = Boolean(subagent)
  const isSaving = createSubagent.isPending || updateSubagent.isPending

  const templateGroups = useMemo(() => {
    const byCategory = new Map<string, { id: string; name: string }[]>()
    for (const t of templatesQuery.data ?? []) {
      const list = byCategory.get(t.category) ?? []
      list.push({ id: t.id, name: t.name })
      byCategory.set(t.category, list)
    }
    return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [templatesQuery.data])

  const toolOptions = useMemo(
    () =>
      (toolsQuery.data ?? []).map((t) => ({
        value: t.id,
        label: t.name,
        description: t.description,
      })),
    [toolsQuery.data]
  )

  useEffect(() => {
    if (open) {
      setForm(subagent ? fromSubagent(subagent) : emptyState())
      setPendingInstructions(null)
    }
  }, [open, subagent])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  /** Set instructions, confirming first when there is content to overwrite. */
  function applyInstructions(next: string) {
    if (form.instructions.trim()) {
      setPendingInstructions(next)
    } else {
      update("instructions", next)
    }
  }

  function handlePickTemplate(templateId: string) {
    const template = (templatesQuery.data ?? []).find(
      (t) => t.id === templateId
    )
    if (template) applyInstructions(template.content)
  }

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("Name is required")
      return
    }

    let extraConfig: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(form.extraConfigText || "{}")
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Extra config must be a JSON object")
      }
      extraConfig = parsed as Record<string, unknown>
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Extra config is not valid JSON"
      )
      return
    }

    const threshold = parsePercentText(form.compactionThresholdText, "Compact at")
    if (!threshold.ok) {
      toast.error(threshold.error)
      return
    }
    const ratio = parsePercentText(form.compactionRatioText, "Compact")
    if (!ratio.ok) {
      toast.error(ratio.error)
      return
    }

    const input: SubagentInput = {
      name: form.name.trim(),
      description: form.description.trim(),
      instructions: form.instructions,
      model: form.model.trim() ? form.model.trim() : null,
      include_todo: form.include_todo,
      include_subagents: form.include_subagents,
      include_skills: form.include_skills,
      include_memory: form.include_memory,
      include_plan: form.include_plan,
      web_search: form.web_search,
      include_video: form.include_video,
      thinking: form.thinking,
      tool_choice: form.tool_choice,
      compaction_threshold: threshold.value,
      compaction_ratio: ratio.value,
      // Enabled state is toggled from the card, not this form; preserve it.
      enabled: subagent?.enabled ?? true,
      extra_config: extraConfig,
      tool_ids: form.tool_ids,
    }
    try {
      if (subagent) {
        await updateSubagent.mutateAsync({ id: subagent.id, input })
        toast.success("Subagent updated")
      } else {
        await createSubagent.mutateAsync(input)
        toast.success("Subagent created")
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save subagent")
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit subagent" : "New subagent"}</DialogTitle>
          <DialogDescription>
            Subagents are specialists your agents can delegate tasks to. They
            apply to every agent that has subagents enabled, and get the same
            capability controls as a top-level agent.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="subagent-name">Name</Label>
            <Input
              id="subagent-name"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="subagent-description">Description</Label>
            <Input
              id="subagent-description"
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Shown to the parent agent when it chooses which specialist to
              delegate to.
            </p>
          </div>

          <div className="grid gap-4">
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="subagent-model">Model</Label>
              <ModelPicker
                value={form.model}
                onChange={(value) => update("model", value)}
              />
              <p className="text-xs text-muted-foreground">
                Optional. Leave unset to inherit the parent agent's model.
              </p>
            </div>
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="subagent-thinking">Thinking</Label>
              <Select
                value={form.thinking}
                onValueChange={(value) =>
                  update("thinking", value as ThinkingLevel)
                }
              >
                <SelectTrigger id="subagent-thinking">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THINKING_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid min-w-0 gap-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="subagent-tool-choice">Tool calls</Label>
                <span className="text-xs text-muted-foreground">
                  Force or forbid tool use
                </span>
              </div>
              <Select
                value={form.tool_choice}
                onValueChange={(value) =>
                  update("tool_choice", value as ToolChoice)
                }
              >
                <SelectTrigger id="subagent-tool-choice">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TOOL_CHOICES.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="subagent-instructions">Instructions</Label>
            <Textarea
              id="subagent-instructions"
              value={form.instructions}
              onChange={(e) => update("instructions", e.target.value)}
              className="min-h-[200px] font-mono text-xs"
              spellCheck={false}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Select value="" onValueChange={handlePickTemplate}>
                <SelectTrigger className="h-8 w-auto gap-1.5 text-xs">
                  <FileText className="h-3.5 w-3.5" />
                  <SelectValue placeholder="Start from a template" />
                </SelectTrigger>
                <SelectContent>
                  {templateGroups.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      No templates yet
                    </div>
                  ) : (
                    templateGroups.map(([category, items]) => (
                      <SelectGroup key={category}>
                        <SelectLabel>{category}</SelectLabel>
                        {items.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-3 rounded-md border p-4">
            <span className="text-sm font-medium text-foreground">
              Capabilities
            </span>
            <div className="grid gap-3 sm:grid-cols-2">
              {BOOLEAN_FIELDS.map((field) => (
                <div
                  key={field.key}
                  className="flex items-start justify-between gap-2"
                >
                  <div className="grid gap-0.5">
                    <Label htmlFor={`subagent-${field.key}`}>{field.label}</Label>
                    {field.key === "include_memory" && memoryHint ? (
                      <p className="text-xs text-muted-foreground">{memoryHint}</p>
                    ) : null}
                    {field.hint ? (
                      <p className="text-xs text-muted-foreground">{field.hint}</p>
                    ) : null}
                    {field.key === "include_video" && videoHint ? (
                      <p className="text-xs text-muted-foreground">{videoHint}</p>
                    ) : null}
                  </div>
                  <Switch
                    id={`subagent-${field.key}`}
                    checked={form[field.key]}
                    onCheckedChange={(checked) => update(field.key, checked)}
                  />
                </div>
              ))}
            </div>
          </div>

          <CompactionFields
            idPrefix="subagent"
            threshold={form.compactionThresholdText}
            ratio={form.compactionRatioText}
            onChange={(field, value) =>
              update(
                field === "threshold"
                  ? "compactionThresholdText"
                  : "compactionRatioText",
                value
              )
            }
          />

          <div className="grid gap-2">
            <Label>Tools</Label>
            <MultiSelect
              options={toolOptions}
              selected={form.tool_ids}
              onChange={(ids) => update("tool_ids", ids)}
              emptyText="No tools created yet."
            />
            <p className="text-xs text-muted-foreground">
              Skills are picked up from whatever is assigned to the workspace this
              runs in, not attached here. Toggle the{" "}
              <span className="font-medium text-foreground">Skills</span>{" "}
              capability above to let this subagent use them.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="subagent-extra-config">Extra config (JSON)</Label>
            <Textarea
              id="subagent-extra-config"
              value={form.extraConfigText}
              onChange={(e) => update("extraConfigText", e.target.value)}
              className="min-h-[100px] font-mono text-xs"
              spellCheck={false}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving}>
            {isEdit ? "Save changes" : "Create subagent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <ConfirmDialog
      open={pendingInstructions !== null}
      onOpenChange={(open) => !open && setPendingInstructions(null)}
      title="Replace instructions?"
      description="This will overwrite the current instructions. This can't be undone."
      confirmLabel="Replace"
      onConfirm={() => {
        if (pendingInstructions !== null) {
          update("instructions", pendingInstructions)
        }
        setPendingInstructions(null)
      }}
    />
    </>
  )
}
