import { Button } from "@/components/ui/button"
import { CompactionSlider } from "@/components/compaction-slider"
import { useCompactionDefaults } from "@/api/settings"

/**
 * The two per-row context-compaction overrides, shared by the agent and subagent
 * forms so both spell the knobs the same way.
 *
 * Both are stored as fractions (0–1] and edited here as whole percentages on a
 * slider, which keeps every reachable value valid — there is no half-typed state
 * to police, and the number governing the agent is always on screen.
 *
 * An empty stored value means "no override — follow the app-wide default" (set on
 * the Settings page), so the slider sits at that default until it is moved, with a
 * tick marking where it is. Moving it creates an override; **Reset** goes back to
 * following the default, wherever the default later moves to.
 */

/** A parsed percentage field: a fraction, `null` for "use the default", or invalid. */
export type ParsedPercent =
  | { ok: true; value: number | null }
  | { ok: false; error: string }

/** Turn a stored fraction into the whole-percent text the sliders carry. */
export function fractionToPercentText(value: number | null | undefined): string {
  if (value === null || value === undefined) return ""
  return String(Math.round(value * 100))
}

/**
 * Turn a percent field's text back into a fraction for the API.
 *
 * Blank is `null` (clear the override). Anything else must be a number in 1–100.
 * The sliders can only produce values in range, so this is a backstop for what
 * arrives from the API — it still runs on save rather than trusting the widget.
 */
export function parsePercentText(text: string, label: string): ParsedPercent {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, value: null }
  const percent = Number(trimmed)
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    return { ok: false, error: `${label} must be a percentage between 1 and 100` }
  }
  // Fractions are what the backend stores; round so 70 doesn't land on 0.7000000001.
  return { ok: true, value: Math.round(percent * 100) / 10000 }
}

interface CompactionFieldsProps {
  /** Prefixes the input ids so agent and subagent forms can't collide. */
  idPrefix: string
  /** Raw percent text; "" means the field is unset (app default applies). */
  threshold: string
  ratio: string
  onChange: (field: "threshold" | "ratio", value: string) => void
}

export function CompactionFields({
  idPrefix,
  threshold,
  ratio,
  onChange,
}: CompactionFieldsProps) {
  const defaults = useCompactionDefaults()

  /** One knob: shows the app default until this row overrides it. */
  function knob(
    field: "threshold" | "ratio",
    value: string,
    appDefault: number | undefined,
    props: { label: string; unit: string; help: string }
  ) {
    // Any stored text is an override — including one that matches the default,
    // since that is what gets saved. Empty means the row follows the default.
    const overriding = value.trim() !== ""
    const defaultPercent =
      appDefault === undefined ? null : Math.round(appDefault * 100)
    // With no override and no default yet (the fetch is in flight, or failed),
    // there is no honest position for the thumb — the slider parks itself.
    const percent = overriding ? Number(value) : defaultPercent
    return (
      <CompactionSlider
        id={`${idPrefix}-compaction-${field}`}
        label={props.label}
        unit={props.unit}
        percent={Number.isFinite(percent) ? percent : null}
        onChange={(next) => onChange(field, String(next))}
        markPercent={defaultPercent}
        markLabel="default"
        help={props.help}
        hint={
          defaultPercent === null
            ? undefined
            : overriding
              ? `Overriding the app default (${defaultPercent}%).`
              : `Following the app default (${defaultPercent}%).`
        }
        action={
          overriding ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => onChange(field, "")}
            >
              Reset
            </Button>
          ) : null
        }
      />
    )
  }

  return (
    <div className="grid gap-4 rounded-md border p-4">
      <div className="grid gap-0.5">
        <span className="text-sm font-medium text-foreground">
          Context compaction
        </span>
        <p className="text-xs text-muted-foreground">
          Long runs summarize their own history to free up context. Both sliders
          start at the app-wide default — move one to override it for this agent.
        </p>
        {defaults.isError ? (
          <p className="text-xs text-muted-foreground">
            Couldn't read the app-wide defaults from the backend, so the sliders
            below stay parked until one is set here.
          </p>
        ) : null}
      </div>

      {knob("threshold", threshold, defaults.data?.threshold, {
        label: "Compact at",
        unit: "full",
        help: "How much of the context window fills up before the history is summarized.",
      })}

      {knob("ratio", ratio, defaults.data?.ratio, {
        label: "Compact",
        unit: "of history",
        help: "How much goes into the summary. Below 100% the newest turns are kept word-for-word behind it.",
      })}
    </div>
  )
}
