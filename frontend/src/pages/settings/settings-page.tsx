import { useState } from "react"
import { useSearchParams } from "react-router-dom"

import { PageHeader } from "@/components/page-header"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { GitHubPage } from "@/pages/github/github-page"
import { AgentDefaultsSection } from "./agent-defaults-section"
import { AppearanceSection } from "./appearance-section"
import {
  PROVIDER_TABS,
  ProvidersSection,
  isProviderTab,
  type ProviderTab,
} from "./providers-section"

const TABS = ["general", "appearance", "providers"] as const
type Tab = (typeof TABS)[number]

function isTab(value: string | null): value is Tab {
  return value !== null && (TABS as readonly string[]).includes(value)
}

/**
 * App-level settings. "General" holds the GitHub connection and agent runtime
 * defaults; "Providers" groups every model source (OpenRouter key, custom
 * endpoints, LAIOS), picked via a segmented control that sits inline on the tab
 * row so the section keeps the full page width. The active tab is mirrored to
 * `?tab=` so it survives reloads and is deep-linkable.
 */
export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get("tab")
  const active: Tab = isTab(tabParam) ? tabParam : "general"

  const subParam = searchParams.get("sub")
  const provider: ProviderTab =
    subParam && isProviderTab(subParam) ? subParam : "laios"
  const [providerTab, setProviderTab] = useState<ProviderTab>(provider)

  function handleTabChange(value: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set("tab", value)
        return next
      },
      { replace: true }
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Connect model providers and GitHub to power your harness."
      />

      <Tabs value={active} onValueChange={handleTabChange} className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
            <TabsTrigger value="providers">Providers</TabsTrigger>
          </TabsList>

          {/* Provider sub-selector lives inline here (rather than a second tab
              row) so the Providers body keeps the full width and height. */}
          {active === "providers" && (
            <Tabs
              value={providerTab}
              onValueChange={(v) => setProviderTab(v as ProviderTab)}
            >
              <TabsList>
                {PROVIDER_TABS.map((t) => (
                  <TabsTrigger key={t.value} value={t.value}>
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
        </div>

        <TabsContent value="general" className="space-y-6">
          <GitHubPage embedded />
          <AgentDefaultsSection />
        </TabsContent>
        <TabsContent value="appearance" className="space-y-6">
          <AppearanceSection />
        </TabsContent>
        <TabsContent value="providers">
          <ProvidersSection value={providerTab} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
