import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api } from "./client"
import { modelKeys } from "./models"
import type {
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
}

export const settingsKeys = {
  openrouter: ["settings", "openrouter"] as const,
  webSearch: ["settings", "web-search"] as const,
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
