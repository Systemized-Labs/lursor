import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  useCreateEnvVar,
  useSetEnvVarAssignment,
  useUpdateEnvVar,
} from "@/api/env-vars"
import { useSkills } from "@/api/skills"
import type { EnvVar } from "@/api/types"
import { useWorkspaces } from "@/api/workspaces"
import { MultiSelect } from "@/components/multi-select"
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
import { Switch } from "@/components/ui/switch"

interface EnvVarFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  envVar?: EnvVar
}

/**
 * Create or edit one variable and its assignment.
 *
 * A stored secret is never read back, so the value field starts empty when
 * editing: leaving it alone keeps the existing value, and typing replaces it.
 */
export function EnvVarFormDialog({
  open,
  onOpenChange,
  envVar,
}: EnvVarFormDialogProps) {
  const [key, setKey] = useState("")
  const [value, setValue] = useState("")
  const [description, setDescription] = useState("")
  const [isSecret, setIsSecret] = useState(true)
  const [isGlobal, setIsGlobal] = useState(false)
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([])
  const [skillIds, setSkillIds] = useState<string[]>([])

  const workspacesQuery = useWorkspaces()
  const skillsQuery = useSkills()
  const createVar = useCreateEnvVar()
  const updateVar = useUpdateEnvVar()
  const setAssignment = useSetEnvVarAssignment()
  const isEdit = Boolean(envVar)
  const isSaving = createVar.isPending || updateVar.isPending || setAssignment.isPending

  useEffect(() => {
    if (!open) return
    setKey(envVar?.key ?? "")
    setValue(envVar && !envVar.is_secret ? (envVar.value ?? "") : "")
    setDescription(envVar?.description ?? "")
    setIsSecret(envVar?.is_secret ?? true)
    setIsGlobal(envVar?.is_global ?? false)
    setWorkspaceIds(envVar?.workspace_ids ?? [])
    setSkillIds(envVar?.skill_ids ?? [])
  }, [open, envVar])

  const workspaceOptions = useMemo(
    () =>
      (workspacesQuery.data ?? []).map((ws) => ({
        value: ws.id,
        label: ws.name,
        description: ws.description || undefined,
      })),
    [workspacesQuery.data]
  )

  const skillOptions = useMemo(
    () =>
      (skillsQuery.data ?? []).map((s) => ({
        value: s.id,
        label: s.name,
        description: s.description || undefined,
      })),
    [skillsQuery.data]
  )

  async function handleSubmit() {
    if (!key.trim()) {
      toast.error("Name is required")
      return
    }
    try {
      if (envVar) {
        await updateVar.mutateAsync({
          id: envVar.id,
          input: {
            key: key.trim(),
            description,
            is_secret: isSecret,
            // Omit the value entirely unless the user typed one, so saving other
            // fields never wipes a secret we can't read back.
            ...(value ? { value } : {}),
          },
        })
        await setAssignment.mutateAsync({
          id: envVar.id,
          input: {
            is_global: isGlobal,
            workspace_ids: isGlobal ? [] : workspaceIds,
            skill_ids: skillIds,
          },
        })
        toast.success(`${key.trim()} updated`)
      } else {
        await createVar.mutateAsync({
          key: key.trim(),
          value,
          description,
          is_secret: isSecret,
          is_global: isGlobal,
          workspace_ids: isGlobal ? [] : workspaceIds,
          skill_ids: skillIds,
        })
        toast.success(`${key.trim()} added`)
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save variable")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit variable" : "New variable"}</DialogTitle>
          <DialogDescription>
            Injected into the shell and skill scripts of every run it applies to.
            Precedence runs global → workspace → skill, so a skill's value wins.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="env-key">Name</Label>
            <Input
              id="env-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="STRIPE_SECRET_KEY"
              className="font-mono"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Letters, digits, and underscores; must not start with a digit.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="env-value">Value</Label>
            <Input
              id="env-value"
              type={isSecret ? "password" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                isEdit && isSecret
                  ? envVar?.has_value
                    ? "Stored — type to replace"
                    : "Not set"
                  : ""
              }
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
            />
            {isEdit && isSecret && (
              <p className="text-xs text-muted-foreground">
                Secret values are never sent back to the browser. Leave this blank to
                keep the stored one.
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="env-description">Description</Label>
            <Input
              id="env-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this is for — shown to the agent alongside the name"
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="env-secret" className="text-foreground">
                Secret
              </Label>
              <p className="text-xs text-muted-foreground">
                On: hidden from the UI and redacted from command output. Off: an
                ordinary config value, readable here.
              </p>
            </div>
            <Switch id="env-secret" checked={isSecret} onCheckedChange={setIsSecret} />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="env-global" className="text-foreground">
                Apply globally
              </Label>
              <p className="text-xs text-muted-foreground">
                Every run, in every workspace.
              </p>
            </div>
            <Switch id="env-global" checked={isGlobal} onCheckedChange={setIsGlobal} />
          </div>

          {!isGlobal && (
            <div className="grid gap-2">
              <Label className="text-foreground">Workspaces</Label>
              <MultiSelect
                options={workspaceOptions}
                selected={workspaceIds}
                onChange={setWorkspaceIds}
                emptyText="No workspaces yet."
              />
            </div>
          )}

          <div className="grid gap-2">
            <Label className="text-foreground">Skills</Label>
            <MultiSelect
              options={skillOptions}
              selected={skillIds}
              onChange={setSkillIds}
              emptyText="No skills yet."
            />
            <p className="text-xs text-muted-foreground">
              Applies whenever one of these skills is in scope. That skill's own
              scripts get it too — and no other skill's scripts do.
            </p>
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
            {isEdit ? "Save changes" : "Add variable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
