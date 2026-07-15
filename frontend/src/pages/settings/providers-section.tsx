import { ProvidersPage } from "@/pages/providers/providers-page"
import { OpenRouterSection } from "./openrouter-section"
import { WebSearchSection } from "./web-search-section"

export const PROVIDER_TABS = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "custom", label: "Custom" },
  { value: "web-search", label: "Web search" },
] as const

export type ProviderTab = (typeof PROVIDER_TABS)[number]["value"]

export function isProviderTab(value: string): value is ProviderTab {
  return PROVIDER_TABS.some((t) => t.value === value)
}

/**
 * The body of the Providers tab — one model source at a time. Which one is
 * chosen by the segmented control the SettingsPage renders inline on the tab
 * row (so this section keeps the full page width for content). LAIOS graduated
 * to its own top-level destination and lives in the sidebar, not here.
 */
export function ProvidersSection({ value }: { value: ProviderTab }) {
  if (value === "custom") return <ProvidersPage embedded />
  if (value === "web-search") return <WebSearchSection />
  return <OpenRouterSection />
}
