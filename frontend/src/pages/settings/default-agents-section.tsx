import { ChatText, NotePencil, Question, Target } from "@phosphor-icons/react"
import { toast } from "sonner"

import { useAgents } from "@/api/agents"
import { useDefaultAgents, useSaveDefaultAgents } from "@/api/settings"
import type { DefaultAgentsInput, DefaultAgentsSettings } from "@/api/types"
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
// default agent for this command".
const NONE = "__none__"

/** The commands that can carry a default agent, with presentation. Mirrors the
 *  chat command registry (`chat` is the plain, no-command turn). */
const COMMAND_ROWS: {
  key: keyof DefaultAgentsSettings
  label: string
  hint: string
  Icon: typeof Question
}[] = [
  { key: "chat", label: "Chat", hint: "A plain message — full tools", Icon: ChatText },
  { key: "ask", label: "/ask", hint: "Read-only — answer without editing", Icon: Question },
  { key: "plan", label: "/plan", hint: "Propose a plan, then approve to run", Icon: NotePencil },
  { key: "goal", label: "/goal", hint: "Work autonomously until the goal is met", Icon: Target },
]

/**
 * Default agent per slash command. Using a command in the composer switches to
 * (and reassigns an open thread to) that command's agent, so each can run under
 * a dedicated agent — the agent brings its own model, tools, and instructions.
 */
export function DefaultAgentsSection() {
  const { data, isLoading } = useDefaultAgents()
  const { data: agentsData } = useAgents()
  const agents = agentsData ?? []
  const save = useSaveDefaultAgents()

  async function handleChange(
    key: keyof DefaultAgentsSettings,
    agentId: string
  ) {
    const input: DefaultAgentsInput = { [key]: agentId === NONE ? "" : agentId }
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
        <CardTitle>Default agent per command</CardTitle>
        <CardDescription>
          The agent used when you run each slash command. Using a command selects
          its agent and reassigns the open conversation to it. Leave a command on
          &quot;No default&quot; to keep the current agent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {COMMAND_ROWS.map(({ key, label, hint, Icon }) => {
          const current = data?.[key] || NONE
          return (
            <div
              key={key}
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {label}
                  </div>
                  <div className="text-xs text-muted-foreground">{hint}</div>
                </div>
              </div>
              <Select
                value={current}
                disabled={isLoading}
                onValueChange={(v) => void handleChange(key, v)}
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
