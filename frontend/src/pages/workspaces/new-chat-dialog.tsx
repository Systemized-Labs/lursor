import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import type { Agent, Workspace } from "@/api/types"
import { useCreateThread } from "@/api/threads"
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

interface NewChatDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: Workspace
  agents: Agent[]
}

export function NewChatDialog({
  open,
  onOpenChange,
  workspace,
  agents,
}: NewChatDialogProps) {
  const navigate = useNavigate()
  const createThread = useCreateThread()
  const [agentId, setAgentId] = useState<string>("")
  const [title, setTitle] = useState<string>("")

  const workspaceAgents = useMemo(
    () => agents.filter((a) => workspace.agent_ids.includes(a.id)),
    [agents, workspace.agent_ids]
  )

  useEffect(() => {
    if (open) {
      setAgentId(workspaceAgents[0]?.id ?? "")
      setTitle("")
    }
  }, [open, workspaceAgents])

  async function handleCreate() {
    if (!agentId) {
      toast.error("Select an agent")
      return
    }
    try {
      const thread = await createThread.mutateAsync({
        workspace_id: workspace.id,
        agent_id: agentId,
        title: title.trim() || "New chat",
      })
      onOpenChange(false)
      navigate(`/workspaces/${workspace.id}/threads/${thread.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create chat")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New chat</DialogTitle>
          <DialogDescription>
            Start a thread with an agent in this workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="chat-title">Title</Label>
            <Input
              id="chat-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="New chat"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="chat-agent">Agent</Label>
            {workspaceAgents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This workspace has no agents. Add one by editing the workspace.
              </p>
            ) : (
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger id="chat-agent">
                  <SelectValue placeholder="Select an agent" />
                </SelectTrigger>
                <SelectContent>
                  {workspaceAgents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createThread.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={createThread.isPending || workspaceAgents.length === 0}
          >
            Start chat
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
