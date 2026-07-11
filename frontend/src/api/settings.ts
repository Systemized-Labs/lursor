import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api } from "./client"
import { modelKeys } from "./models"
import type {
  OpenRouterSettings,
  OpenRouterSettingsInput,
  OpenRouterTestResult,
} from "./types"

export const settingsApi = {
  getOpenRouter: (signal?: AbortSignal) =>
    api.get<OpenRouterSettings>("/settings/openrouter", signal),
  setOpenRouter: (input: OpenRouterSettingsInput) =>
    api.put<OpenRouterSettings>("/settings/openrouter", input),
  clearOpenRouter: () => api.delete<void>("/settings/openrouter"),
  testOpenRouter: (input: OpenRouterSettingsInput) =>
    api.post<OpenRouterTestResult>("/settings/openrouter/test", input),
}

export const settingsKeys = {
  openrouter: ["settings", "openrouter"] as const,
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
