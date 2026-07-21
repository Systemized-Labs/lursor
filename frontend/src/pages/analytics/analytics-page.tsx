import { useMemo, useState } from "react"
import { ArrowsClockwise } from "@phosphor-icons/react"
import { useQueryClient } from "@tanstack/react-query"

import {
  type AnalyticsFilters,
  analyticsKeys,
  type ModelUsage,
  useAnalyticsSummary,
  useUsageByModel,
  useUsageTimeseries,
} from "@/api/analytics"
import { useWorkspaces } from "@/api/workspaces"
import { useModels } from "@/api/models"
import { formatModelName } from "@/lib/model-label"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// Date-range presets → number of days back (0 = all time). Drives the hero,
// stat strip, and model mix. The activity heatmap is always a fixed year.
const RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "0", label: "All time" },
] as const

/** Compact token counts: 1234 → "1.2K", 3.4e6 → "3.4M", 1.35e9 → "1.35B". */
function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Cost in USD; sub-cent values keep more precision so they don't read as $0. */
function formatCost(usd: number): string {
  if (usd === 0) return "$0.00"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

/** Local YYYY-MM-DD for a date — matches the server's per-day buckets. */
function toISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** Human date for the activity footer: "Jul 16, 2026". */
function formatLongDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number)
  if (!y) return iso
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

export function AnalyticsPage() {
  const [workspaceId, setWorkspaceId] = useState<string>("all")
  const [range, setRange] = useState<string>("30")

  const queryClient = useQueryClient()
  const workspacesQuery = useWorkspaces()
  const workspaces = workspacesQuery.data ?? []

  const scopedWorkspace = workspaceId === "all" ? undefined : workspaceId

  // Range-scoped filters power the hero number, stat strip, and model mix.
  const filters = useMemo<AnalyticsFilters>(() => {
    const days = Number(range)
    const start =
      days > 0
        ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
        : undefined
    return { workspaceId: scopedWorkspace, start }
  }, [scopedWorkspace, range])

  // The activity heatmap always covers a fixed year, independent of the range.
  const yearFilters = useMemo<AnalyticsFilters>(() => {
    const start = new Date(Date.now() - 364 * 24 * 60 * 60 * 1000).toISOString()
    return { workspaceId: scopedWorkspace, start }
  }, [scopedWorkspace])

  const summaryQuery = useAnalyticsSummary(filters)
  const byModelQuery = useUsageByModel(filters)
  const timeseriesQuery = useUsageTimeseries(filters)
  const yearQuery = useUsageTimeseries(yearFilters)
  const { data: modelGroups } = useModels()

  const summary = summaryQuery.data
  const timeseries = timeseriesQuery.data ?? []
  const yearPoints = yearQuery.data ?? []

  const modelRows = useMemo(
    () =>
      (byModelQuery.data ?? []).map((m) => ({
        ...m,
        name: formatModelName(m.model, modelGroups),
      })),
    [byModelQuery.data, modelGroups],
  )

  const totalTokens = summary?.total_tokens ?? 0
  const activeDays = timeseries.filter((p) => p.total_tokens > 0).length
  const peakDay = timeseries.reduce((max, p) => Math.max(max, p.total_tokens), 0)
  const hasData = (summary?.records ?? 0) > 0

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: analyticsKeys.all })
  }

  const isRefreshing =
    summaryQuery.isFetching ||
    byModelQuery.isFetching ||
    timeseriesQuery.isFetching ||
    yearQuery.isFetching

  return (
    <div className="space-y-10">
      <PageHeader
        title="Usage"
        actions={
          <div className="flex items-center gap-2">
            <Select value={workspaceId} onValueChange={setWorkspaceId}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder="All workspaces" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All workspaces</SelectItem>
                {workspaces.map((ws) => (
                  <SelectItem key={ws.id} value={ws.id}>
                    {ws.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={range} onValueChange={setRange}>
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon"
              onClick={refresh}
              aria-label="Refresh"
              className="text-muted-foreground"
            >
              <ArrowsClockwise className={cn(isRefreshing && "animate-spin")} />
            </Button>
          </div>
        }
      />

      {!hasData ? (
        <Card>
          <CardContent className="py-20 text-center text-sm text-muted-foreground">
            {summaryQuery.isLoading
              ? "Loading usage…"
              : "No usage recorded yet for this filter. Run a chat or goal to start tracking tokens."}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Hero — the headline total */}
          <div className="pt-4 text-center">
            <p className="text-sm text-muted-foreground">Total tokens</p>
            <p className="mt-2 text-7xl font-semibold tracking-tight tabular-nums text-foreground sm:text-8xl">
              {formatTokens(totalTokens)}
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              Processed across all models · {formatCost(summary?.cost_usd ?? 0)}
            </p>
          </div>

          {/* Stat strip */}
          <Card>
            <CardContent className="grid grid-cols-2 gap-y-6 p-6 sm:grid-cols-4 sm:divide-x sm:divide-border sm:gap-y-0">
              <Stat label="Requests" value={formatTokens(summary?.requests ?? 0)} />
              <Stat label="Turns" value={formatTokens(summary?.records ?? 0)} />
              <Stat label="Active days" value={String(activeDays)} />
              <Stat label="Peak day" value={formatTokens(peakDay)} />
            </CardContent>
          </Card>

          {/* Token activity heatmap */}
          <Card>
            <CardContent className="p-6">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold text-foreground">
                  Token activity
                </h2>
                <span className="text-sm text-muted-foreground">Past year</span>
              </div>
              <ActivityHeatmap points={yearPoints} />
            </CardContent>
          </Card>

          {/* Breakdowns */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent className="p-6">
                <h2 className="mb-5 text-base font-semibold text-foreground">
                  Token mix
                </h2>
                <BarList
                  rows={[
                    { name: "Input", value: summary?.input_tokens ?? 0 },
                    { name: "Output", value: summary?.output_tokens ?? 0 },
                    { name: "Cache read", value: summary?.cache_read_tokens ?? 0 },
                    { name: "Cache write", value: summary?.cache_write_tokens ?? 0 },
                  ]}
                />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6">
                <div className="mb-5 flex items-center justify-between">
                  <h2 className="text-base font-semibold text-foreground">
                    Most used models
                  </h2>
                  <span className="text-sm text-muted-foreground">
                    {modelRows.length} model{modelRows.length === 1 ? "" : "s"}
                  </span>
                </div>
                <BarList
                  rows={modelRows.slice(0, 6).map((m) => ({
                    name: m.name,
                    value: m.total_tokens,
                  }))}
                />
              </CardContent>
            </Card>
          </div>

          {/* Full per-model overview */}
          <Card>
            <CardContent className="p-6">
              <h2 className="mb-5 text-base font-semibold text-foreground">
                Overview
              </h2>
              <ModelTable rows={modelRows} totalTokens={totalTokens} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function pct(part: number, whole: number): string {
  if (!whole) return "0%"
  return `${Math.round((part / whole) * 100)}%`
}

/** Ranked per-model breakdown with token splits, share, requests, and cost. */
function ModelTable({
  rows,
  totalTokens,
}: {
  rows: (ModelUsage & { name: string })[]
  totalTokens: number
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No model usage yet.</p>
  }
  const maxTokens = Math.max(...rows.map((r) => r.total_tokens), 1)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th className="pb-2 pr-3 font-medium">Model</th>
            <th className="pb-2 px-3 text-right font-medium">Input</th>
            <th className="pb-2 px-3 text-right font-medium">Output</th>
            <th className="pb-2 px-3 text-right font-medium">Cache</th>
            <th className="pb-2 px-3 text-right font-medium">Requests</th>
            <th className="w-[24%] pb-2 px-3 font-medium">Total</th>
            <th className="pb-2 pl-3 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.model} className="border-b border-border last:border-0">
              <td className="max-w-[220px] truncate py-2.5 pr-3 text-foreground">
                {r.name}
              </td>
              <td className="py-2.5 px-3 text-right tabular-nums text-muted-foreground">
                {formatTokens(r.input_tokens)}
              </td>
              <td className="py-2.5 px-3 text-right tabular-nums text-muted-foreground">
                {formatTokens(r.output_tokens)}
              </td>
              <td className="py-2.5 px-3 text-right tabular-nums text-muted-foreground">
                {formatTokens(r.cache_read_tokens + r.cache_write_tokens)}
              </td>
              <td className="py-2.5 px-3 text-right tabular-nums text-muted-foreground">
                {formatTokens(r.requests)}
              </td>
              <td className="py-2.5 px-3">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(r.total_tokens / maxTokens) * 100}%` }}
                    />
                  </div>
                  <span className="w-14 shrink-0 text-right tabular-nums text-foreground">
                    {formatTokens(r.total_tokens)}
                  </span>
                  <span className="w-9 shrink-0 text-right tabular-nums text-xs text-muted-foreground">
                    {pct(r.total_tokens, totalTokens)}
                  </span>
                </div>
              </td>
              <td className="py-2.5 pl-3 text-right tabular-nums text-foreground">
                {formatCost(r.cost_usd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <p className="text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{label}</p>
    </div>
  )
}

interface BarRow {
  name: string
  value: number
}

/** Labeled horizontal bars, normalised to the largest value in the set. */
function BarList({ rows }: { rows: BarRow[] }) {
  const max = Math.max(...rows.map((r) => r.value), 1)
  if (rows.every((r) => r.value === 0)) {
    return <p className="text-sm text-muted-foreground">No usage in this range.</p>
  }
  return (
    <div className="space-y-4">
      {rows.map((r) => (
        <div key={r.name} className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate text-muted-foreground">{r.name}</span>
            <span className="shrink-0 tabular-nums text-foreground">
              {formatTokens(r.value)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

// Heatmap fill opacity per intensity level (1–4); level 0 renders as an empty
// cell. Colour comes from the theme's blue `--info` token so it tracks the mode.
const HEAT_OPACITY = [0.28, 0.5, 0.72, 1] as const
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

interface Cell {
  date: string
  value: number
  requests: number
}

/** Local month index (0–11) from a YYYY-MM-DD string, without UTC drift. */
function monthOf(iso: string): number {
  const m = Number(iso.split("-")[1])
  return m ? m - 1 : 0
}

/** Bucket a token count into a 0–4 intensity level relative to the busiest day. */
function heatLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0
  const r = value / max
  if (r > 0.66) return 4
  if (r > 0.33) return 3
  if (r > 0.12) return 2
  return 1
}

/**
 * GitHub-style contribution grid: 7 rows (Sun–Sat) × ~53 week columns spanning
 * the past year, aligned so each column starts on a Sunday.
 */
function ActivityHeatmap({
  points,
}: {
  points: { date: string; total_tokens: number; requests: number }[]
}) {
  const { weeks, max, latest } = useMemo(() => {
    const byDate = new Map(points.map((p) => [p.date, p]))
    const end = new Date()
    end.setHours(0, 0, 0, 0)
    const start = new Date(end)
    start.setDate(start.getDate() - 364)
    start.setDate(start.getDate() - start.getDay()) // back to Sunday

    const cols: Cell[][] = []
    const cursor = new Date(start)
    let maxVal = 0
    let latestCell: Cell | null = null
    while (cursor <= end) {
      const week: Cell[] = []
      for (let d = 0; d < 7; d++) {
        const iso = toISODate(cursor)
        const point = byDate.get(iso)
        const value = point?.total_tokens ?? 0
        const cell: Cell = { date: iso, value, requests: point?.requests ?? 0 }
        week.push(cell)
        if (value > maxVal) maxVal = value
        if (cursor <= end && value > 0) latestCell = cell
        cursor.setDate(cursor.getDate() + 1)
      }
      cols.push(week)
    }
    return { weeks: cols, max: maxVal, latest: latestCell }
  }, [points])

  return (
    <TooltipProvider delayDuration={100}>
      <div className="overflow-x-auto">
        {/* The grid is a fixed width (~53 fixed-size columns), so center the
            whole unit — labels, cells, and footer share this width and stay
            aligned; it scrolls left-anchored when the card is narrower. */}
        <div className="mx-auto w-fit">
          {/* Month labels aligned to week columns. */}
          <div className="mb-1.5 flex gap-[3px]">
            {weeks.map((week, i) => {
              const month = monthOf(week[0].date)
              const prevMonth = i > 0 ? monthOf(weeks[i - 1][0].date) : -1
              const show = month !== prevMonth
              return (
                <div
                  key={week[0].date}
                  className="w-[11px] shrink-0 whitespace-nowrap text-xs text-muted-foreground"
                >
                  {show ? MONTHS[month] : ""}
                </div>
              )
            })}
          </div>

          <div className="flex gap-[3px]">
            {weeks.map((week) => (
              <div key={week[0].date} className="flex shrink-0 flex-col gap-[3px]">
                {week.map((cell) => {
                  const level = heatLevel(cell.value, max)
                  return (
                    <Tooltip key={cell.date}>
                      <TooltipTrigger asChild>
                        <div
                          className={cn(
                            "size-[11px] rounded-[2px]",
                            level === 0 && "bg-muted/60",
                          )}
                          style={
                            level > 0
                              ? {
                                  backgroundColor: "var(--info)",
                                  opacity: HEAT_OPACITY[level - 1],
                                }
                              : undefined
                          }
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        {cell.value > 0
                          ? `${formatLongDate(cell.date)} · ${formatTokens(cell.value)} tokens`
                          : `No activity on ${formatLongDate(cell.date)}`}
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            ))}
          </div>

          {/* Footer: latest active day + intensity legend. */}
          <div className="mt-4 flex items-center justify-between gap-4">
            <span className="text-sm text-muted-foreground">
              {latest
                ? `${formatLongDate(latest.date)} · ${formatTokens(latest.value)} tokens · ${formatTokens(latest.requests)} requests`
                : "No activity yet"}
            </span>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>Less</span>
              <div className="size-[11px] rounded-[2px] bg-muted/60" />
              {HEAT_OPACITY.map((opacity) => (
                <div
                  key={opacity}
                  className="size-[11px] rounded-[2px]"
                  style={{ backgroundColor: "var(--info)", opacity }}
                />
              ))}
              <span>More</span>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
