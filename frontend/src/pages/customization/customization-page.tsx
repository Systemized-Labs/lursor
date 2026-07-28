import { useState } from "react"
import { useSearchParams } from "react-router-dom"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AgentsPage } from "@/pages/agents/agents-page"
import { HeaderActionsSlotProvider } from "@/pages/customization/header-actions"
import { EnvPage } from "@/pages/env/env-page"
import { PromptsPage } from "@/pages/prompts/prompts-page"
import { SkillsPage } from "@/pages/skills/skills-page"
import { SubagentsPage } from "@/pages/subagents/subagents-page"
import { ToolsPage } from "@/pages/tools/tools-page"

const TABS = ["agents", "prompts", "skills", "env", "subagents", "tools"] as const
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
  // State, not a ref: the tab portalling into this element has to re-render once
  // it exists.
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null)

  // Each browser tab's selected row (`?skill=`, `?var=`) is deliberately left
  // alone: it is inert on every other tab, and keeping it means a trip to another
  // tab and back returns you to the pane you were reading. Clearing it here would
  // not stick anyway — the rail is still mounted for that commit and re-publishes
  // its selection.
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
    <div>
      {/* No visible title or description: the sidebar already says where you
          are, and the tab strip names every section. The heading stays for
          screen readers, where it costs no space. */}
      <h1 className="sr-only">Customization</h1>

      <HeaderActionsSlotProvider value={actionsSlot}>
        <Tabs
          value={active}
          onValueChange={handleTabChange}
          className="space-y-6"
        >
          {/* The tab strip shares its row with the active tab's actions, so the
              page starts at the content. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="agents">Agents</TabsTrigger>
              <TabsTrigger value="prompts">Prompts</TabsTrigger>
              <TabsTrigger value="skills">Skills</TabsTrigger>
              <TabsTrigger value="env">Environment</TabsTrigger>
              <TabsTrigger value="subagents">Subagents</TabsTrigger>
              <TabsTrigger value="tools">Tools</TabsTrigger>
            </TabsList>
            {/* Filled by whichever tab has actions to publish. Wraps rather than
                clipping its last button on a narrow window. */}
            <div
              ref={setActionsSlot}
              className="flex flex-wrap items-center justify-end gap-2"
            />
          </div>

          <TabsContent value="agents">
            <AgentsPage embedded />
          </TabsContent>
          <TabsContent value="prompts">
            <PromptsPage embedded />
          </TabsContent>
          <TabsContent value="skills">
            <SkillsPage />
          </TabsContent>
          <TabsContent value="env">
            <EnvPage />
          </TabsContent>
          <TabsContent value="subagents">
            <SubagentsPage embedded />
          </TabsContent>
          <TabsContent value="tools">
            <ToolsPage embedded />
          </TabsContent>
        </Tabs>
      </HeaderActionsSlotProvider>
    </div>
  )
}
