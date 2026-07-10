import { Pencil, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import type { Agent } from "@/api/types"
import { useAgents, useDeleteAgent } from "@/api/agents"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { AgentFormDialog } from "./agent-form-dialog"

const DESCRIPTION = "Configure the agents available in your harness."

export function AgentsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: agents, isLoading, isError, error } = useAgents()
  const deleteAgent = useDeleteAgent()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Agent | undefined>(undefined)
  const [toDelete, setToDelete] = useState<Agent | undefined>(undefined)

  function openCreate() {
    setEditing(undefined)
    setFormOpen(true)
  }

  function openEdit(agent: Agent) {
    setEditing(agent)
    setFormOpen(true)
  }

  async function confirmDelete() {
    if (!toDelete) return
    try {
      await deleteAgent.mutateAsync(toDelete.id)
      toast.success("Agent deleted")
      setToDelete(undefined)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete agent")
    }
  }

  const action = (
    <Button onClick={openCreate}>
      <Plus className="h-4 w-4" />
      New agent
    </Button>
  )

  return (
    <div className="space-y-6">
      {embedded ? (
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">{DESCRIPTION}</p>
          {action}
        </div>
      ) : (
        <PageHeader title="Agents" description={DESCRIPTION} actions={action} />
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading agents…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load agents"}
        </p>
      ) : !agents || agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          description="Create your first agent to start building your harness."
          action={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              New agent
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <Card key={agent.id} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="truncate">{agent.name}</CardTitle>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(agent)}
                      aria-label="Edit agent"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setToDelete(agent)}
                      aria-label="Delete agent"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <CardDescription className="line-clamp-2">
                  {agent.description || "No description"}
                </CardDescription>
              </CardHeader>
              <CardContent className="mt-auto flex flex-wrap gap-2">
                <Badge variant="secondary">{agent.model ?? "default model"}</Badge>
                <Badge variant="outline">thinking: {agent.thinking}</Badge>
                {agent.web_search ? (
                  <Badge variant="outline">web search</Badge>
                ) : null}
                <Badge variant="outline">{agent.skill_ids.length} skills</Badge>
                <Badge variant="outline">{agent.tool_ids.length} tools</Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AgentFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        agent={editing}
      />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(open) => !open && setToDelete(undefined)}
        title="Delete agent"
        description={
          toDelete
            ? `This will permanently delete "${toDelete.name}".`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        loading={deleteAgent.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
