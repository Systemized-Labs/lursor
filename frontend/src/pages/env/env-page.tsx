import { Eye, Pencil, Plus, Trash } from "@phosphor-icons/react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { useDeleteEnvVar, useEnvVars, useResolvedEnv } from "@/api/env-vars"
import { useSkills } from "@/api/skills"
import type { EnvVar } from "@/api/types"
import { useWorkspaces } from "@/api/workspaces"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { EnvVarFormDialog } from "./env-var-form-dialog"

const DESCRIPTION =
  "Credentials and config injected into agent runs — assigned to skills, workspaces, or everywhere."

/** Assignment summary for one variable, in precedence order. */
function assignmentBadges(
  envVar: EnvVar,
  workspaceNames: Map<string, string>,
  skillNames: Map<string, string>
): string[] {
  const out: string[] = []
  if (envVar.is_global) out.push("Global")
  for (const id of envVar.workspace_ids) {
    out.push(workspaceNames.get(id) ?? "Unknown workspace")
  }
  for (const id of envVar.skill_ids) {
    out.push(`Skill: ${skillNames.get(id) ?? "unknown"}`)
  }
  return out
}

export function EnvPage({ embedded = false }: { embedded?: boolean } = {}) {
  const envVarsQuery = useEnvVars()
  const workspacesQuery = useWorkspaces()
  const skillsQuery = useSkills()
  const deleteVar = useDeleteEnvVar()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<EnvVar | undefined>(undefined)
  const [toDelete, setToDelete] = useState<EnvVar | undefined>(undefined)
  const [previewWorkspace, setPreviewWorkspace] = useState<string>("")

  const workspaces = useMemo(
    () => workspacesQuery.data ?? [],
    [workspacesQuery.data]
  )
  const workspaceNames = useMemo(
    () => new Map(workspaces.map((ws) => [ws.id, ws.name])),
    [workspaces]
  )
  const skillNames = useMemo(
    () => new Map((skillsQuery.data ?? []).map((s) => [s.id, s.name])),
    [skillsQuery.data]
  )
  const resolved = useResolvedEnv(previewWorkspace || undefined)

  async function confirmDelete() {
    if (!toDelete) return
    try {
      await deleteVar.mutateAsync(toDelete.id)
      toast.success(`${toDelete.key} deleted`)
      setToDelete(undefined)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete variable")
    }
  }

  const action = (
    <Button
      onClick={() => {
        setEditing(undefined)
        setFormOpen(true)
      }}
    >
      <Plus className="h-4 w-4" />
      New variable
    </Button>
  )

  const vars = envVarsQuery.data ?? []

  return (
    <div className="space-y-6">
      {embedded ? (
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">{DESCRIPTION}</p>
          {action}
        </div>
      ) : (
        <PageHeader
          title="Environment"
          description={DESCRIPTION}
          actions={action}
        />
      )}

      {envVarsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading variables…</p>
      ) : envVarsQuery.isError ? (
        <p className="text-sm text-destructive">
          {envVarsQuery.error instanceof Error
            ? envVarsQuery.error.message
            : "Failed to load variables"}
        </p>
      ) : vars.length === 0 ? (
        <EmptyState
          title="No variables yet"
          description="Add a variable, attach it to the skills that need it, and agents get it in their shell without ever seeing the value in their context."
          action={action}
        />
      ) : (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Applies to</th>
                <th className="px-3 py-2 font-medium">Value</th>
                <th className="w-20 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {vars.map((envVar) => {
                const badges = assignmentBadges(envVar, workspaceNames, skillNames)
                return (
                  <tr key={envVar.id} className="border-t">
                    <td className="px-3 py-2 align-top">
                      <p className="font-mono text-xs text-foreground">{envVar.key}</p>
                      {envVar.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {envVar.description}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {badges.length === 0 ? (
                        <span className="text-xs text-muted-foreground">
                          Unassigned
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {badges.map((label) => (
                            <Badge
                              key={label}
                              variant="secondary"
                              className="text-[10px]"
                            >
                              {label}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {envVar.is_secret ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {envVar.has_value ? "••••••••" : "Not set"}
                        </span>
                      ) : (
                        <span className="font-mono text-xs text-foreground">
                          {envVar.value || "Not set"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Edit variable"
                          onClick={() => {
                            setEditing(envVar)
                            setFormOpen(true)
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Delete variable"
                          onClick={() => setToDelete(envVar)}
                        >
                          <Trash className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Eye className="h-4 w-4" />
                Effective environment
              </CardTitle>
              <CardDescription>
                Exactly what a run in one workspace receives, and which layer each
                value came from. Values are never shown.
              </CardDescription>
            </div>
            <Select value={previewWorkspace} onValueChange={setPreviewWorkspace}>
              <SelectTrigger className="w-full sm:w-56">
                <SelectValue placeholder="Pick a workspace" />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((ws) => (
                  <SelectItem key={ws.id} value={ws.id}>
                    {ws.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {!previewWorkspace ? (
            <p className="text-sm text-muted-foreground">
              Pick a workspace to see its resolved environment.
            </p>
          ) : resolved.isLoading ? (
            <p className="text-sm text-muted-foreground">Resolving…</p>
          ) : (resolved.data?.entries.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing applies here yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {resolved.data?.entries.map((entry) => (
                <li
                  key={entry.key}
                  className="flex flex-wrap items-center gap-2 text-xs"
                >
                  <span className="font-mono text-foreground">{entry.key}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {entry.source}
                  </Badge>
                  {entry.overridden.length > 1 && (
                    <span className="text-muted-foreground">
                      overrides {entry.overridden.slice(0, -1).join(", ")}
                    </span>
                  )}
                  {!entry.has_value && (
                    <span className="text-muted-foreground">(no value set)</span>
                  )}
                  {entry.description && (
                    <span className="text-muted-foreground">
                      — {entry.description}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Values are stored in Lursor's local database in plain text, like your other
        saved keys. Anyone with access to this machine's data directory can read
        them.
      </p>

      <EnvVarFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        envVar={editing}
      />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(open) => !open && setToDelete(undefined)}
        title="Delete variable"
        description={
          toDelete
            ? `${toDelete.key} will stop being injected into any run that used it.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        loading={deleteVar.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
