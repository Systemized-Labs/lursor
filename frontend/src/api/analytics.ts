import { useQuery } from "@tanstack/react-query"

import { api } from "./client"

/** Aggregated token counts + cost shared by every analytics rollup. */
export interface UsageTotals {
  records: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  requests: number
  cost_usd: number
}

export interface ModelUsage extends UsageTotals {
  model: string
}

export interface WorkspaceUsage extends UsageTotals {
  workspace_id: string
  workspace_name: string
}

export interface TimeseriesPoint extends UsageTotals {
  date: string
}

/** Optional filters accepted by every analytics endpoint. */
export interface AnalyticsFilters {
  workspaceId?: string
  model?: string
  agentId?: string
  kind?: string
  start?: string
  end?: string
}

function buildQuery(filters: AnalyticsFilters): string {
  const params = new URLSearchParams()
  if (filters.workspaceId) params.set("workspace_id", filters.workspaceId)
  if (filters.model) params.set("model", filters.model)
  if (filters.agentId) params.set("agent_id", filters.agentId)
  if (filters.kind) params.set("kind", filters.kind)
  if (filters.start) params.set("start", filters.start)
  if (filters.end) params.set("end", filters.end)
  const qs = params.toString()
  return qs ? `?${qs}` : ""
}

export const analyticsApi = {
  summary: (filters: AnalyticsFilters, signal?: AbortSignal) =>
    api.get<UsageTotals>(`/analytics/summary${buildQuery(filters)}`, signal),
  byModel: (filters: AnalyticsFilters, signal?: AbortSignal) =>
    api.get<ModelUsage[]>(`/analytics/by-model${buildQuery(filters)}`, signal),
  byWorkspace: (filters: AnalyticsFilters, signal?: AbortSignal) =>
    api.get<WorkspaceUsage[]>(
      `/analytics/by-workspace${buildQuery(filters)}`,
      signal,
    ),
  timeseries: (filters: AnalyticsFilters, signal?: AbortSignal) =>
    api.get<TimeseriesPoint[]>(
      `/analytics/timeseries${buildQuery(filters)}`,
      signal,
    ),
}

export const analyticsKeys = {
  all: ["analytics"] as const,
  summary: (f: AnalyticsFilters) => ["analytics", "summary", f] as const,
  byModel: (f: AnalyticsFilters) => ["analytics", "by-model", f] as const,
  byWorkspace: (f: AnalyticsFilters) => ["analytics", "by-workspace", f] as const,
  timeseries: (f: AnalyticsFilters) => ["analytics", "timeseries", f] as const,
}

export function useAnalyticsSummary(filters: AnalyticsFilters = {}) {
  return useQuery({
    queryKey: analyticsKeys.summary(filters),
    queryFn: ({ signal }) => analyticsApi.summary(filters, signal),
  })
}

export function useUsageByModel(filters: AnalyticsFilters = {}) {
  return useQuery({
    queryKey: analyticsKeys.byModel(filters),
    queryFn: ({ signal }) => analyticsApi.byModel(filters, signal),
  })
}

export function useUsageByWorkspace(filters: AnalyticsFilters = {}) {
  return useQuery({
    queryKey: analyticsKeys.byWorkspace(filters),
    queryFn: ({ signal }) => analyticsApi.byWorkspace(filters, signal),
  })
}

export function useUsageTimeseries(filters: AnalyticsFilters = {}) {
  return useQuery({
    queryKey: analyticsKeys.timeseries(filters),
    queryFn: ({ signal }) => analyticsApi.timeseries(filters, signal),
  })
}
