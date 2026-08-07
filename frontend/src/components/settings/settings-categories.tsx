import { useState } from "react"
import {
  Bell,
  Clock,
  Cpu,
  Gear,
  GitBranch,
  Globe,
  ImageSquare,
  Info,
  Keyboard,
  Palette,
  Plug,
  Robot,
  SlidersHorizontal,
  Sparkle,
  Terminal,
  type Icon,
} from "@phosphor-icons/react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AboutSection } from "@/components/settings/about-section"
import { ShortcutsSection } from "@/components/settings/shortcuts-section"
import { AgentsPage } from "@/pages/agents/agents-page"
import { HeaderActionsSlotProvider } from "@/pages/customization/header-actions"
import { EnvPage } from "@/pages/env/env-page"
import { GitHubPage } from "@/pages/github/github-page"
import { LaiosPage } from "@/pages/laios/laios-page"
import { PromptsPage } from "@/pages/prompts/prompts-page"
import { ProvidersPage } from "@/pages/providers/providers-page"
import { SchedulesPage } from "@/pages/schedules/schedules-page"
import { AgentDefaultsSection } from "@/pages/settings/agent-defaults-section"
import { AssistantSection } from "@/pages/settings/assistant-section"
import { AppearanceSection } from "@/pages/settings/appearance-section"
import { CompactionSection } from "@/pages/settings/compaction-section"
import { DefaultAgentsSection } from "@/pages/settings/default-agents-section"
import { IntegrationsSection } from "@/pages/settings/integrations-section"
import { MediaSection } from "@/pages/settings/media-section"
import { MemorySection } from "@/pages/settings/memory-section"
import { OpenRouterSection } from "@/pages/settings/openrouter-section"
import { WebSearchSection } from "@/pages/settings/web-search-section"
import { SkillsPage } from "@/pages/skills/skills-page"
import { SubagentsPage } from "@/pages/subagents/subagents-page"
import { ToolsPage } from "@/pages/tools/tools-page"

/**
 * Every settings category, in rail order.
 *
 * Almost all of these are existing sections re-hosted, not rewrites: the
 * `/settings` and `/customization` tab strips were two competing shapes over the
 * same content, and this is one shape. What the dialog adds is Keyboard shortcuts
 * and About; what it deliberately does not add is Notifications (nothing sits
 * behind it — see the plan's §10) or the reference UI's export / import / reset
 * trio (no backend for any of the three).
 */
export interface SettingsCategory {
  id: string
  label: string
  /** Rail section heading. Categories are grouped in declaration order. */
  group: string
  icon: Icon
  /**
   * Needs more than the standard column. Skills and Environment are two-pane
   * browsers whose detail side goes unreadable at dialog width — the plan's §6
   * concern, and this is mitigation 1.
   */
  wide?: boolean
  render: () => React.ReactNode
}

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: "model",
    label: "Model",
    group: "Agents",
    icon: Robot,
    render: () => (
      <>
        <DefaultAgentsSection />
        <AgentDefaultsSection />
        <AssistantSection />
      </>
    ),
  },
  {
    id: "chat",
    label: "Chat",
    group: "Agents",
    icon: Sparkle,
    render: () => <CompactionSection />,
  },
  {
    id: "capabilities",
    label: "Capabilities",
    group: "Agents",
    icon: SlidersHorizontal,
    wide: true,
    render: () => <CapabilitiesCategory />,
  },
  {
    id: "environment",
    label: "Environment",
    group: "Agents",
    icon: Terminal,
    wide: true,
    render: () => <EnvCategory />,
  },
  {
    id: "memory",
    label: "Memory & context",
    group: "Agents",
    icon: Bell,
    render: () => <MemorySection />,
  },

  {
    id: "providers",
    label: "Providers",
    group: "Services",
    icon: Plug,
    render: () => <ProvidersCategory />,
  },
  {
    id: "web-search",
    label: "Web search",
    group: "Services",
    icon: Globe,
    render: () => <WebSearchSection />,
  },
  {
    id: "media",
    label: "Image & video",
    group: "Services",
    icon: ImageSquare,
    render: () => <MediaCategory />,
  },
  {
    id: "laios",
    label: "LAIOS",
    group: "Services",
    icon: Cpu,
    render: () => <LaiosPage embedded />,
  },
  {
    id: "integrations",
    label: "Integrations",
    group: "Services",
    icon: Gear,
    render: () => <IntegrationsSection />,
  },
  {
    id: "github",
    label: "GitHub",
    group: "Services",
    icon: GitBranch,
    render: () => <GitHubPage embedded />,
  },

  {
    id: "schedules",
    label: "Schedules",
    group: "Automation",
    icon: Clock,
    wide: true,
    render: () => <SchedulesPage embedded />,
  },

  {
    id: "appearance",
    label: "Appearance",
    group: "App",
    icon: Palette,
    render: () => <AppearanceSection />,
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    group: "App",
    icon: Keyboard,
    render: () => <ShortcutsSection />,
  },
  {
    id: "about",
    label: "About",
    group: "App",
    icon: Info,
    render: () => <AboutSection />,
  },
]

export const DEFAULT_CATEGORY = SETTINGS_CATEGORIES[0].id

export function findCategory(id: string | null): SettingsCategory {
  return (
    SETTINGS_CATEGORIES.find((c) => c.id === id) ?? SETTINGS_CATEGORIES[0]
  )
}

/** Rail sections, in declaration order. */
export function categoryGroups(): { group: string; items: SettingsCategory[] }[] {
  const groups: { group: string; items: SettingsCategory[] }[] = []
  for (const item of SETTINGS_CATEGORIES) {
    const existing = groups.find((g) => g.group === item.group)
    if (existing) existing.items.push(item)
    else groups.push({ group: item.group, items: [item] })
  }
  return groups
}

/**
 * The old Customization page, minus its own chrome. The sub-tabs stay: these are
 * five separate browsers, and stacking them into one scroll would be worse than
 * the tab strip they already had.
 *
 * `HeaderActionsSlotProvider` has to be here rather than at the dialog level —
 * Skills and Environment portal their primary actions into it, and without a slot
 * those buttons render nowhere at all (see `header-actions.tsx`).
 */
function CapabilitiesCategory() {
  const [tab, setTab] = useState("agents")
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null)

  return (
    <HeaderActionsSlotProvider value={actionsSlot}>
      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="agents">Agents</TabsTrigger>
            <TabsTrigger value="prompts">Prompts</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
            <TabsTrigger value="subagents">Subagents</TabsTrigger>
            <TabsTrigger value="tools">Tools</TabsTrigger>
          </TabsList>
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
        <TabsContent value="subagents">
          <SubagentsPage embedded />
        </TabsContent>
        <TabsContent value="tools">
          <ToolsPage embedded />
        </TabsContent>
      </Tabs>
    </HeaderActionsSlotProvider>
  )
}

/** Environment is the other two-pane browser, and needs the same action slot. */
function EnvCategory() {
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null)
  return (
    <HeaderActionsSlotProvider value={actionsSlot}>
      <div
        ref={setActionsSlot}
        className="flex flex-wrap items-center justify-end gap-2"
      />
      <EnvPage />
    </HeaderActionsSlotProvider>
  )
}

/**
 * Model sources: the OpenRouter key and custom OpenAI-compatible endpoints.
 *
 * Web search and Memory used to share this tab — "same shape of decision, one
 * app-wide backend behind a per-agent toggle" — which was a reasonable answer
 * when Settings had four tabs to spend. With a category rail there is no reason
 * to nest them, so they are categories of their own and this is model sources
 * only.
 */
/**
 * Where images and clips are generated. One tab per modality, because the two
 * choices are independent: a local box is the obvious answer for images (seconds,
 * free) while a hosted model may well be the only answer for video.
 */
function MediaCategory() {
  const [tab, setTab] = useState("image")
  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-4">
      <TabsList>
        <TabsTrigger value="image">Images</TabsTrigger>
        <TabsTrigger value="video">Video</TabsTrigger>
      </TabsList>
      <TabsContent value="image">
        <MediaSection kind="image" />
      </TabsContent>
      <TabsContent value="video">
        <MediaSection kind="video" />
      </TabsContent>
    </Tabs>
  )
}

function ProvidersCategory() {
  const [tab, setTab] = useState("openrouter")
  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-4">
      <TabsList>
        <TabsTrigger value="openrouter">OpenRouter</TabsTrigger>
        <TabsTrigger value="custom">Custom</TabsTrigger>
      </TabsList>
      <TabsContent value="openrouter">
        <OpenRouterSection />
      </TabsContent>
      <TabsContent value="custom">
        <ProvidersPage embedded />
      </TabsContent>
    </Tabs>
  )
}
