import { toast } from "sonner"

import { useAgents } from "@/api/agents"
import { useDefaultAgents, useSaveDefaultAgents } from "@/api/settings"
import type { ChatMode, DefaultAgentsInput } from "@/api/types"
import { MODE_META, MODE_ORDER } from "@/components/chat/chat-modes"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

// Select can't hold an empty-string value, so this sentinel represents "no
// default agent for this mode".
const NONE = "__none__"

/**
 * Default agent per chat mode (Ask / Edit / Plan). Selecting a mode in the
 * composer switches to (and reassigns an open thread to) that mode's agent, so
 * each mode can run under a dedicated agent — the agent brings its own model,
 * tools, and instructions.
 */
export function DefaultAgentsSection() {
  const { data, isLoading } = useDefaultAgents()
  const { data: agentsData } = useAgents()
  const agents = agentsData ?? []
  const save = useSaveDefaultAgents()

  async function handleChange(mode: ChatMode, agentId: string) {
    const input: DefaultAgentsInput = { [mode]: agentId === NONE ? "" : agentId }
    try {
      await save.mutateAsync(input)
      toast.success("Saved")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Default agent per mode</CardTitle>
        <CardDescription>
          The agent used when you switch to each chat mode. Switching modes
          selects that mode&apos;s agent and reassigns the open conversation to
          it. Leave a mode on &quot;No default&quot; to keep the current agent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {MODE_ORDER.map((mode) => {
          const meta = MODE_META[mode]
          const Icon = meta.Icon
          const current = data?.[mode] || NONE
          return (
            <div
              key={mode}
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {meta.label}
                  </div>
                  <div className="text-xs text-muted-foreground">{meta.hint}</div>
                </div>
              </div>
              <Select
                value={current}
                disabled={isLoading}
                onValueChange={(v) => void handleChange(mode, v)}
              >
                <SelectTrigger className="w-full sm:w-72">
                  <SelectValue placeholder="No default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No default</SelectItem>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
