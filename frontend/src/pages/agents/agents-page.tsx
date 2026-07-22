import { Browser, Globe, Pencil, Plus, Trash } from "@phosphor-icons/react"
import { useState } from "react"
import { toast } from "sonner"

import type { Agent } from "@/api/types"
import { useAgents, useDeleteAgent } from "@/api/agents"
import { useModels } from "@/api/models"
import { formatModelName } from "@/lib/model-label"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { AgentFormDialog } from "./agent-form-dialog"

const DESCRIPTION = "Configure the agents available in your harness."

/** Two-character monogram derived from the agent name, for the card avatar. */
function monogram(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "A"
}

export function AgentsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: agents, isLoading, isError, error } = useAgents()
  const { data: modelGroups } = useModels()
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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {agents.map((agent) => (
            <Card
              key={agent.id}
              className="group flex flex-col gap-3 overflow-hidden border border-border/60 p-4 transition-colors hover:border-border"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold text-muted-foreground">
                  {monogram(agent.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <h3
                    className="truncate text-sm font-semibold text-foreground"
                    title={agent.name}
                  >
                    {agent.name}
                  </h3>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {agent.description || "No description"}
                  </p>
                </div>
                <div className="-mr-1.5 -mt-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => openEdit(agent)}
                    aria-label="Edit agent"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => setToDelete(agent)}
                    aria-label="Delete agent"
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-3">
                <Badge
                  variant="secondary"
                  className="max-w-full font-normal"
                  title={agent.model ?? "default model"}
                >
                  <span className="truncate">
                    {formatModelName(agent.model, modelGroups)}
                  </span>
                </Badge>
                <Badge variant="outline" className="font-normal">
                  thinking: {agent.thinking}
                </Badge>
                {agent.web_search ? (
                  <Badge variant="outline" className="gap-1 font-normal">
                    <Globe className="h-3 w-3" />
                    web
                  </Badge>
                ) : null}
                {agent.browser_qa ? (
                  <Badge variant="outline" className="gap-1 font-normal">
                    <Browser className="h-3 w-3" />
                    browser
                  </Badge>
                ) : null}
                {agent.include_skills ? (
                  <Badge variant="outline" className="font-normal">
                    skills
                  </Badge>
                ) : null}
                <Badge variant="outline" className="font-normal">
                  {agent.tool_ids.length} tools
                </Badge>
              </div>
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
