import { FileText, ShootingStar, MagicWand } from "@phosphor-icons/react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import type {
  Agent,
  AgentInput,
  AgentPromptContext,
  ThinkingLevel,
  ToolChoice,
} from "@/api/types"
import {
  useCreateAgent,
  useGeneratePrompt,
  useImprovePrompt,
  useUpdateAgent,
} from "@/api/agents"
import { usePromptTemplates } from "@/api/prompt-templates"
import { useSkills } from "@/api/skills"
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
import { MultiSelect } from "@/components/multi-select"
import { ModelPicker } from "@/components/model-picker"
import {
  CompactionFields,
  fractionToPercentText,
  parsePercentText,
} from "@/components/compaction-fields"
import { useMemoryHint } from "@/pages/settings/memory-hint"

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
  | "browser_qa"
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
  // "Memory", not "Include memory": the toggle decides whether this agent
  // remembers across runs, while where that memory lives is an app-wide provider
  // choice named in the hint below it (see ``useMemoryHint``).
  { key: "include_memory", label: "Memory" },
  { key: "include_plan", label: "Include plan" },
  { key: "web_search", label: "Web search" },
  { key: "browser_qa", label: "Browser QA" },
  {
    key: "include_video",
    label: "Video generation",
    hint: "Generate clips on a connected laios box. Each render runs for minutes on that box's GPU.",
  },
]

interface FormState {
  name: string
  description: string
  model: string
  instructions: string
  include_todo: boolean
  include_subagents: boolean
  include_skills: boolean
  include_memory: boolean
  include_plan: boolean
  web_search: boolean
  browser_qa: boolean
  include_video: boolean
  thinking: ThinkingLevel
  tool_choice: ToolChoice
  // Compaction overrides are edited as whole-percent text; "" means "no override,
  // use the app default" (see ``CompactionFields``).
  compactionThresholdText: string
  compactionRatioText: string
  extraConfigText: string
  tool_ids: string[]
}

function emptyState(): FormState {
  return {
    name: "",
    description: "",
    model: "",
    instructions: "",
    include_todo: false,
    include_subagents: false,
    include_skills: false,
    include_memory: false,
    include_plan: false,
    web_search: false,
    // On by default — matches the backend default and prior behaviour where every
    // executing agent got browser tools.
    browser_qa: true,
    // Off by default: a clip is minutes of GPU time on someone's box, so it is an
    // explicit choice rather than something an agent quietly arrives with.
    include_video: false,
    thinking: "off",
    tool_choice: "auto",
    compactionThresholdText: "",
    compactionRatioText: "",
    extraConfigText: "{}",
    tool_ids: [],
  }
}

function fromAgent(agent: Agent): FormState {
  return {
    name: agent.name,
    description: agent.description,
    model: agent.model ?? "",
    instructions: agent.instructions,
    include_todo: agent.include_todo,
    include_subagents: agent.include_subagents,
    include_skills: agent.include_skills,
    include_memory: agent.include_memory,
    include_plan: agent.include_plan,
    web_search: agent.web_search,
    browser_qa: agent.browser_qa,
    include_video: agent.include_video,
    thinking: agent.thinking,
    tool_choice: agent.tool_choice ?? "auto",
    compactionThresholdText: fractionToPercentText(agent.compaction_threshold),
    compactionRatioText: fractionToPercentText(agent.compaction_ratio),
    extraConfigText: JSON.stringify(agent.extra_config ?? {}, null, 2),
    tool_ids: agent.tool_ids,
  }
}

interface AgentFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agent?: Agent
}

export function AgentFormDialog({
  open,
  onOpenChange,
  agent,
}: AgentFormDialogProps) {
  const [form, setForm] = useState<FormState>(emptyState)
  // Skills are no longer linked per-agent — each carries an assignment and is
  // discovered at build time for whatever workspace the agent runs in. We still
  // read the globally-assigned set so prompt authoring stays capability-aware
  // about what an agent with skills-on will see everywhere.
  const skillsQuery = useSkills({ assignment: "global" })
  const toolsQuery = useTools()
  const templatesQuery = usePromptTemplates()
  const createAgent = useCreateAgent()
  const updateAgent = useUpdateAgent()
  const generatePrompt = useGeneratePrompt()
  const improvePrompt = useImprovePrompt()
  // Where memory goes if the toggle below is on — an app-wide provider choice, so
  // it's read here rather than being part of the agent's own config.
  const memoryHint = useMemoryHint()

  // Prompt-authoring UI state: an inline brief box, and a pending destructive
  // replace guarded by a confirm dialog when the field already has content.
  const [briefOpen, setBriefOpen] = useState(false)
  const [brief, setBrief] = useState("")
  const [pendingInstructions, setPendingInstructions] = useState<string | null>(
    null
  )

  const isEdit = Boolean(agent)
  const isSaving = createAgent.isPending || updateAgent.isPending
  const isAuthoring = generatePrompt.isPending || improvePrompt.isPending

  const templateGroups = useMemo(() => {
    const byCategory = new Map<string, { id: string; name: string }[]>()
    for (const t of templatesQuery.data ?? []) {
      const list = byCategory.get(t.category) ?? []
      list.push({ id: t.id, name: t.name })
      byCategory.set(t.category, list)
    }
    return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [templatesQuery.data])

  useEffect(() => {
    if (open) {
      setForm(agent ? fromAgent(agent) : emptyState())
      setBriefOpen(false)
      setBrief("")
      setPendingInstructions(null)
    }
  }, [open, agent])

  const toolOptions = useMemo(
    () =>
      (toolsQuery.data ?? []).map((t) => ({
        value: t.id,
        label: t.name,
        description: t.description,
      })),
    [toolsQuery.data]
  )

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  /** Snapshot the current form as the capability context for prompt authoring. */
  function buildPromptContext(): AgentPromptContext {
    const namesFor = (
      rows: { id: string; name: string }[] | undefined,
      ids: string[]
    ) => (rows ?? []).filter((row) => ids.includes(row.id)).map((row) => row.name)
    return {
      name: form.name.trim(),
      description: form.description.trim(),
      include_todo: form.include_todo,
      include_subagents: form.include_subagents,
      include_skills: form.include_skills,
      include_memory: form.include_memory,
      include_plan: form.include_plan,
      web_search: form.web_search,
      browser_qa: form.browser_qa,
      include_video: form.include_video,
      thinking: form.thinking,
      // Skills are scope-discovered; when enabled the agent sees every global
      // skill (plus its workspace's own at run time), so surface the global set.
      skill_names: form.include_skills
        ? (skillsQuery.data ?? []).map((s) => s.name)
        : [],
      tool_names: namesFor(toolsQuery.data, form.tool_ids),
      model: form.model.trim() ? form.model.trim() : null,
    }
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

  async function handleGenerate() {
    if (!brief.trim()) {
      toast.error("Describe the agent you want first")
      return
    }
    try {
      const result = await generatePrompt.mutateAsync({
        brief: brief.trim(),
        context: buildPromptContext(),
      })
      applyInstructions(result.instructions)
      setBriefOpen(false)
      setBrief("")
      toast.success("Prompt generated")
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to generate prompt"
      )
    }
  }

  async function handleImprove() {
    if (!form.instructions.trim()) {
      toast.error("Write or pick a prompt to improve first")
      return
    }
    try {
      const result = await improvePrompt.mutateAsync({
        current: form.instructions,
        context: buildPromptContext(),
      })
      // Improve is derived from the current text, so replace in place.
      update("instructions", result.instructions)
      toast.success("Prompt improved")
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to improve prompt"
      )
    }
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

    const input: AgentInput = {
      name: form.name.trim(),
      description: form.description.trim(),
      model: form.model.trim() ? form.model.trim() : null,
      instructions: form.instructions,
      include_todo: form.include_todo,
      include_subagents: form.include_subagents,
      include_skills: form.include_skills,
      include_memory: form.include_memory,
      include_plan: form.include_plan,
      web_search: form.web_search,
      browser_qa: form.browser_qa,
      include_video: form.include_video,
      thinking: form.thinking,
      tool_choice: form.tool_choice,
      compaction_threshold: threshold.value,
      compaction_ratio: ratio.value,
      extra_config: extraConfig,
      tool_ids: form.tool_ids,
    }

    try {
      if (agent) {
        await updateAgent.mutateAsync({ id: agent.id, input })
        toast.success("Agent updated")
      } else {
        await createAgent.mutateAsync(input)
        toast.success("Agent created")
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save agent")
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit agent" : "New agent"}</DialogTitle>
          <DialogDescription>
            Configure the agent's identity, capabilities, and attached
            resources.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="Support assistant"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="agent-description">Description</Label>
            <Input
              id="agent-description"
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
              placeholder="Short summary of what this agent does"
            />
          </div>

          <div className="grid gap-4">
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="agent-model">Model</Label>
              <ModelPicker
                value={form.model}
                onChange={(value) => update("model", value)}
              />
            </div>
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="agent-thinking">Thinking</Label>
              <Select
                value={form.thinking}
                onValueChange={(value) =>
                  update("thinking", value as ThinkingLevel)
                }
              >
                <SelectTrigger id="agent-thinking">
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
                <Label htmlFor="agent-tool-choice">Tool calls</Label>
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
                <SelectTrigger id="agent-tool-choice">
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
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="agent-instructions">Instructions</Label>
              <span className="text-xs text-muted-foreground">
                The agent's system prompt
              </span>
            </div>
            <Textarea
              id="agent-instructions"
              value={form.instructions}
              onChange={(e) => update("instructions", e.target.value)}
              placeholder="System instructions for the agent"
              className="min-h-[160px]"
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

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => setBriefOpen((prev) => !prev)}
                disabled={isAuthoring}
              >
                <ShootingStar className="h-3.5 w-3.5" />
                Generate
              </Button>

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={handleImprove}
                disabled={isAuthoring || !form.instructions.trim()}
              >
                <MagicWand className="h-3.5 w-3.5" />
                {improvePrompt.isPending ? "Improving…" : "Improve current"}
              </Button>
            </div>

            {briefOpen ? (
              <div className="grid gap-2 rounded-md border p-3">
                <Label htmlFor="agent-brief" className="text-xs">
                  Describe the agent you want, and AI will draft a prompt using
                  the capabilities enabled below.
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="agent-brief"
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                    placeholder="a friendly support agent for a SaaS billing product"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        void handleGenerate()
                      }
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleGenerate}
                    disabled={generatePrompt.isPending || !brief.trim()}
                  >
                    {generatePrompt.isPending ? "Generating…" : "Generate"}
                  </Button>
                </div>
              </div>
            ) : null}
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
                    <Label htmlFor={`agent-${field.key}`}>{field.label}</Label>
                    {field.key === "include_memory" && memoryHint ? (
                      <p className="text-xs text-muted-foreground">{memoryHint}</p>
                    ) : null}
                    {field.hint ? (
                      <p className="text-xs text-muted-foreground">{field.hint}</p>
                    ) : null}
                  </div>
                  <Switch
                    id={`agent-${field.key}`}
                    checked={form[field.key]}
                    onCheckedChange={(checked) => update(field.key, checked)}
                  />
                </div>
              ))}
            </div>
          </div>

          <CompactionFields
            idPrefix="agent"
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
              Skills are no longer attached per agent. With the{" "}
              <span className="font-medium text-foreground">Skills</span>{" "}
              capability on, this agent automatically gets every global skill
              plus whatever lives in the workspace it runs in. Manage them on
              the Skills page.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="agent-extra-config">Extra config (JSON)</Label>
            <Textarea
              id="agent-extra-config"
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
            {isEdit ? "Save changes" : "Create agent"}
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
