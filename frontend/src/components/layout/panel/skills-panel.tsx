import { SquaresFour } from "@phosphor-icons/react"
import { Link } from "react-router-dom"

import type { Thread } from "@/api/types"
import { WorkspaceConversations } from "@/components/layout/panel/workspace-conversations"
import type { ConversationHandlers } from "@/components/layout/panel/types"

interface SkillsPanelProps extends ConversationHandlers {
  /** The studio's conversations, newest-first. */
  threads: Thread[]
  isLoading: boolean
}

/**
 * The Skill Studio's conversations, plus a way into the catalog.
 *
 * The studio used to be a nav row that was secretly a workspace — a hardcoded
 * label, a dual-purpose click handler, six no-op callbacks and an auto-expand
 * effect, all to reconcile "destination" with "folder". Splitting the rail from
 * the panel dissolves that: the rail item is the destination, this is its list.
 */
export function SkillsPanel({
  threads,
  isLoading,
  ...handlers
}: SkillsPanelProps) {
  return (
    <div className="flex flex-col gap-1 px-2 pb-2">
      <Link
        to="/customization?tab=skills"
        onClick={handlers.onNavigate}
        className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <SquaresFour className="size-4 shrink-0" />
        <span className="truncate">Browse catalog</span>
      </Link>

      <p className="px-2 pt-2 text-xs font-medium uppercase tracking-wide text-sidebar-foreground/70">
        Conversations
      </p>
      <WorkspaceConversations
        threads={threads}
        isLoading={isLoading}
        emptyLabel="No skill conversations"
        {...handlers}
      />
    </div>
  )
}
