import { ProvidersPage } from "@/pages/providers/providers-page"
import { MemorySection } from "./memory-section"
import { OpenRouterSection } from "./openrouter-section"
import { WebSearchSection } from "./web-search-section"

export const PROVIDER_TABS = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "custom", label: "Custom" },
  { value: "web-search", label: "Web search" },
  { value: "memory", label: "Memory" },
] as const

export type ProviderTab = (typeof PROVIDER_TABS)[number]["value"]

export function isProviderTab(value: string): value is ProviderTab {
  return PROVIDER_TABS.some((t) => t.value === value)
}

/**
 * The body of the Providers tab — one backend at a time. Which one is chosen by
 * the segmented control the SettingsPage renders inline on the tab row (so this
 * section keeps the full page width for content). "Web search" and "Memory" are
 * not model sources, but they are the same shape of decision — one app-wide
 * backend behind a per-agent toggle — so they live here rather than in General.
 * LAIOS graduated to its own top-level destination and lives in the sidebar.
 */
export function ProvidersSection({ value }: { value: ProviderTab }) {
  if (value === "custom") return <ProvidersPage embedded />
  if (value === "web-search") return <WebSearchSection />
  if (value === "memory") return <MemorySection />
  return <OpenRouterSection />
}
