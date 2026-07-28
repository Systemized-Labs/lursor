import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { useCreateSchedule } from "@/api/schedules"
import type { Agent, Schedule, Workspace } from "@/api/types"
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { CronField } from "./cron-field"
import { hostTimezone, timezoneOptions } from "./schedule-format"

interface ScheduleCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaces: Workspace[]
  agents: Agent[]
  /** Preselect this workspace when it exists (e.g. the one you came from). */
  defaultWorkspaceId?: string
  /** Hand the new schedule back so the caller can select it in the rail. */
  onCreated: (schedule: Schedule) => void
}

const DEFAULT_CRON = "0 9 * * *"

/**
 * The minimum to make a schedule that fires: where, who, when, and what to say.
 *
 * Run type, success criteria and the turn cap are deliberately not here. A new
 * schedule is a single turn — the cheap, bounded default — and the detail pane it
 * opens into is where you upgrade it to an autonomous goal, with the room to
 * explain what that costs. Deciding that in a modal before you have seen the
 * schedule run once is the wrong order.
 */
export function ScheduleCreateDialog({
  open,
  onOpenChange,
  workspaces,
  agents,
  defaultWorkspaceId,
  onCreated,
}: ScheduleCreateDialogProps) {
  const createSchedule = useCreateSchedule()
  const [name, setName] = useState("")
  const [workspaceId, setWorkspaceId] = useState("")
  const [agentId, setAgentId] = useState("")
  const [cron, setCron] = useState(DEFAULT_CRON)
  const [timezone, setTimezone] = useState(hostTimezone())
  const [prompt, setPrompt] = useState("")
  const zones = useMemo(() => timezoneOptions(), [])

  // Reset on each open, and default the pickers to something valid so the form is
  // one field away from savable rather than four.
  useEffect(() => {
    if (!open) return
    setName("")
    setCron(DEFAULT_CRON)
    setTimezone(hostTimezone())
    setPrompt("")
    setWorkspaceId(
      defaultWorkspaceId && workspaces.some((w) => w.id === defaultWorkspaceId)
        ? defaultWorkspaceId
        : (workspaces[0]?.id ?? "")
    )
    setAgentId(agents[0]?.id ?? "")
  }, [open, defaultWorkspaceId, workspaces, agents])

  async function handleSubmit() {
    if (!name.trim()) {
      toast.error("A name is required")
      return
    }
    if (!workspaceId || !agentId) {
      toast.error("Pick a workspace and an agent")
      return
    }
    if (!prompt.trim()) {
      toast.error("A prompt is required — it is the turn each fire sends")
      return
    }
    try {
      const created = await createSchedule.mutateAsync({
        name: name.trim(),
        workspace_id: workspaceId,
        agent_id: agentId,
        cron: cron.trim(),
        timezone,
        prompt: prompt.trim(),
      })
      toast.success(`${created.name} scheduled`)
      onOpenChange(false)
      onCreated(created)
    } catch (err) {
      // A malformed expression comes back as a 422 whose detail says what to fix.
      toast.error(err instanceof Error ? err.message : "Failed to create schedule")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New schedule</DialogTitle>
          <DialogDescription>
            A prompt sent to an agent on a repeating schedule. Each fire opens its
            own conversation, and only fires while Lursor is running.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-sched-name">Name</Label>
            <Input
              id="new-sched-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nightly dependency check"
              autoFocus
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-sched-workspace">Workspace</Label>
              <Select value={workspaceId} onValueChange={setWorkspaceId}>
                <SelectTrigger id="new-sched-workspace">
                  <SelectValue placeholder="Pick a workspace" />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-sched-agent">Agent</Label>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger id="new-sched-agent">
                  <SelectValue placeholder="Pick an agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Timezone first: it is what "9am" means, and the occurrence preview
              inside the schedule field below is resolved in it. */}
          <div className="space-y-1.5">
            <Label htmlFor="new-sched-tz">Timezone</Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger id="new-sched-tz">
                <SelectValue placeholder="Pick a timezone" />
              </SelectTrigger>
              {/* Hundreds of zones; the list scrolls rather than growing the
                  dialog. The host's own zone is first. */}
              <SelectContent className="max-h-72">
                {zones.map((zone) => (
                  <SelectItem key={zone} value={zone}>
                    {zone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-sched-cron">Schedule</Label>
            {/* Carries its own preview, so an expression is checked before the
                schedule exists rather than after it has fired at the wrong hour. */}
            <CronField
              id="new-sched-cron"
              value={cron}
              onChange={setCron}
              timezone={timezone}
              previewCount={3}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-sched-prompt">Prompt</Label>
            <Textarea
              id="new-sched-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Check for outdated dependencies and open a PR if any are behind."
            />
            <p className="text-[11px] leading-snug text-muted-foreground">
              Every fire starts a brand-new conversation, so this has to stand on
              its own. The agent will have its full toolset in that workspace with
              nobody watching.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={createSchedule.isPending}>
            Create schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
