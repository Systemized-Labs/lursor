import { ArrowCounterClockwise, PencilSimple } from "@phosphor-icons/react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { BuiltinSubagent } from "@/api/types"
import {
  useOverrideBuiltin,
  useResetBuiltin,
  useSubagentDefaults,
  useUpdateSubagentDefaults,
} from "@/api/subagents"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ModelPicker } from "@/components/model-picker"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

export function SubagentDefaultsPanel() {
  const { data, isLoading, isError, error } = useSubagentDefaults()
  const updateDefaults = useUpdateSubagentDefaults()

  const [editing, setEditing] = useState<BuiltinSubagent | undefined>(undefined)

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }
  if (isError || !data) {
    return (
      <p className="text-sm text-destructive">
        {error instanceof Error ? error.message : "Failed to load defaults"}
      </p>
    )
  }

  const disabledNames = data.builtins.filter((b) => !b.enabled).map((b) => b.name)

  async function toggleEnabled(builtin: BuiltinSubagent, enabled: boolean) {
    const next = enabled
      ? disabledNames.filter((n) => n !== builtin.name)
      : [...disabledNames, builtin.name]
    try {
      await updateDefaults.mutateAsync({ disabled_builtins: next })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update")
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {data.builtins.map((builtin) => (
          <BuiltinCard
            key={builtin.name}
            builtin={builtin}
            onToggle={(enabled) => toggleEnabled(builtin, enabled)}
            onEdit={() => setEditing(builtin)}
          />
        ))}
      </div>

      <BuiltinOverrideDialog
        builtin={editing}
        onOpenChange={(open) => !open && setEditing(undefined)}
      />
    </div>
  )
}

function BuiltinCard({
  builtin,
  onToggle,
  onEdit,
}: {
  builtin: BuiltinSubagent
  onToggle: (enabled: boolean) => void
  onEdit: () => void
}) {
  const resetBuiltin = useResetBuiltin()
  const overridden = builtin.override !== null
  const description = builtin.override?.description || builtin.default_description

  async function handleReset() {
    try {
      await resetBuiltin.mutateAsync(builtin.name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reset")
    }
  }

  return (
    <Card className={builtin.enabled ? "flex flex-col" : "flex flex-col opacity-60"}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <CardTitle className="truncate">{builtin.name}</CardTitle>
            {overridden && <Badge variant="secondary">Overridden</Badge>}
          </div>
          <Switch
            checked={builtin.enabled}
            onCheckedChange={onToggle}
            aria-label={`Enable ${builtin.name}`}
          />
        </div>
        <CardDescription className="line-clamp-2">{description}</CardDescription>
      </CardHeader>
      <CardContent className="mt-auto flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={onEdit}>
          <PencilSimple className="h-4 w-4" />
          {overridden ? "Edit" : "Override"}
        </Button>
        {overridden && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={resetBuiltin.isPending}
          >
            <ArrowCounterClockwise className="h-4 w-4" />
            Reset
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function BuiltinOverrideDialog({
  builtin,
  onOpenChange,
}: {
  builtin: BuiltinSubagent | undefined
  onOpenChange: (open: boolean) => void
}) {
  const overrideBuiltin = useOverrideBuiltin()
  const [description, setDescription] = useState("")
  const [instructions, setInstructions] = useState("")
  const [model, setModel] = useState("")

  useEffect(() => {
    if (!builtin) return
    // Seed from the current override if present, else the library default.
    setDescription(builtin.override?.description ?? builtin.default_description)
    setInstructions(builtin.override?.instructions ?? builtin.default_instructions)
    setModel(builtin.override?.model ?? "")
  }, [builtin])

  async function handleSave() {
    if (!builtin) return
    try {
      await overrideBuiltin.mutateAsync({
        name: builtin.name,
        input: {
          description: description.trim(),
          instructions,
          model: model.trim() ? model.trim() : null,
        },
      })
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save override")
    }
  }

  return (
    <Dialog open={Boolean(builtin)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Override “{builtin?.name}”</DialogTitle>
          <DialogDescription>
            Your version replaces the library default for every agent.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="builtin-description">Description</Label>
            <Input
              id="builtin-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid min-w-0 gap-2">
            <Label htmlFor="builtin-model">Model</Label>
            <ModelPicker value={model} onChange={setModel} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="builtin-instructions">Instructions</Label>
            <Textarea
              id="builtin-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              className="min-h-[240px] font-mono text-xs"
              spellCheck={false}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={overrideBuiltin.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={overrideBuiltin.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
