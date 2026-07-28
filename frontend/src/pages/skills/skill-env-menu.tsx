import { CaretDown, Key } from "@phosphor-icons/react"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { useEnvVars, useSetEnvVarAssignment } from "@/api/env-vars"
import type { EnvVar, Skill } from "@/api/types"
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

interface SkillEnvMenuProps {
  skill: Skill
}

function describe(ids: string[], vars: EnvVar[]): string {
  const [first, ...rest] = ids
  if (!first) return "No variables"
  if (rest.length === 0) {
    return vars.find((v) => v.id === first)?.key ?? "1 variable"
  }
  return `${ids.length} variables`
}

/**
 * Attach environment variables to a skill from its row. Values stay server-side:
 * this only records which variables get injected when the skill is in scope.
 *
 * Assignment lives on the variable (a variable can serve several skills), so
 * saving is a diff of added/removed ids. Like the workspace menu, picks are held
 * as a draft and written when the menu closes — one request per changed variable
 * instead of one per click, and the row can't shuffle out from under the menu.
 */
export function SkillEnvMenu({ skill }: SkillEnvMenuProps) {
  const envVarsQuery = useEnvVars()
  const setAssignment = useSetEnvVarAssignment()
  const vars = envVarsQuery.data ?? []
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>(skill.env_var_ids)
  const draftRef = useRef<string[]>(skill.env_var_ids)

  function update(next: string[]) {
    draftRef.current = next
    setDraft(next)
  }

  async function save(next: string[]) {
    const before = skill.env_var_ids
    const added = next.filter((id) => !before.includes(id))
    const removed = before.filter((id) => !next.includes(id))
    if (added.length === 0 && removed.length === 0) return
    const byId = new Map(vars.map((v) => [v.id, v]))
    try {
      for (const id of [...added, ...removed]) {
        const envVar = byId.get(id)
        if (!envVar) continue
        const skillIds = added.includes(id)
          ? [...envVar.skill_ids, skill.id]
          : envVar.skill_ids.filter((s) => s !== skill.id)
        await setAssignment.mutateAsync({
          id,
          input: {
            is_global: envVar.is_global,
            workspace_ids: envVar.workspace_ids,
            skill_ids: skillIds,
          },
        })
      }
      toast.success(
        next.length === 0
          ? `No variables injected for "${skill.name}"`
          : `${next.length} variable${next.length === 1 ? "" : "s"} injected for "${skill.name}"`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save variables")
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) {
      update(skill.env_var_ids)
      return
    }
    void save(draftRef.current)
  }

  const shown = open ? draft : skill.env_var_ids

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 max-w-[12rem] gap-1.5 px-2 text-xs font-normal"
          disabled={setAssignment.isPending}
          title="Choose which environment variables this skill gets"
        >
          {shown.length > 0 ? (
            <Key className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          <span className="truncate">
            {setAssignment.isPending ? "Saving…" : describe(shown, vars)}
          </span>
          <CaretDown className="h-3 w-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-72 overflow-y-auto">
        <DropdownMenuLabel>Injected when in scope</DropdownMenuLabel>
        {vars.length === 0 ? (
          <DropdownMenuItem disabled>
            No variables yet — add them on the Environment tab
          </DropdownMenuItem>
        ) : (
          vars.map((envVar) => (
            <DropdownMenuCheckboxItem
              key={envVar.id}
              checked={draft.includes(envVar.id)}
              onSelect={(event) => {
                event.preventDefault()
                update(
                  draft.includes(envVar.id)
                    ? draft.filter((id) => id !== envVar.id)
                    : [...draft, envVar.id]
                )
              }}
            >
              <span className="min-w-0">
                <span className="block truncate font-mono text-xs">
                  {envVar.key}
                </span>
                {(envVar.description || !envVar.has_value) && (
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {envVar.has_value
                      ? envVar.description
                      : "No value set — the agent will see it empty"}
                  </span>
                )}
              </span>
            </DropdownMenuCheckboxItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          Values reach the agent's shell and this skill's scripts. The agent is
          told the names, never the values.
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
