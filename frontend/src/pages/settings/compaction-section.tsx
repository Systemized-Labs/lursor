import { ArrowCounterClockwise } from "@phosphor-icons/react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import {
  useCompactionDefaults,
  useSaveCompactionDefaults,
} from "@/api/settings"
import { CompactionSlider, clampPercent } from "@/components/compaction-slider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/** Whole percent for a stored fraction, or `null` when it isn't loaded yet. */
function toPercent(fraction: number | undefined): number | null {
  return fraction === undefined ? null : Math.round(fraction * 100)
}

/**
 * App-wide context-compaction defaults: when a run summarizes its own history,
 * and how much of it goes into the summary. Every agent and subagent without an
 * override of its own runs on these, and a save takes effect on the next run
 * without a restart.
 *
 * Saved values sit on top of the backend's environment configuration
 * (`DEFAULT_COMPACTION_THRESHOLD` / `DEFAULT_COMPACTION_RATIO`), so **Reset**
 * clears them and hands the knob back to the environment rather than to a number
 * hardcoded here.
 */
export function CompactionSection() {
  const { data, isError } = useCompactionDefaults()
  const save = useSaveCompactionDefaults()

  // Local draft, staged until Save (as the delegation-depth section does).
  const [threshold, setThreshold] = useState<number | null>(null)
  const [ratio, setRatio] = useState<number | null>(null)

  // Seed once, on first load only: the query refetches on window focus, and
  // re-seeding from every response would throw away a slider the user had just
  // moved but not saved. Reset re-seeds explicitly from its own response instead.
  useEffect(() => {
    if (!data) return
    setThreshold((prev) => prev ?? clampPercent(data.threshold * 100))
    setRatio((prev) => prev ?? clampPercent(data.ratio * 100))
  }, [data])

  const serverThreshold = toPercent(data?.threshold)
  const serverRatio = toPercent(data?.ratio)
  const changed =
    data !== undefined &&
    (threshold !== serverThreshold || ratio !== serverRatio)
  const overridden =
    data?.threshold_source === "database" || data?.ratio_source === "database"

  async function handleSave() {
    if (threshold === null || ratio === null) return
    try {
      await save.mutateAsync({
        threshold: threshold / 100,
        ratio: ratio / 100,
      })
      toast.success("Compaction defaults saved")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save")
    }
  }

  async function handleReset() {
    try {
      // Null clears both saved values; the response carries the environment's own,
      // so the sliders are moved back onto them here (the seeding effect above
      // deliberately only runs for the first load).
      const reverted = await save.mutateAsync({ threshold: null, ratio: null })
      setThreshold(clampPercent(reverted.threshold * 100))
      setRatio(clampPercent(reverted.ratio * 100))
      toast.success("Reverted to the environment defaults")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reset")
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Context compaction</CardTitle>
            <CardDescription>
              When a long run summarizes its own history to free up context, and
              how much of it goes into the summary. Applies to every agent and
              subagent that doesn't set its own.
            </CardDescription>
          </div>
          {overridden && <Badge variant="secondary">Overridden</Badge>}
        </div>
      </CardHeader>

      <CardContent className="grid max-w-xl gap-4">
        {isError ? (
          <p className="text-sm text-muted-foreground">
            Couldn't load the current defaults from the backend.
          </p>
        ) : null}

        <CompactionSlider
          id="compaction-default-threshold"
          label="Compact at"
          unit="full"
          percent={threshold}
          onChange={setThreshold}
          markPercent={toPercent(data?.env_threshold)}
          markLabel="env"
          help="How much of the context window fills up before the history is summarized."
          hint={
            data
              ? data.threshold_source === "database"
                ? `Saved here (the environment sets ${toPercent(data.env_threshold)}%).`
                : "From the backend's environment."
              : undefined
          }
        />

        <CompactionSlider
          id="compaction-default-ratio"
          label="Compact"
          unit="of history"
          percent={ratio}
          onChange={setRatio}
          markPercent={toPercent(data?.env_ratio)}
          markLabel="env"
          help="How much goes into the summary. Below 100% the newest turns are kept word-for-word behind it."
          hint={
            data
              ? data.ratio_source === "database"
                ? `Saved here (the environment sets ${toPercent(data.env_ratio)}%).`
                : "From the backend's environment."
              : undefined
          }
        />
      </CardContent>

      <CardFooter className="gap-3">
        <Button onClick={handleSave} disabled={!changed || save.isPending}>
          Save
        </Button>
        {overridden && (
          <Button variant="ghost" onClick={handleReset} disabled={save.isPending}>
            <ArrowCounterClockwise className="h-4 w-4" />
            Reset
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
