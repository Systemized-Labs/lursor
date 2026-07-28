import { useEffect, useState } from "react"
import { toast } from "sonner"

import { useCreateEnvVar } from "@/api/env-vars"
import type { EnvVar } from "@/api/types"
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

interface EnvVarCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Hand the new variable back so the caller can select it in the rail. */
  onCreated: (envVar: EnvVar) => void
}

/**
 * Just enough to store the value: a name, the value, and whether it is a secret.
 *
 * Reach is deliberately not here. It used to be — four more controls in the same
 * modal — and it meant deciding where a credential applies before you had one, in
 * a dialog you then had to reopen to change it. The variable lands in the rail's
 * "Not applied" section with its detail pane already open, which is where reach
 * lives now and where it can be changed as often as you like.
 */
export function EnvVarCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: EnvVarCreateDialogProps) {
  const [key, setKey] = useState("")
  const [value, setValue] = useState("")
  const [description, setDescription] = useState("")
  const [isSecret, setIsSecret] = useState(true)
  const createVar = useCreateEnvVar()

  useEffect(() => {
    if (!open) return
    setKey("")
    setValue("")
    setDescription("")
    setIsSecret(true)
  }, [open])

  async function handleSubmit() {
    if (!key.trim()) {
      toast.error("Name is required")
      return
    }
    try {
      const created = await createVar.mutateAsync({
        key: key.trim(),
        value,
        description: description.trim(),
        is_secret: isSecret,
      })
      toast.success(`${created.key} added — pick where it applies`)
      onOpenChange(false)
      onCreated(created)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add variable")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New variable</DialogTitle>
          <DialogDescription>
            It starts out applying to nothing. Choose which runs and skills receive
            it from its detail pane, which opens as soon as this is saved.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="new-env-key">Name</Label>
            <Input
              id="new-env-key"
              autoFocus
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSubmit()
              }}
              placeholder="STRIPE_SECRET_KEY"
              className="font-mono"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Letters, digits and underscores; must not start with a digit.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="new-env-value">Value</Label>
            <Input
              id="new-env-value"
              type={isSecret ? "password" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSubmit()
              }}
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="new-env-description">Description</Label>
            <Input
              id="new-env-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSubmit()
              }}
              placeholder="What this is for — shown to the agent alongside the name"
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="new-env-secret" className="text-foreground">
                Secret
              </Label>
              <p className="text-xs text-muted-foreground">
                On: never shown again, and redacted from command output. Off: an
                ordinary config value, readable in the pane.
              </p>
            </div>
            <Switch
              id="new-env-secret"
              checked={isSecret}
              onCheckedChange={setIsSecret}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createVar.isPending}
          >
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={createVar.isPending}>
            {createVar.isPending ? "Adding…" : "Add variable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
