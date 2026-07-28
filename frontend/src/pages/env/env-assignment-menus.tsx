import { CaretDown, Globe, Key, Prohibit } from "@phosphor-icons/react"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { useSetEnvVarAssignment } from "@/api/env-vars"
import type { EnvVar, Skill, Workspace } from "@/api/types"
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

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((id, i) => id === sortedB[i])
}

/** Draft reach while the menu is open. */
interface ReachDraft {
  isGlobal: boolean
  workspaceIds: string[]
}

function describeReach(draft: ReachDraft, workspaces: Workspace[]): string {
  if (draft.isGlobal) return "Everywhere"
  const [first, ...rest] = draft.workspaceIds
  if (!first) return "Nowhere"
  if (rest.length === 0) {
    return workspaces.find((ws) => ws.id === first)?.name ?? "1 workspace"
  }
  return `${draft.workspaceIds.length} workspaces`
}

interface EnvScopeMenuProps {
  envVar: EnvVar
  workspaces: Workspace[]
}

/**
 * The base reach of a variable: everywhere, a set of workspaces, or nowhere.
 *
 * Skill attachment is a separate control ({@link EnvSkillsMenu}) because it is a
 * separate *layer*, not an alternative to this one — a variable can be global and
 * still carry a skill-specific override. Each menu therefore writes its own half
 * of the assignment and passes the other half through untouched; the endpoint
 * replaces the assignment wholesale, so forgetting that would silently unassign.
 *
 * Picks are held as a draft and saved once, when the menu closes. Saving per click
 * would refetch the list, move the row into another section and tear the open menu
 * down mid-edit, making multi-select impossible. The draft is mirrored into a ref
 * because Radix closes the menu inside the same event as `onSelect`, before a
 * state update would be visible to `onOpenChange`.
 */
export function EnvScopeMenu({ envVar, workspaces }: EnvScopeMenuProps) {
  const setAssignment = useSetEnvVarAssignment()
  const initial: ReachDraft = {
    isGlobal: envVar.is_global,
    workspaceIds: envVar.workspace_ids,
  }
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ReachDraft>(initial)
  const draftRef = useRef<ReachDraft>(initial)

  function update(next: ReachDraft) {
    draftRef.current = next
    setDraft(next)
  }

  async function save({ isGlobal, workspaceIds }: ReachDraft) {
    try {
      await setAssignment.mutateAsync({
        id: envVar.id,
        input: {
          is_global: isGlobal,
          workspace_ids: isGlobal ? [] : workspaceIds,
          skill_ids: envVar.skill_ids,
        },
      })
      toast.success(
        isGlobal
          ? `${envVar.key} applies everywhere`
          : workspaceIds.length === 0
            ? envVar.skill_ids.length > 0
              ? `${envVar.key} now applies only with its skills`
              : `${envVar.key} is no longer applied anywhere`
            : `${envVar.key} applies in ${workspaceIds.length} workspace${
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
      update({ isGlobal: envVar.is_global, workspaceIds: envVar.workspace_ids })
      return
    }
    const next = draftRef.current
    const changed =
      next.isGlobal !== envVar.is_global ||
      (!next.isGlobal && !sameIds(next.workspaceIds, envVar.workspace_ids))
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
          title="Change which runs receive this variable"
        >
          {shown.isGlobal ? (
            <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          <span className="truncate">
            {setAssignment.isPending ? "Saving…" : describeReach(shown, workspaces)}
          </span>
          <CaretDown className="h-3 w-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      {/* Bounded by the space Radix actually found on the side it chose, not by a
          fraction of the viewport. This trigger sits low in the pane, so the menu
          flips upward — and a fixed `70vh` is taller than the room above it, which
          put the first item 68px off the top of the screen where nothing could
          click it. The variable shrinks the box to fit and scrolls the overflow. */}
      <DropdownMenuContent
        align="start"
        className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-64 overflow-y-auto"
      >
        <DropdownMenuLabel>Which runs get this</DropdownMenuLabel>
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
              Nowhere
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function describeSkills(ids: string[], skills: Skill[]): string {
  const [first, ...rest] = ids
  if (!first) return "No skills"
  if (rest.length === 0) {
    return skills.find((s) => s.id === first)?.name ?? "1 skill"
  }
  return `${ids.length} skills`
}

interface EnvSkillsMenuProps {
  envVar: EnvVar
  skills: Skill[]
}

/**
 * The skill layer: which skills, being in scope, pull this variable into the run.
 *
 * This is the mirror of the menu on a skill's own detail pane — the same links,
 * edited from the other end — and the highest-precedence layer, so a value set
 * here beats the workspace and global ones.
 */
export function EnvSkillsMenu({ envVar, skills }: EnvSkillsMenuProps) {
  const setAssignment = useSetEnvVarAssignment()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>(envVar.skill_ids)
  const draftRef = useRef<string[]>(envVar.skill_ids)

  function update(next: string[]) {
    draftRef.current = next
    setDraft(next)
  }

  async function save(next: string[]) {
    if (sameIds(next, envVar.skill_ids)) return
    try {
      await setAssignment.mutateAsync({
        id: envVar.id,
        input: {
          is_global: envVar.is_global,
          workspace_ids: envVar.workspace_ids,
          skill_ids: next,
        },
      })
      toast.success(
        next.length === 0
          ? `${envVar.key} is no longer tied to a skill`
          : `${envVar.key} follows ${next.length} skill${next.length === 1 ? "" : "s"}`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save assignment")
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) {
      update(envVar.skill_ids)
      return
    }
    void save(draftRef.current)
  }

  const shown = open ? draft : envVar.skill_ids

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 max-w-[12rem] gap-1.5 px-2 text-xs font-normal"
          disabled={setAssignment.isPending}
          title="Choose which skills bring this variable into a run"
        >
          {shown.length > 0 ? (
            <Key className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          <span className="truncate">
            {setAssignment.isPending ? "Saving…" : describeSkills(shown, skills)}
          </span>
          <CaretDown className="h-3 w-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-72 overflow-y-auto">
        <DropdownMenuLabel>Pulled in by these skills</DropdownMenuLabel>
        {skills.length === 0 ? (
          <DropdownMenuItem disabled>No skills yet</DropdownMenuItem>
        ) : (
          skills.map((skill) => (
            <DropdownMenuCheckboxItem
              key={skill.id}
              checked={draft.includes(skill.id)}
              onSelect={(event) => {
                event.preventDefault()
                update(
                  draft.includes(skill.id)
                    ? draft.filter((id) => id !== skill.id)
                    : [...draft, skill.id]
                )
              }}
            >
              <span className="min-w-0">
                <span className="block truncate text-xs">{skill.name}</span>
                {!skill.enabled && (
                  <span className="block truncate text-[10px] text-muted-foreground">
                    Switched off — nothing loads it, so nothing injects this
                  </span>
                )}
              </span>
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
