import { CaretDown, Globe, Prohibit } from "@phosphor-icons/react"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { useSetSkillAssignment } from "@/api/skills"
import type { Skill, Workspace } from "@/api/types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface SkillScopeMenuProps {
  skill: Skill
  workspaces: Workspace[]
}

/** Draft assignment while the menu is open. */
interface Draft {
  isGlobal: boolean
  workspaceIds: string[]
}

/** The trigger's one-line summary of a reach. */
function describe(draft: Draft, workspaces: Workspace[]): string {
  if (draft.isGlobal) return "Everywhere"
  const [first, ...rest] = draft.workspaceIds
  if (!first) return "Not assigned"
  if (rest.length === 0) {
    return workspaces.find((ws) => ws.id === first)?.name ?? "1 workspace"
  }
  return `${draft.workspaceIds.length} workspaces`
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((id, i) => id === sortedB[i])
}

/**
 * Re-point a skill straight from its row: everywhere, a set of workspaces, or
 * nowhere. The files never move — assignment is a DB write, which is what lets
 * this serve a skill in `~/.claude/skills` as readily as one in the catalog.
 *
 * Picks are held as a draft and saved once, when the menu closes. Saving per
 * click would refetch the list, move the row into another group and tear the open
 * menu down mid-edit, making multi-select impossible. The draft is mirrored into
 * a ref because Radix closes the menu inside the same event as `onSelect`, before
 * a state update would be visible to `onOpenChange`.
 */
export function SkillScopeMenu({ skill, workspaces }: SkillScopeMenuProps) {
  const setAssignment = useSetSkillAssignment()
  const initial: Draft = {
    isGlobal: skill.is_global,
    workspaceIds: skill.workspace_ids,
  }
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(initial)
  const draftRef = useRef<Draft>(initial)

  function update(next: Draft) {
    draftRef.current = next
    setDraft(next)
  }

  async function save({ isGlobal, workspaceIds }: Draft) {
    try {
      await setAssignment.mutateAsync({
        id: skill.id,
        input: { is_global: isGlobal, workspace_ids: isGlobal ? [] : workspaceIds },
      })
      toast.success(
        isGlobal
          ? `"${skill.name}" applies everywhere`
          : workspaceIds.length === 0
            ? `"${skill.name}" is no longer assigned anywhere`
            : `"${skill.name}" applies in ${workspaceIds.length} workspace${
                workspaceIds.length === 1 ? "" : "s"
              }`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save assignment")
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) {
      update({ isGlobal: skill.is_global, workspaceIds: skill.workspace_ids })
      return
    }
    const next = draftRef.current
    const changed =
      next.isGlobal !== skill.is_global ||
      (!next.isGlobal && !sameIds(next.workspaceIds, skill.workspace_ids))
    if (changed) void save(next)
  }

  function toggleWorkspace(ws: Workspace) {
    // Picking a workspace while global means "narrow to just this one" — the
    // per-workspace checkmarks are meaningless under a global assignment.
    if (draft.isGlobal) {
      update({ isGlobal: false, workspaceIds: [ws.id] })
      return
    }
    update({
      isGlobal: false,
      workspaceIds: draft.workspaceIds.includes(ws.id)
        ? draft.workspaceIds.filter((id) => id !== ws.id)
        : [...draft.workspaceIds, ws.id],
    })
  }

  // While open the trigger previews the draft, so the button and the checkmarks
  // never disagree; closed, it shows what the server holds.
  const shown = open ? draft : initial

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 max-w-[12rem] gap-1.5 px-2 text-xs font-normal"
          disabled={setAssignment.isPending}
          title="Change where this skill applies"
        >
          {shown.isGlobal ? (
            <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          <span className="truncate">
            {setAssignment.isPending ? "Saving…" : describe(shown, workspaces)}
          </span>
          <CaretDown className="h-3 w-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      {/* Bounded so a long workspace list scrolls instead of running off-screen. */}
      <DropdownMenuContent align="end" className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-64 overflow-y-auto">
        <DropdownMenuLabel>Where this applies</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={draft.isGlobal}
          onSelect={(event) => {
            event.preventDefault()
            update({ isGlobal: !draft.isGlobal, workspaceIds: [] })
          }}
        >
          Every workspace
        </DropdownMenuCheckboxItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground">
          Or pick workspaces
        </DropdownMenuLabel>
        {workspaces.length === 0 ? (
          <DropdownMenuItem disabled>No workspaces yet</DropdownMenuItem>
        ) : (
          workspaces.map((ws) => (
            <DropdownMenuCheckboxItem
              key={ws.id}
              checked={!draft.isGlobal && draft.workspaceIds.includes(ws.id)}
              onSelect={(event) => {
                event.preventDefault()
                toggleWorkspace(ws)
              }}
            >
              <span className="truncate">{ws.name}</span>
            </DropdownMenuCheckboxItem>
          ))
        )}

        {draft.isGlobal || draft.workspaceIds.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            {/* Closes the menu, which is what saves the emptied draft. */}
            <DropdownMenuItem
              onSelect={() => update({ isGlobal: false, workspaceIds: [] })}
            >
              <Prohibit className="h-4 w-4" />
              Unassign
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
