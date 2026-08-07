import { toast } from "sonner"

import { useAssistantSettings, useSaveAssistantSettings } from "@/api/settings"
import { ModelPicker } from "@/components/model-picker"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { MOD } from "@/lib/shortcuts"

/**
 * The Assistant's model — the only thing about it the user configures.
 *
 * Everything else (its prompt, its tools, its feature flags) is owned by the
 * app, because the Assistant can delete workspaces and retarget other agents
 * and those rules should not be one careless prompt edit away from gone. So it
 * gets a settings row rather than an entry in the agent editor.
 */
export function AssistantSection() {
  const { data, isLoading } = useAssistantSettings()
  const save = useSaveAssistantSettings()

  const model = data?.model ?? ""
  const inherited = data?.source === "default"

  const onChange = (next: string) => {
    save.mutate(
      { model: next },
      {
        onError: (error) =>
          toast.error(error instanceof Error ? error.message : "Could not save the model."),
      }
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Assistant</CardTitle>
        <CardDescription>
          The Assistant runs Lursor itself — workspaces, agents, schedules and
          settings. Open it from anywhere with{" "}
          <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-xs text-muted-foreground">
            {MOD}⇧A
          </kbd>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Model</p>
            <p className="text-xs text-muted-foreground">
              {inherited
                ? `Using the shipped default (${data?.default_model ?? ""}).`
                : "Overridden for this install."}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ModelPicker value={model} onChange={onChange} />
            {!inherited ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={save.isPending || isLoading}
                onClick={() => onChange("")}
              >
                Reset
              </Button>
            ) : null}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Its destructive actions always stop and ask before they run, whatever
          model it is on.
        </p>
      </CardContent>
    </Card>
  )
}
