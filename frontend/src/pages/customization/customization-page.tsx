import { useSearchParams } from "react-router-dom"

import { PageHeader } from "@/components/page-header"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AgentsPage } from "@/pages/agents/agents-page"
import { PromptsPage } from "@/pages/prompts/prompts-page"
import { SkillsPage } from "@/pages/skills/skills-page"
import { ToolsPage } from "@/pages/tools/tools-page"

const TABS = ["agents", "prompts", "skills", "tools"] as const
type Tab = (typeof TABS)[number]

function isTab(value: string | null): value is Tab {
  return value !== null && (TABS as readonly string[]).includes(value)
}

/**
 * Single home for everything that shapes the harness — agents, skills, and
 * tools — surfaced as tabbed sections. The active tab is mirrored to the `?tab=`
 * query param so it survives reloads and is deep-linkable.
 */
export function CustomizationPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get("tab")
  const active: Tab = isTab(tabParam) ? tabParam : "agents"

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
        title="Customization"
        description="Shape your harness: manage agents, skills, and tools."
      />

      <Tabs value={active} onValueChange={handleTabChange} className="space-y-6">
        <TabsList>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="prompts">Prompts</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
        </TabsList>

        <TabsContent value="agents">
          <AgentsPage embedded />
        </TabsContent>
        <TabsContent value="prompts">
          <PromptsPage embedded />
        </TabsContent>
        <TabsContent value="skills">
          <SkillsPage embedded />
        </TabsContent>
        <TabsContent value="tools">
          <ToolsPage embedded />
        </TabsContent>
      </Tabs>
    </div>
  )
}
