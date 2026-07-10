import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import type { Agent, AgentInput, ThinkingLevel } from "@/api/types"
import { useCreateAgent, useUpdateAgent } from "@/api/agents"
import { useSkills } from "@/api/skills"
import { useTools } from "@/api/tools"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { MultiSelect } from "@/components/multi-select"
import { ModelPicker } from "@/components/model-picker"

const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"]

type BooleanFieldKey =
  | "include_todo"
  | "include_subagents"
  | "include_skills"
  | "include_memory"
  | "include_plan"
  | "web_search"

const BOOLEAN_FIELDS: { key: BooleanFieldKey; label: string }[] = [
  { key: "include_todo", label: "Include todo" },
  { key: "include_subagents", label: "Include subagents" },
  { key: "include_skills", label: "Include skills" },
  { key: "include_memory", label: "Include memory" },
  { key: "include_plan", label: "Include plan" },
  { key: "web_search", label: "Web search" },
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
  thinking: ThinkingLevel
  extraConfigText: string
  skill_ids: string[]
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
    thinking: "off",
    extraConfigText: "{}",
    skill_ids: [],
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
    thinking: agent.thinking,
    extraConfigText: JSON.stringify(agent.extra_config ?? {}, null, 2),
    skill_ids: agent.skill_ids,
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
  const skillsQuery = useSkills()
  const toolsQuery = useTools()
  const createAgent = useCreateAgent()
  const updateAgent = useUpdateAgent()

  const isEdit = Boolean(agent)
  const isSaving = createAgent.isPending || updateAgent.isPending

  useEffect(() => {
    if (open) {
      setForm(agent ? fromAgent(agent) : emptyState())
    }
  }, [open, agent])

  const skillOptions = useMemo(
    () =>
      (skillsQuery.data ?? []).map((s) => ({
        value: s.id,
        label: s.name,
        description: s.description,
      })),
    [skillsQuery.data]
  )
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
      thinking: form.thinking,
      extra_config: extraConfig,
      skill_ids: form.skill_ids,
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="agent-model">Model</Label>
              <ModelPicker
                value={form.model}
                onChange={(value) => update("model", value)}
              />
            </div>
            <div className="grid gap-2">
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
          </div>

          <div className="grid gap-2">
            <Label htmlFor="agent-instructions">Instructions</Label>
            <Textarea
              id="agent-instructions"
              value={form.instructions}
              onChange={(e) => update("instructions", e.target.value)}
              placeholder="System instructions for the agent"
              className="min-h-[120px]"
            />
          </div>

          <div className="grid gap-3 rounded-md border p-4">
            <span className="text-sm font-medium text-foreground">
              Capabilities
            </span>
            <div className="grid gap-3 sm:grid-cols-2">
              {BOOLEAN_FIELDS.map((field) => (
                <div
                  key={field.key}
                  className="flex items-center justify-between gap-2"
                >
                  <Label htmlFor={`agent-${field.key}`}>{field.label}</Label>
                  <Switch
                    id={`agent-${field.key}`}
                    checked={form[field.key]}
                    onCheckedChange={(checked) => update(field.key, checked)}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Skills</Label>
              <MultiSelect
                options={skillOptions}
                selected={form.skill_ids}
                onChange={(ids) => update("skill_ids", ids)}
                emptyText="No skills created yet."
              />
            </div>
            <div className="grid gap-2">
              <Label>Tools</Label>
              <MultiSelect
                options={toolOptions}
                selected={form.tool_ids}
                onChange={(ids) => update("tool_ids", ids)}
                emptyText="No tools created yet."
              />
            </div>
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
  )
}
