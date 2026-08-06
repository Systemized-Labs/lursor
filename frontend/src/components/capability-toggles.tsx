import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

/**
 * The Capabilities block shared by the agent and subagent forms.
 *
 * It is one column, not two. Only a couple of these toggles carry a hint, and in
 * a two-column grid those hints pushed their row taller than its neighbour,
 * leaving a ragged gap under every short label. A single divided list keeps every
 * label on the same left edge and every switch on the same right edge, so a hint
 * only ever grows its own row.
 */

export interface CapabilityField<K extends string> {
  key: K
  label: string
  /** Shown under the label. For a toggle whose cost isn't obvious from its name. */
  hint?: string
}

interface CapabilityTogglesProps<K extends string> {
  /** Prefixes the switch ids so agent and subagent forms can't collide. */
  idPrefix: string
  fields: CapabilityField<K>[]
  values: Record<K, boolean>
  onChange: (key: K, value: boolean) => void
  /**
   * Hints resolved at render time (which memory bank, which video model), keyed
   * by field. Rendered after the field's own static hint.
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
          const hints = [field.hint, liveHints?.[field.key]].filter(
            (hint): hint is string => Boolean(hint)
          )
          return (
            <div
              key={field.key}
              className="flex items-start justify-between gap-6 py-2.5 first:pt-0 last:pb-0"
            >
              <div className="grid gap-1">
                {/* leading-6 matches the switch's height, so the label lines up
                    with it whether or not the row has hints under it. */}
                <Label htmlFor={id} className="cursor-pointer leading-6">
                  {field.label}
                </Label>
                {hints.map((hint) => (
                  <p key={hint} className="text-xs leading-snug text-muted-foreground">
                    {hint}
                  </p>
                ))}
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
