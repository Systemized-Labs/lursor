import { useSearchParams } from "react-router-dom"

import { PageHeader } from "@/components/page-header"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { GitHubPage } from "@/pages/github/github-page"
import { LaiosPage } from "@/pages/laios/laios-page"
import { ProvidersPage } from "@/pages/providers/providers-page"
import { OpenRouterSection } from "./openrouter-section"

const TABS = ["openrouter", "providers", "laios", "github"] as const
type Tab = (typeof TABS)[number]

function isTab(value: string | null): value is Tab {
  return value !== null && (TABS as readonly string[]).includes(value)
}

/**
 * App-level settings: model provider credentials (OpenRouter key + custom
 * providers) and the GitHub connection. The active tab is mirrored to `?tab=`
 * so it survives reloads and is deep-linkable.
 */
export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get("tab")
  const active: Tab = isTab(tabParam) ? tabParam : "openrouter"

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
        <TabsList>
          <TabsTrigger value="openrouter">OpenRouter</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="laios">laios</TabsTrigger>
          <TabsTrigger value="github">GitHub</TabsTrigger>
        </TabsList>

        <TabsContent value="openrouter">
          <OpenRouterSection />
        </TabsContent>
        <TabsContent value="providers">
          <ProvidersPage embedded />
        </TabsContent>
        <TabsContent value="laios">
          <LaiosPage embedded />
        </TabsContent>
        <TabsContent value="github">
          <GitHubPage embedded />
        </TabsContent>
      </Tabs>
    </div>
  )
}
