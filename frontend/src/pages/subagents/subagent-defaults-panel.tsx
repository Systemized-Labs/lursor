import { ArrowCounterClockwise, PencilSimple } from "@phosphor-icons/react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { BuiltinSubagent } from "@/api/types"
import { useOverrideBuiltin, useResetBuiltin } from "@/api/subagents"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardDescription,
  CardFooter,
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
} from "@/components/ui/responsive-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ModelPicker } from "@/components/model-picker"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

/** Next `disabled_builtins` list after toggling one built-in on/off. */
export function nextDisabledBuiltins(
  builtins: BuiltinSubagent[],
  name: string,
  enabled: boolean
): string[] {
  const disabled = builtins.filter((b) => !b.enabled).map((b) => b.name)
  return enabled ? disabled.filter((n) => n !== name) : [...disabled, name]
}

export function BuiltinCard({
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
    <Card className={cn("flex flex-col", !builtin.enabled && "opacity-60")}>
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="min-w-0 flex-1 break-words">
            {builtin.name}
          </CardTitle>
          <Switch
            checked={builtin.enabled}
            onCheckedChange={onToggle}
            className="mt-0.5 shrink-0"
            aria-label={`Enable ${builtin.name}`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="whitespace-nowrap">
            Built-in
          </Badge>
          {overridden && (
            <Badge variant="secondary" className="whitespace-nowrap">
              Overridden
            </Badge>
          )}
        </div>
        <CardDescription className="line-clamp-2">{description}</CardDescription>
      </CardHeader>
      <CardFooter className="mt-auto gap-1">
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
      </CardFooter>
    </Card>
  )
}

export function BuiltinOverrideDialog({
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
