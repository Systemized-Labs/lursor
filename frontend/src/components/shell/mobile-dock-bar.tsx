import {
  ChatCircle,
  GitDiff,
  Globe,
  ListChecks,
  type Icon,
} from "@phosphor-icons/react"

import type { DockKind } from "@/hooks/use-dock-state"
import { cn } from "@/lib/utils"

/**
 * The phone-only bottom navigation for a workspace. It switches the center view
 * in place (like tabs): "Chat" shows the conversation, and each other tab swaps
 * the whole view to that panel full-screen.
 *
 * The Files (Monaco) panel is intentionally omitted here — code editing isn't
 * workable on a phone. The Terminal is dropped too; a phone's most useful
 * workspace surface is the read-only **Plan** view (see {@link MobilePlanView}),
 * which takes that slot instead.
 *
 * Rendered only inside `/workspaces/:id` routes (the dock is workspace-scoped),
 * and only on mobile — desktop keeps the resizable side dock.
 */

type TabKey = "chat" | "plan" | DockKind

const TABS: { key: TabKey; title: string; icon: Icon }[] = [
  { key: "chat", title: "Chat", icon: ChatCircle },
  { key: "changes", title: "Changes", icon: GitDiff },
  { key: "plan", title: "Plan", icon: ListChecks },
  { key: "preview", title: "Preview", icon: Globe },
]

interface MobileDockBarProps {
  /** The dock kind currently shown in the sheet, or null when chat is active. */
  activeKind: DockKind | null
  /** True when the read-only plan view is the active surface. */
  planActive?: boolean
  /** Return to the chat surface (closes the dock sheet). */
  onSelectChat: () => void
  /** Open (or focus) the given dock panel in the bottom sheet. */
  onSelectKind: (kind: DockKind) => void
  /** Open (or focus) the read-only plan view. */
  onSelectPlan?: () => void
}

export function MobileDockBar({
  activeKind,
  planActive = false,
  onSelectChat,
  onSelectKind,
  onSelectPlan,
}: MobileDockBarProps) {
  const tabs = TABS
  return (
    <nav
      aria-label="Workspace panels"
      className="flex shrink-0 items-stretch border-t border-border/60 bg-background pb-safe"
    >
      {tabs.map((tab) => {
        const isChat = tab.key === "chat"
        const isPlan = tab.key === "plan"
        const active = isChat
          ? activeKind === null && !planActive
          : isPlan
            ? planActive
            : activeKind === tab.key
        const Icon = tab.icon
        return (
          <button
            key={tab.key}
            type="button"
            aria-pressed={active}
            onClick={() =>
              isChat
                ? onSelectChat()
                : isPlan
                  ? onSelectPlan?.()
                  : onSelectKind(tab.key as DockKind)
            }
            className={cn(
              "flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium transition-colors",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon
              className="h-5 w-5"
              weight={active ? "fill" : "regular"}
            />
            <span>{tab.title}</span>
          </button>
        )
      })}
    </nav>
  )
}
