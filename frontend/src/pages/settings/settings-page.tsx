import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"

import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { GitHubPage } from "@/pages/github/github-page"
import { AgentDefaultsSection } from "./agent-defaults-section"
import { AppearanceSection } from "./appearance-section"
import { CompactionSection } from "./compaction-section"
import { DefaultAgentsSection } from "./default-agents-section"
import { IntegrationsSection } from "./integrations-section"
import {
  PROVIDER_TABS,
  ProvidersSection,
  isProviderTab,
  type ProviderTab,
} from "./providers-section"

const TABS = ["general", "appearance", "providers", "integrations"] as const
type Tab = (typeof TABS)[number]

function isTab(value: string | null): value is Tab {
  return value !== null && (TABS as readonly string[]).includes(value)
}

/**
 * App-level settings. "General" holds the GitHub connection and agent runtime
 * defaults (per-command agents, delegation depth, context compaction);
 * "Providers" groups the model sources (OpenRouter key, custom
 * endpoints), picked via a segmented control that sits inline on the tab row so
 * the section keeps the full page width. "Integrations" pairs Lursor with other
 * agent tools on this machine — detection plus the commands to run, never a
 * write into another tool's directory. LAIOS is its own top-level destination in
 * the sidebar. The active tab is mirrored to `?tab=` so it survives reloads and
 * is deep-linkable.
 */
export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get("tab")
  const active: Tab = isTab(tabParam) ? tabParam : "general"

  const subParam = searchParams.get("sub")
  const provider: ProviderTab =
    subParam && isProviderTab(subParam) ? subParam : "openrouter"
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
            <TabsTrigger value="integrations">Integrations</TabsTrigger>
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
          <DefaultAgentsSection />
          <AgentDefaultsSection />
          <CompactionSection />
          <WalkthroughRow />
        </TabsContent>
        <TabsContent value="appearance" className="space-y-6">
          <AppearanceSection />
        </TabsContent>
        <TabsContent value="providers">
          <ProvidersSection value={providerTab} />
        </TabsContent>
        <TabsContent value="integrations" className="space-y-6">
          <IntegrationsSection />
        </TabsContent>
      </Tabs>

      <VersionFooter />
    </div>
  )
}

/**
 * The running build, parked in the bottom-right corner of every tab. Sits
 * outside <Tabs> so switching tabs never hides it — this is the answer to "what
 * am I actually running", which matters most when reporting a bug or checking
 * whether an update landed. Selectable, so it can be pasted into an issue.
 */
function VersionFooter() {
  return (
    <div className="flex justify-end">
      <p className="select-text text-xs text-muted-foreground tabular-nums">
        Lursor v{__APP_VERSION__}
      </p>
    </div>
  )
}

/**
 * Way back into the first-run walkthrough. It derives its state live, so this is
 * a read of what is set up as much as a re-run — and it keeps `/welcome` from
 * being a URL only a fresh install can find.
 */
function WalkthroughRow() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">Setup walkthrough</p>
        <p className="text-sm text-muted-foreground">
          Step back through models, GitHub, and your first workspace.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link to="/welcome">Open</Link>
      </Button>
    </div>
  )
}
