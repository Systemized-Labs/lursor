import { Pencil, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { useDeleteProvider, useProviders } from "@/api/providers"
import type { CustomProvider } from "@/api/types"
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
import { ProviderFormDialog } from "./provider-form-dialog"
import { ProviderHealthBadge } from "./provider-health-badge"

const DESCRIPTION =
  "Connect locally-hosted models (Ollama, LM Studio, vLLM, …) by adding their OpenAI-compatible URLs. Their models appear in the model picker."

export function ProvidersPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: providers, isLoading, isError, error } = useProviders()
  const deleteProvider = useDeleteProvider()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<CustomProvider | undefined>(undefined)
  const [toDelete, setToDelete] = useState<CustomProvider | undefined>(undefined)

  function openCreate() {
    setEditing(undefined)
    setFormOpen(true)
  }

  async function confirmDelete() {
    if (!toDelete) return
    try {
      await deleteProvider.mutateAsync(toDelete.id)
      toast.success("Provider removed")
      setToDelete(undefined)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove provider")
    }
  }

  const action = (
    <Button onClick={openCreate}>
      <Plus className="h-4 w-4" />
      Add provider
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
        <PageHeader title="Providers" description={DESCRIPTION} actions={action} />
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading providers…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load providers"}
        </p>
      ) : !providers || providers.length === 0 ? (
        <EmptyState
          title="No custom providers yet"
          description="Add a local model server URL to use self-hosted models alongside cloud ones."
          action={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Add provider
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {providers.map((provider) => (
            <Card key={provider.id} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="truncate">{provider.name}</CardTitle>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setEditing(provider)
                        setFormOpen(true)
                      }}
                      aria-label="Edit provider"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setToDelete(provider)}
                      aria-label="Remove provider"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <CardDescription className="truncate font-mono text-xs">
                  {provider.base_url}
                </CardDescription>
              </CardHeader>
              <CardContent className="mt-auto space-y-3">
                <ProviderHealthBadge providerId={provider.id} />
                <span className="text-xs text-muted-foreground">
                  {provider.api_key ? "API key set" : "No API key"}
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ProviderFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        provider={editing}
      />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(open) => !open && setToDelete(undefined)}
        title="Remove provider"
        description={
          toDelete
            ? `This will remove "${toDelete.name}". Agents using its models will fall back to the default model.`
            : undefined
        }
        confirmLabel="Remove"
        destructive
        loading={deleteProvider.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
