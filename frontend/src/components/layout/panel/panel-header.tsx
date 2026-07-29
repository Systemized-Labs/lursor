import { MagnifyingGlass, Plus, X } from "@phosphor-icons/react"

import type { Workspace } from "@/api/types"
import { Button } from "@/components/ui/button"
import { useSidebar } from "@/components/ui/sidebar"
import type { PanelMode } from "@/components/layout/use-panel-mode"

/**
 * Header affordances share the panel's icon-button treatment. `no-drag` because
 * on macOS this header renders *inside* the window's drag strip — without it the
 * buttons would move the window instead of firing.
 */
const HEADER_TILE =
  "size-7 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [-webkit-app-region:no-drag]"

interface PanelHeaderProps {
  panelMode: PanelMode
  /** The workspace the Chats list is scoped to; names the header when there is one. */
  scopedWorkspace: Workspace | undefined
  onNewConversation: (workspaceId: string) => void
  onNewChat: () => void
  onSearch: () => void
}

/**
 * The row naming what the panel is showing, plus search and ⊕.
 *
 * It lives in its own component because it has two homes. On macOS it is
 * rendered by AppSidebar *into* the traffic-light strip, so the heading sits on
 * the same line as the window buttons — the strip is 36px of chrome the app has
 * to reserve anyway, and a separate header row below it spent another 40px
 * repeating the same horizontal band. Everywhere else there is no strip to share,
 * so SidebarPanel renders it at the top of the panel instead.
 */
export function PanelHeader({
  panelMode,
  scopedWorkspace,
  onNewConversation,
  onNewChat,
  onSearch,
}: PanelHeaderProps) {
  const { isMobile, setOpenMobile } = useSidebar()

  const isChats = panelMode === "chats"
  const title = isChats ? (scopedWorkspace?.name ?? "Conversations") : "Activity"

  // ⊕ means "another conversation in the workspace this list is showing". With
  // no workspace at all there is nothing to add one to, so it falls back to the
  // New Agent home.
  const handleNew = () => {
    if (scopedWorkspace) onNewConversation(scopedWorkspace.id)
    else onNewChat()
  }

  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-1 px-2">
      {/* A ledger label, not a page title. At `text-sm font-semibold` this
          competed with the conversation titles below it for the same rank —
          and in a 256px column the thing you read is the list, not the word
          naming it. Small, letterspaced and uppercase reads as a heading at a
          fraction of the weight, and gives the rows back their prominence. */}
      <h2
        className="min-w-0 flex-1 truncate px-1 text-[11px] font-medium uppercase tracking-[0.1em] text-sidebar-foreground/70"
        title={isChats ? scopedWorkspace?.name : undefined}
      >
        {title}
      </h2>
      <Button
        variant="ghost"
        size="icon"
        onClick={onSearch}
        aria-label="Search"
        title="Search (⌘K)"
        className={HEADER_TILE}
      >
        <MagnifyingGlass className="size-4" />
      </Button>
      {isChats ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={handleNew}
          aria-label="New conversation"
          title="New conversation"
          className={HEADER_TILE}
        >
          <Plus className="size-4" />
        </Button>
      ) : null}
      {/* The off-canvas sheet hides its own close, so give the drawer a clear
          dismiss affordance. */}
      {isMobile ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setOpenMobile(false)}
          aria-label="Close menu"
          className={HEADER_TILE}
        >
          <X className="size-4" />
        </Button>
      ) : null}
    </div>
  )
}
