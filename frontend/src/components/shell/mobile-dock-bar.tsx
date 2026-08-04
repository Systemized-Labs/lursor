import { ChatCircle, ListChecks, type Icon } from "@phosphor-icons/react"

import {
  PANE_KINDS,
  type MobilePaneKind,
} from "@/components/panes/pane-kinds"
import { cn } from "@/lib/utils"

/**
 * The phone-only bottom navigation for a workspace. It switches the centre view
 * in place (like tabs): "Chat" shows the conversation, and each other tab swaps
 * the whole view to that surface full-screen.
 *
 * **Driven by the open pane list, not a fixed set** (§7). It used to name four
 * hardcoded kinds — and deliberately omitted Files and Terminal on the grounds
 * that neither is workable on a phone. That call is superseded: a pane you opened
 * is a pane you meant to open, Monaco already ships touch-tuned options for exactly
 * this case, and a terminal is worth reading even where it is awkward to type into.
 * So the bar shows what the workspace's layout holds.
 *
 * Chat and Plan are always present and are not panes: chat is the base view the bar
 * switches *away* from, and the plan view is a read-only Markdown surface that only
 * exists on mobile (see {@link MobilePlanView}).
 */

interface MobileDockBarProps {
  /** Non-chat pane kinds open in this workspace, in layout order. */
  kinds: MobilePaneKind[]
  /** The kind currently shown full-screen, or null when chat is active. */
  activeKind: MobilePaneKind | null
  /** True when the read-only plan view is the active surface. */
  planActive?: boolean
  /** Return to the chat surface. */
  onSelectChat: () => void
  /** Show the given pane kind full-screen. */
  onSelectKind: (kind: MobilePaneKind) => void
  /** Show the read-only plan view. */
  onSelectPlan?: () => void
}

export function MobileDockBar({
  kinds,
  activeKind,
  planActive = false,
  onSelectChat,
  onSelectKind,
  onSelectPlan,
}: MobileDockBarProps) {
  const tabs: { key: string; title: string; icon: Icon; onSelect: () => void; active: boolean }[] =
    [
      {
        key: "chat",
        title: "Chat",
        icon: ChatCircle,
        onSelect: onSelectChat,
        active: activeKind === null && !planActive,
      },
      ...(onSelectPlan
        ? [
            {
              key: "plan",
              title: "Plan",
              icon: ListChecks,
              onSelect: onSelectPlan,
              active: planActive,
            },
          ]
        : []),
      ...kinds.map((kind) => ({
        key: kind,
        title: PANE_KINDS[kind].title,
        icon: PANE_KINDS[kind].icon,
        onSelect: () => onSelectKind(kind),
        active: activeKind === kind,
      })),
    ]

  return (
    <nav
      aria-label="Workspace surfaces"
      // Scrollable rather than shrinking: with several panes open, five equal
      // columns on a 390px screen give each about 70px, which truncates every
      // label. A row that scrolls keeps them readable and says there is more.
      className="flex shrink-0 items-stretch overflow-x-auto border-t border-border/60 bg-background pb-safe"
    >
      {tabs.map((tab) => {
        const Icon = tab.icon
        return (
          <button
            key={tab.key}
            type="button"
            aria-pressed={tab.active}
            onClick={tab.onSelect}
            className={cn(
              "flex min-h-[52px] min-w-[4.5rem] flex-1 shrink-0 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium transition-colors",
              tab.active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-5 w-5" weight={tab.active ? "fill" : "regular"} />
            <span className="max-w-full truncate px-1">{tab.title}</span>
          </button>
        )
      })}
    </nav>
  )
}
