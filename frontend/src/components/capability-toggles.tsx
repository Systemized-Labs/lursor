import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

/**
 * The Capabilities block shared by the agent and subagent forms.
 *
 * It is one column, not two. In a two-column grid the hints pushed their row
 * taller than its neighbour, leaving a ragged gap under every short label. A
 * single divided list keeps every label on the same left edge and every switch on
 * the same right edge.
 *
 * Every row is exactly two lines — label, then one sentence saying what the
 * toggle actually buys — so all rows are the same height. The sentence is clipped
 * rather than wrapped for the same reason, with the full text on hover; hints are
 * written short enough that clipping is a backstop, not the normal case.
 */

export interface CapabilityField<K extends string> {
  key: K
  label: string
  /** One sentence, under the label. Keep it under ~60 characters so it fits. */
  hint: string
}

interface CapabilityTogglesProps<K extends string> {
  /** Prefixes the switch ids so agent and subagent forms can't collide. */
  idPrefix: string
  fields: CapabilityField<K>[]
  values: Record<K, boolean>
  onChange: (key: K, value: boolean) => void
  /**
   * Hints resolved at render time (which memory bank, which video model), keyed
   * by field. More specific than the static hint, so one replaces it once it
   * lands — the row still shows exactly one line either way.
   */
  liveHints?: Partial<Record<K, string | null>>
}

export function CapabilityToggles<K extends string>({
  idPrefix,
  fields,
  values,
  onChange,
  liveHints,
}: CapabilityTogglesProps<K>) {
  return (
    <div className="grid gap-2 rounded-md border p-4">
      <span className="text-sm font-medium text-foreground">Capabilities</span>
      <div className="divide-y divide-border/60">
        {fields.map((field) => {
          const id = `${idPrefix}-${field.key}`
          const hint = liveHints?.[field.key] || field.hint
          return (
            <div
              key={field.key}
              className="flex items-center justify-between gap-6 py-2.5 first:pt-0 last:pb-0"
            >
              <div className="grid min-w-0 gap-0.5">
                {/* leading-6 matches the switch's height, so a row lines up the
                    same way whichever hint it ends up showing. */}
                <Label htmlFor={id} className="cursor-pointer truncate leading-6">
                  {field.label}
                </Label>
                <p className="truncate text-xs text-muted-foreground" title={hint}>
                  {hint}
                </p>
              </div>
              <Switch
                id={id}
                checked={values[field.key]}
                onCheckedChange={(checked) => onChange(field.key, checked)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
