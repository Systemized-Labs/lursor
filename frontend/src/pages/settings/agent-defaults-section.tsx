import { ArrowCounterClockwise } from "@phosphor-icons/react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { useSubagentDefaults, useUpdateSubagentDefaults } from "@/api/subagents"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/** Global deep-agent runtime defaults (currently just subagent delegation depth). */
export function AgentDefaultsSection() {
  const { data, isLoading } = useSubagentDefaults()
  const update = useUpdateSubagentDefaults()
  const depth = data?.max_nesting_depth

  const [value, setValue] = useState("")

  useEffect(() => {
    if (depth) setValue(String(depth.effective))
  }, [depth])

  const parsed = Number(value)
  const valid = Number.isInteger(parsed) && parsed >= 0
  const changed = valid && depth != null && parsed !== depth.effective

  async function save() {
    try {
      await update.mutateAsync({ max_nesting_depth: parsed })
      toast.success("Saved")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save")
    }
  }

  async function reset() {
    try {
      await update.mutateAsync({ clear_max_nesting_depth: true })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reset")
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Max delegation depth</CardTitle>
            <CardDescription>
              How many levels deep subagents may themselves delegate.
            </CardDescription>
          </div>
          {depth?.override != null && <Badge variant="secondary">Overridden</Badge>}
        </div>
      </CardHeader>
      <CardContent className="flex items-end gap-3">
        <div className="grid gap-2">
          <Label htmlFor="max-delegation-depth">
            Depth{depth ? ` (default ${depth.library_default})` : ""}
          </Label>
          <Input
            id="max-delegation-depth"
            type="number"
            min={0}
            value={value}
            disabled={isLoading}
            onChange={(e) => setValue(e.target.value)}
            className="w-24"
          />
        </div>
        <Button onClick={save} disabled={!changed || update.isPending}>
          Save
        </Button>
        {depth?.override != null && (
          <Button variant="ghost" onClick={reset} disabled={update.isPending}>
            <ArrowCounterClockwise className="h-4 w-4" />
            Reset
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
