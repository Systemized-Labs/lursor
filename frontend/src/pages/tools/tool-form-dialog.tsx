import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { Tool, ToolInput, ToolKind } from "@/api/types"
import { useCreateTool, useUpdateTool } from "@/api/tools"
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

const TOOL_KINDS: ToolKind[] = ["builtin", "mcp", "http"]

interface FormState {
  name: string
  description: string
  kind: ToolKind
  configText: string
}

const EMPTY: FormState = {
  name: "",
  description: "",
  kind: "builtin",
  configText: "{}",
}

interface ToolFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tool?: Tool
}

export function ToolFormDialog({
  open,
  onOpenChange,
  tool,
}: ToolFormDialogProps) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const createTool = useCreateTool()
  const updateTool = useUpdateTool()
  const isEdit = Boolean(tool)
  const isSaving = createTool.isPending || updateTool.isPending

  useEffect(() => {
    if (open) {
      setForm(
        tool
          ? {
              name: tool.name,
              description: tool.description,
              kind: tool.kind,
              configText: JSON.stringify(tool.config ?? {}, null, 2),
            }
          : EMPTY
      )
    }
  }, [open, tool])

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("Name is required")
      return
    }

    let config: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(form.configText || "{}")
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Config must be a JSON object")
      }
      config = parsed as Record<string, unknown>
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Config is not valid JSON")
      return
    }

    const input: ToolInput = {
      name: form.name.trim(),
      description: form.description.trim(),
      kind: form.kind,
      config,
    }

    try {
      if (tool) {
        await updateTool.mutateAsync({ id: tool.id, input })
        toast.success("Tool updated")
      } else {
        await createTool.mutateAsync(input)
        toast.success("Tool created")
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save tool")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit tool" : "New tool"}</DialogTitle>
          <DialogDescription>
            Tools give agents capabilities: builtin, MCP servers, or HTTP APIs.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="tool-name">Name</Label>
            <Input
              id="tool-name"
              value={form.name}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, name: e.target.value }))
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tool-description">Description</Label>
            <Input
              id="tool-description"
              value={form.description}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, description: e.target.value }))
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tool-kind">Kind</Label>
            <Select
              value={form.kind}
              onValueChange={(value) =>
                setForm((prev) => ({ ...prev, kind: value as ToolKind }))
              }
            >
              <SelectTrigger id="tool-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TOOL_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {kind}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tool-config">Config (JSON)</Label>
            <Textarea
              id="tool-config"
              value={form.configText}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, configText: e.target.value }))
              }
              className="min-h-[160px] font-mono text-xs"
              spellCheck={false}
            />
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
            {isEdit ? "Save changes" : "Create tool"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
