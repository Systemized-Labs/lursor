/**
 * "Ingest skill" — the file-explorer half of the skills manager.
 *
 * A skill folder is only *discovered* if it sits in a configured root
 * (`.agents/skills` and the other tools' in-repo conventions). Plenty don't: a
 * vendored `skills/` directory, a collection someone cloned into the repo, a
 * folder authored in place. Those are visible in the tree and invisible to the
 * manager, and this closes that gap without asking the user to re-upload files
 * the server can already see.
 *
 * The menu only appears where it means something: opening it scans the folder,
 * and a folder with no `SKILL.md` under it renders nothing at all.
 */

import { GitBranch, GlobeHemisphereWest, Sparkle, Stack } from "@phosphor-icons/react"
import { toast } from "sonner"

import { useIngestSkills, useSkillScan } from "@/api/skills"
import type { SkillIngestInput } from "@/api/types"
import { ApiError } from "@/api/client"
import {
  ContextMenuLabel,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu"

interface SkillIngestMenuProps {
  workspaceId: string
  /** Workspace-relative folder that was right-clicked. */
  path: string
  /** Whether the containing menu is open — gates the scan. */
  open: boolean
}

type Destination = Pick<SkillIngestInput, "origin" | "is_global">

export function SkillIngestMenu({ workspaceId, path, open }: SkillIngestMenuProps) {
  const { data } = useSkillScan(workspaceId, path, open)
  const ingest = useIngestSkills()
  const found = data?.skills ?? []
  // Folders in a discovered root (`.claude/skills`) are already managed, and
  // ingesting one would only put a second copy of a working skill in the catalog.
  const fresh = found.filter((skill) => !skill.indexed)
  const managed = found.length - fresh.length

  // Nothing to ingest (or nothing known yet): no menu entry. Keeps the ordinary
  // right-click on an ordinary folder exactly as it was.
  if (fresh.length === 0) return null

  const label = fresh.length > 1 ? `Ingest ${fresh.length} skills` : "Ingest skill"

  async function run(destination: Destination) {
    try {
      const created = await ingest.mutateAsync({
        workspace_id: workspaceId,
        path,
        ...destination,
      })
      const what =
        created.length === 1 ? `“${created[0].name}”` : `${created.length} skills`
      toast.success(
        destination.origin === "local"
          ? `${what} copied into .agents/skills`
          : `${what} added to your catalog`
      )
    } catch (err) {
      toast.error(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : "Could not ingest skill"
      )
    }
  }

  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Sparkle className="mr-2 h-4 w-4" />
          {label}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-60">
          {/* What will be copied, named before the click. */}
          <ContextMenuLabel className="truncate text-xs font-normal text-muted-foreground">
            {fresh.map((skill) => skill.slug).join(", ")}
            {managed > 0 && ` · ${managed} already managed`}
          </ContextMenuLabel>
          <ContextMenuItem
            disabled={ingest.isPending}
            onSelect={() => void run({ origin: "managed" })}
          >
            <Stack className="mr-2 h-4 w-4" />
            Use in this workspace
          </ContextMenuItem>
          <ContextMenuItem
            disabled={ingest.isPending}
            onSelect={() => void run({ origin: "managed", is_global: true })}
          >
            <GlobeHemisphereWest className="mr-2 h-4 w-4" />
            Use everywhere
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* The one option that writes into the repo, so it says so. */}
          <ContextMenuItem
            disabled={ingest.isPending}
            onSelect={() => void run({ origin: "local" })}
          >
            <GitBranch className="mr-2 h-4 w-4" />
            Commit into this repo
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  )
}
