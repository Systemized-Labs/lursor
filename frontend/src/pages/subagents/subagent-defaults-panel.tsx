import type { BuiltinSubagent } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
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

/**
 * A pydantic-deep built-in: name, library description, and an on/off switch.
 *
 * Built-ins aren't editable. The way to get one with skills, web search or a
 * pinned model is to switch it off and author your own subagent instead.
 */
export function BuiltinCard({
  builtin,
  onToggle,
}: {
  builtin: BuiltinSubagent
  onToggle: (enabled: boolean) => void
}) {
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
        </div>
        <CardDescription className="line-clamp-2">
          {builtin.default_description}
        </CardDescription>
      </CardHeader>
    </Card>
  )
}
