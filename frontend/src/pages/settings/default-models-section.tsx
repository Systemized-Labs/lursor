import { toast } from "sonner"

import { useDefaultModels, useSaveDefaultModels } from "@/api/settings"
import type { ChatMode, DefaultModelsInput } from "@/api/types"
import { MODE_META, MODE_ORDER } from "@/components/chat/chat-modes"
import { ModelPicker } from "@/components/model-picker"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/**
 * Global default model per chat mode (Ask / Edit / Plan). A mode's default,
 * when set, is used for threads run in that mode even over the agent's own
 * model; only an explicit per-thread pick overrides it. Leaving a mode on
 * "Default model" falls back to the agent's model, then the app-wide default.
 */
export function DefaultModelsSection() {
  const { data, isLoading } = useDefaultModels()
  const save = useSaveDefaultModels()

  async function handleChange(mode: ChatMode, value: string) {
    const input: DefaultModelsInput = { [mode]: value }
    try {
      await save.mutateAsync(input)
      toast.success("Saved")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Default model per mode</CardTitle>
        <CardDescription>
          The model each chat mode uses. A mode&apos;s default takes precedence
          over the agent&apos;s own model; only a per-thread pick overrides it.
          Leave a mode on &quot;Default model&quot; to fall back to the
          agent&apos;s model, then the app-wide default
          {data?.fallback ? ` (${data.fallback})` : ""}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {MODE_ORDER.map((mode) => {
          const meta = MODE_META[mode]
          const Icon = meta.Icon
          return (
            <div
              key={mode}
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {meta.label}
                  </div>
                  <div className="text-xs text-muted-foreground">{meta.hint}</div>
                </div>
              </div>
              <div className="w-full sm:w-72">
                <ModelPicker
                  value={data?.[mode] ?? ""}
                  onChange={(value) => handleChange(mode, value)}
                />
              </div>
            </div>
          )
        })}
        {isLoading && (
          <div className="text-xs text-muted-foreground">Loading…</div>
        )}
      </CardContent>
    </Card>
  )
}
