import {
  ChatCircle,
  GitDiff,
  Globe,
  Terminal,
  type Icon,
} from "@phosphor-icons/react"

import type { DockKind } from "@/hooks/use-dock-state"
import { cn } from "@/lib/utils"

/**
 * The phone-only bottom navigation for a workspace. It switches the center view
 * in place (like tabs): "Chat" shows the conversation, and each dock kind swaps
 * the whole view to that panel full-screen.
 *
 * The Files (Monaco) panel is intentionally omitted here — code editing isn't
 * workable on a phone, so it stays a desktop-only surface.
 *
 * Rendered only inside `/workspaces/:id` routes (the dock is workspace-scoped),
 * and only on mobile — desktop keeps the resizable side dock.
 */

const CHAT_TAB = { key: "chat" as const, title: "Chat", icon: ChatCircle }

const DOCK_TABS: { key: DockKind; title: string; icon: Icon }[] = [
  { key: "changes", title: "Changes", icon: GitDiff },
  { key: "terminal", title: "Terminal", icon: Terminal },
  { key: "preview", title: "Preview", icon: Globe },
]

interface MobileDockBarProps {
  /** The dock kind currently shown in the sheet, or null when chat is active. */
  activeKind: DockKind | null
  /** Return to the chat surface (closes the dock sheet). */
  onSelectChat: () => void
  /** Open (or focus) the given dock panel in the bottom sheet. */
  onSelectKind: (kind: DockKind) => void
}

export function MobileDockBar({
  activeKind,
  onSelectChat,
  onSelectKind,
}: MobileDockBarProps) {
  const tabs = [CHAT_TAB, ...DOCK_TABS]
  return (
    <nav
      aria-label="Workspace panels"
      className="flex shrink-0 items-stretch border-t border-border/60 bg-background pb-safe"
    >
      {tabs.map((tab) => {
        const isChat = tab.key === "chat"
        const active = isChat ? activeKind === null : activeKind === tab.key
        const Icon = tab.icon
        return (
          <button
            key={tab.key}
            type="button"
            aria-pressed={active}
            onClick={() =>
              isChat ? onSelectChat() : onSelectKind(tab.key as DockKind)
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
