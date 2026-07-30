import { Robot } from "@phosphor-icons/react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { useAgents, useCreateAgent } from "@/api/agents"
import { useModels } from "@/api/models"
import { useOpenRouterSettings } from "@/api/settings"
import type { AgentInput, ModelGroup } from "@/api/types"
import { ModelPicker } from "@/components/model-picker"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

/**
 * Everything about a new agent except its name, model, and prompt. Mirrors the
 * backend's own `AgentCreate` defaults (todo, skills, and browser QA on, nothing
 * else) rather than the agent form's blank state, so this is the same "sensible
 * agent" the API would build on its own.
 */
const DEFAULTS: Omit<AgentInput, "name" | "model" | "instructions"> = {
  description: "",
  include_todo: true,
  include_subagents: false,
  include_skills: true,
  include_memory: false,
  include_plan: false,
  web_search: false,
  browser_qa: true,
  thinking: "off",
  tool_choice: "auto",
  compaction_threshold: null,
  compaction_ratio: null,
  extra_config: {},
  tool_ids: [],
}

/** The first model a custom (local) provider advertises, as the string an agent
 *  stores — `custom:{providerId}:{modelId}`. */
function firstLocalModel(groups: ModelGroup[] | undefined): string | null {
  for (const group of groups ?? []) {
    for (const model of group.models) {
      if (model.value?.startsWith("custom:")) return model.value
    }
  }
  return null
}

/**
 * Step four: the first agent — the thing a conversation actually runs. A chat
 * with no agent behind it can't be typed into ("No agents yet"), and a fresh
 * install has none, so without this the walkthrough would hand over a dead end.
 *
 * Prefilled so it is one click, but the user's own: they name it, see which model
 * it will run, and can give it a job in its own words.
 */
export function AgentStep({ onCreated }: { onCreated: () => void }) {
  const { data: agents } = useAgents()
  const { data: openrouter } = useOpenRouterSettings()
  const { data: modelGroups } = useModels()
  const create = useCreateAgent()

  const [name, setName] = useState("Assistant")
  // Empty means "inherit the app-wide default model" — what the picker calls
  // "Default model".
  const [model, setModel] = useState("")
  const [instructions, setInstructions] = useState("")
  const [pickedModel, setPickedModel] = useState(false)

  // On a local-only install, inheriting the default would name a cloud model
  // there is no key for — so point the agent at the endpoint set up in step one.
  // Once, and never over a choice the user made themselves.
  useEffect(() => {
    if (pickedModel || model || !openrouter || openrouter.configured) return
    const local = firstLocalModel(modelGroups)
    if (local) setModel(local)
  }, [pickedModel, model, openrouter, modelGroups])

  const existing = agents ?? []

  async function handleCreate() {
    if (!name.trim()) return
    try {
      await create.mutateAsync({
        ...DEFAULTS,
        name: name.trim(),
        // The picker's "Default model" is an empty string; the API wants null.
        model: model || null,
        instructions: instructions.trim(),
      })
      onCreated()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create the agent"
      )
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          Create your first agent
        </h2>
        <p className="text-sm text-muted-foreground">
          An agent is a model plus instructions. Conversations run as one, so this
          is what you&apos;ll be talking to.
        </p>
      </div>

      {existing.length > 0 ? (
        <div className="flex items-center gap-3 rounded-lg border border-success/40 bg-success/10 px-4 py-3">
          <Robot className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {existing.length === 1
                ? `“${existing[0].name}” is ready`
                : `${existing.length} agents ready`}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {existing.map((a) => a.name).join(" · ")}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="onboarding-agent-name">Name</Label>
              <Input
                id="onboarding-agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="onboarding-agent-model">Model</Label>
              <ModelPicker
                value={model}
                onChange={(v) => {
                  setPickedModel(true)
                  setModel(v)
                }}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="onboarding-agent-instructions">
              What should it do? (optional)
            </Label>
            <Textarea
              id="onboarding-agent-instructions"
              rows={3}
              placeholder="Senior engineer on my codebase. Read before you write, keep changes small, and run the tests."
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              className="resize-none"
            />
            <p className="text-xs text-muted-foreground">
              Becomes the agent&apos;s system prompt. Leave it blank for a
              general-purpose assistant — the prompt library has starting points,
              and Customization can rewrite it for you later.
            </p>
          </div>

          <div className="flex justify-end">
            <Button
              onClick={handleCreate}
              disabled={create.isPending || !name.trim()}
            >
              {create.isPending ? (
                <DotGridLoader size="xs" />
              ) : (
                <Robot className="size-4" />
              )}
              Create agent
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
