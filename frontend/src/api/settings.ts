import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api } from "./client"
import { modelKeys } from "./models"
import type {
  CompactionDefaults,
  CompactionDefaultsInput,
  DefaultAgentsInput,
  DefaultAgentsSettings,
  MemorySettings,
  MemorySettingsInput,
  MediaSettings,
  MediaSettingsInput,
  MemoryTestResult,
  OpenRouterSettings,
  OpenRouterSettingsInput,
  OpenRouterTestResult,
  WebSearchSettings,
  WebSearchSettingsInput,
} from "./types"

export const settingsApi = {
  getOpenRouter: (signal?: AbortSignal) =>
    api.get<OpenRouterSettings>("/settings/openrouter", signal),
  setOpenRouter: (input: OpenRouterSettingsInput) =>
    api.put<OpenRouterSettings>("/settings/openrouter", input),
  clearOpenRouter: () => api.delete<void>("/settings/openrouter"),
  testOpenRouter: (input: OpenRouterSettingsInput) =>
    api.post<OpenRouterTestResult>("/settings/openrouter/test", input),
  getWebSearch: (signal?: AbortSignal) =>
    api.get<WebSearchSettings>("/settings/web-search", signal),
  setWebSearch: (input: WebSearchSettingsInput) =>
    api.put<WebSearchSettings>("/settings/web-search", input),
  getMemory: (signal?: AbortSignal) =>
    api.get<MemorySettings>("/settings/memory", signal),
  setMemory: (input: MemorySettingsInput) =>
    api.put<MemorySettings>("/settings/memory", input),
  testMemory: (input: MemorySettingsInput) =>
    api.post<MemoryTestResult>("/settings/memory/test", input),
  getDefaultAgents: (signal?: AbortSignal) =>
    api.get<DefaultAgentsSettings>("/settings/default-agents", signal),
  setDefaultAgents: (input: DefaultAgentsInput) =>
    api.put<DefaultAgentsSettings>("/settings/default-agents", input),
  getMedia: (signal?: AbortSignal) =>
    api.get<MediaSettings>("/settings/media", signal),
  setMedia: (input: MediaSettingsInput) =>
    api.put<MediaSettings>("/settings/media", input),
  getCompaction: (signal?: AbortSignal) =>
    api.get<CompactionDefaults>("/settings/compaction", signal),
  setCompaction: (input: CompactionDefaultsInput) =>
    api.put<CompactionDefaults>("/settings/compaction", input),
}

export const settingsKeys = {
  openrouter: ["settings", "openrouter"] as const,
  webSearch: ["settings", "web-search"] as const,
  memory: ["settings", "memory"] as const,
  media: ["settings", "media"] as const,
  defaultAgents: ["settings", "default-agents"] as const,
  compaction: ["settings", "compaction"] as const,
}

/**
 * The compaction defaults an agent falls back to when it sets no override of its
 * own. Read by the Settings section that edits them *and* by the agent/subagent
 * forms, where they label the value an un-overridden slider resolves to.
 */
export function useCompactionDefaults() {
  return useQuery({
    queryKey: settingsKeys.compaction,
    queryFn: ({ signal }) => settingsApi.getCompaction(signal),
  })
}

export function useSaveCompactionDefaults() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CompactionDefaultsInput) => settingsApi.setCompaction(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.compaction })
    },
  })
}

export function useOpenRouterSettings() {
  return useQuery({
    queryKey: settingsKeys.openrouter,
    queryFn: ({ signal }) => settingsApi.getOpenRouter(signal),
  })
}

// The key drives which cloud models the catalogue can list, so invalidate both
// the settings status and the model catalogue whenever it changes.
function useOpenRouterMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.openrouter })
      qc.invalidateQueries({ queryKey: modelKeys.all })
    },
  })
}

export function useSaveOpenRouterKey() {
  return useOpenRouterMutation((input: OpenRouterSettingsInput) =>
    settingsApi.setOpenRouter(input)
  )
}

export function useClearOpenRouterKey() {
  return useOpenRouterMutation(() => settingsApi.clearOpenRouter())
}

export function useWebSearchSettings() {
  return useQuery({
    queryKey: settingsKeys.webSearch,
    queryFn: ({ signal }) => settingsApi.getWebSearch(signal),
  })
}

export function useSaveWebSearchSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: WebSearchSettingsInput) => settingsApi.setWebSearch(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.webSearch })
    },
  })
}

/**
 * Where images and clips are generated, app-wide.
 *
 * Read by the Settings section that edits it *and* by the Image and Video pages,
 * which follow the configured source rather than offering their own picker — so
 * there is exactly one place the choice is made.
 */
export function useMediaSettings() {
  return useQuery({
    queryKey: settingsKeys.media,
    queryFn: ({ signal }) => settingsApi.getMedia(signal),
  })
}

export function useSaveMediaSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: MediaSettingsInput) => settingsApi.setMedia(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.media })
      // The capability probes, the model lists and every page that reads them all
      // resolve through the source that just changed. Without this the Image page
      // would keep offering the previous source's models until something else
      // happened to refetch.
      qc.invalidateQueries({ queryKey: ["images"] })
      qc.invalidateQueries({ queryKey: ["videos"] })
    },
  })
}

/**
 * App-wide memory configuration. Read by the settings section *and* by the
 * agent/subagent forms, which name the active provider in the memory toggle's
 * helper text — so an agent's editor says where its memory will actually live.
 */
export function useMemorySettings() {
  return useQuery({
    queryKey: settingsKeys.memory,
    queryFn: ({ signal }) => settingsApi.getMemory(signal),
  })
}

export function useSaveMemorySettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: MemorySettingsInput) => settingsApi.setMemory(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.memory })
    },
  })
}

// A connection probe: it reads nothing from the cache and saves nothing, so it
// deliberately invalidates nothing either.
export function useTestMemorySettings() {
  return useMutation({
    mutationFn: (input: MemorySettingsInput) => settingsApi.testMemory(input),
  })
}

export function useDefaultAgents() {
  return useQuery({
    queryKey: settingsKeys.defaultAgents,
    queryFn: ({ signal }) => settingsApi.getDefaultAgents(signal),
  })
}

export function useSaveDefaultAgents() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: DefaultAgentsInput) => settingsApi.setDefaultAgents(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.defaultAgents })
    },
  })
}

