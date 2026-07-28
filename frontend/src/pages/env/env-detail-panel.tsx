import {
  Copy,
  DotsThree,
  Eraser,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { useUpdateEnvVar } from "@/api/env-vars"
import type { EnvVar, ResolvedEnvEntry, Skill, Workspace } from "@/api/types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { copyToClipboard } from "@/lib/utils"
import { EnvScopeMenu, EnvSkillsMenu } from "./env-assignment-menus"
import { envScope, layerLabel, reachSummary, standingIn } from "./env-scope"

interface FieldProps {
  label: string
  htmlFor?: string
  children: React.ReactNode
  /** Sits under the control, for the sentence a bare input can't carry. */
  hint?: React.ReactNode
}

function Field({ label, htmlFor, children, hint }: FieldProps) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-3 px-4 py-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
      <label
        htmlFor={htmlFor}
        className="pt-1.5 text-xs font-medium text-muted-foreground"
      >
        {label}
      </label>
      {/* Capped rather than fluid: a variable name is short, and an input that
          grows to 700px on a wide window reads as a text area, not a field — and
          drags the hint under it out into a single unreadable line. */}
      <div className="min-w-0 max-w-xl space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
        {hint ? (
          <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    </div>
  )
}

interface EnvDetailPanelProps {
  envVar: EnvVar
  workspaces: Workspace[]
  workspaceNames: Map<string, string>
  skills: Skill[]
  skillNames: Map<string, string>
  skillSlugs: Map<string, string>
  /** The workspace being previewed in the rail, if any. */
  previewWorkspaceId: string | null
  /** The resolver's entry for this variable's key in that workspace. */
  resolvedEntry: ResolvedEnvEntry | undefined
  /** Focus the name field on mount — Enter or a double click in the rail. */
  autoFocusName: boolean
  onDelete: (envVar: EnvVar) => void
}

/**
 * Everything about one variable, editable in place.
 *
 * This pane is what replaced the form modal. Name, value and description are a
 * text edit with an explicit Save, because renaming a key can collide with another
 * variable at the same layer and a silent save-on-blur would surface that as a
 * toast over a field you had already stopped looking at. Everything discrete —
 * the secret switch, the two assignment menus — writes immediately, because those
 * can't fail on content and the control itself is the undo.
 *
 * The value of a secret is genuinely unreadable: the API returns `has_value` and
 * never the string (`app/api/env_vars.py`), so there is no reveal here and no
 * copy. Saying so beats a disabled button with no explanation.
 */
export function EnvDetailPanel({
  envVar,
  workspaces,
  workspaceNames,
  skills,
  skillNames,
  skillSlugs,
  previewWorkspaceId,
  resolvedEntry,
  autoFocusName,
  onDelete,
}: EnvDetailPanelProps) {
  const updateVar = useUpdateEnvVar()
  const nameRef = useRef<HTMLInputElement>(null)

  // The pane is keyed by variable id, so plain initial state is the reset: a new
  // selection is a new component.
  const [name, setName] = useState(envVar.key)
  const [description, setDescription] = useState(envVar.description)
  // `null` means untouched, for a secret and a config value alike. It has to be a
  // third state rather than an empty string: a secret reads back as no value at
  // all, so "" would be indistinguishable from "clear the stored one".
  const [valueDraft, setValueDraft] = useState<string | null>(null)

  const storedValue = envVar.value ?? ""
  const shownValue = valueDraft ?? storedValue
  const valueChanged = valueDraft !== null && valueDraft !== storedValue
  const dirty =
    name !== envVar.key || description !== envVar.description || valueChanged

  const scope = envScope(envVar)
  const standing = previewWorkspaceId
    ? standingIn(envVar, resolvedEntry, previewWorkspaceId, skillSlugs)
    : null
  const previewName = previewWorkspaceId
    ? (workspaceNames.get(previewWorkspaceId) ?? "this workspace")
    : ""

  function revert() {
    setName(envVar.key)
    setDescription(envVar.description)
    setValueDraft(null)
  }

  async function save() {
    if (!name.trim()) {
      toast.error("Name is required")
      nameRef.current?.focus()
      return
    }
    try {
      await updateVar.mutateAsync({
        id: envVar.id,
        input: {
          key: name.trim(),
          description,
          // Omitted unless it actually changed, so saving a description never
          // wipes a secret we can't read back to compare.
          ...(valueChanged ? { value: valueDraft as string } : {}),
        },
      })
      setValueDraft(null)
      toast.success(`${name.trim()} saved`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save variable")
    }
  }

  async function setSecret(isSecret: boolean) {
    try {
      await updateVar.mutateAsync({ id: envVar.id, input: { is_secret: isSecret } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change secrecy")
    }
  }

  async function clearValue() {
    try {
      await updateVar.mutateAsync({ id: envVar.id, input: { value: "" } })
      setValueDraft(null)
      toast.success(`${envVar.key} cleared — runs now receive it empty`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear the value")
    }
  }

  async function copyName() {
    const ok = await copyToClipboard(envVar.key)
    toast[ok ? "success" : "error"](ok ? "Name copied" : "Couldn't copy the name")
  }

  async function copyValue() {
    const ok = await copyToClipboard(storedValue)
    toast[ok ? "success" : "error"](ok ? "Value copied" : "Couldn't copy the value")
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        data-slot="env-detail-header"
        className="flex shrink-0 items-start gap-2 border-b border-border/60 px-4 py-3"
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate font-mono text-sm font-medium text-foreground">
              {name || "Unnamed"}
            </h3>
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {envVar.is_secret ? "Secret" : "Config"}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {envVar.description || reachSummary(envVar, workspaceNames, skillNames)}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label="Variable actions"
            >
              <DotsThree className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void copyName()}>
              <Copy className="h-4 w-4" />
              Copy name
            </DropdownMenuItem>
            {envVar.has_value && (
              <DropdownMenuItem onSelect={() => void clearValue()}>
                <Eraser className="h-4 w-4" />
                Clear value
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onDelete(envVar)}>
              <Trash className="h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* A variable with no value still resolves, still reports as "applied",
            and hands the agent an empty string — which fails as a confusing 401
            deep inside a skill rather than as anything you can see here. So it is
            said once, at the top, above every control that would otherwise look
            correctly configured. */}
        {!envVar.has_value ? (
          <div className="flex items-start gap-2 border-b border-border/60 bg-destructive/10 px-4 py-3">
            <WarningCircle
              weight="fill"
              className="mt-px h-4 w-4 shrink-0 text-destructive"
            />
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-medium text-foreground">
                No value set
              </p>
              <p className="text-xs text-muted-foreground">
                Runs this applies to receive it as an empty string, which usually
                surfaces as an authentication error inside a skill rather than as
                anything obvious here.
              </p>
            </div>
          </div>
        ) : null}

        {/* Where the old "Effective environment" card ended up: not a panel you
            scroll to, but the answer for the workspace the rail is already
            filtered by. */}
        {previewWorkspaceId ? (
          <div className="border-b border-border/60 bg-muted/40 px-4 py-2">
            {standing === null ? (
              <p className="text-xs text-muted-foreground">
                Not in scope in{" "}
                <span className="text-foreground">{previewName}</span> — nothing
                there receives it.
              </p>
            ) : standing.winning ? (
              <p className="text-xs text-muted-foreground">
                In <span className="text-foreground">{previewName}</span> this is
                the value a run gets, from the{" "}
                <span className="text-foreground">{layerLabel(standing.layer)}</span>{" "}
                layer
                {resolvedEntry && resolvedEntry.overridden.length > 1
                  ? `, overriding ${resolvedEntry.overridden
                      .filter((l) => l !== standing.layer)
                      .map(layerLabel)
                      .join(", ")}`
                  : ""}
                .
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                In <span className="text-foreground">{previewName}</span> this is
                set at the{" "}
                <span className="text-foreground">{layerLabel(standing.layer)}</span>{" "}
                layer but{" "}
                <span className="text-foreground">ignored</span> — another{" "}
                <span className="font-mono">{envVar.key}</span> at the{" "}
                <span className="text-foreground">
                  {layerLabel(standing.beatenBy ?? "")}
                </span>{" "}
                layer wins.
              </p>
            )}
          </div>
        ) : null}

        <div className="divide-y divide-border/40 py-1">
          <Field
            label="Name"
            htmlFor="env-detail-name"
            hint="Letters, digits and underscores; must not start with a digit. This is what the agent is told — the name, never the value."
          >
            <Input
              id="env-detail-name"
              ref={nameRef}
              autoFocus={autoFocusName}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save()
                if (e.key === "Escape") revert()
              }}
              className="h-8 font-mono text-xs"
              spellCheck={false}
            />
          </Field>

          <Field
            label="Value"
            htmlFor="env-detail-value"
            hint={
              envVar.is_secret
                ? envVar.has_value
                  ? "Stored and never sent back to the browser, so it can't be shown or copied here — type to replace it."
                  : "Never sent back to the browser once stored."
                : "Readable here, and shown in full to anyone with this screen open."
            }
          >
            <Input
              id="env-detail-value"
              type={envVar.is_secret ? "password" : "text"}
              value={envVar.is_secret ? (valueDraft ?? "") : shownValue}
              onChange={(e) => setValueDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save()
                if (e.key === "Escape") revert()
              }}
              placeholder={
                envVar.is_secret
                  ? envVar.has_value
                    ? "Stored — type to replace"
                    : "Not set"
                  : "Not set"
              }
              className="h-8 min-w-0 flex-1 font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
            {!envVar.is_secret && envVar.has_value ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => void copyValue()}
                aria-label="Copy value"
                title="Copy value"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </Field>

          <Field
            label="Description"
            htmlFor="env-detail-description"
            hint="Handed to the agent next to the name, so it knows what the variable is for without seeing what it holds."
          >
            <Input
              id="env-detail-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save()
                if (e.key === "Escape") revert()
              }}
              placeholder="What this is for"
              className="h-8 text-xs"
            />
          </Field>

          <Field
            label="Secret"
            hint={
              envVar.is_secret
                ? "Hidden from this screen and redacted from command output. Switch off to treat it as ordinary config you can read back."
                : "An ordinary config value — readable here and printed verbatim in command output. Switch on for anything that shouldn't be."
            }
          >
            <Switch
              checked={envVar.is_secret}
              onCheckedChange={(next) => void setSecret(next)}
              aria-label={envVar.is_secret ? "Stop treating as secret" : "Treat as secret"}
            />
          </Field>

          <Field
            label="Applies to"
            hint={
              scope === "unassigned"
                ? "Attached to nothing, so no run receives it. Pick a reach here, or a skill below."
                : "The base layer. A workspace assignment overrides a global one of the same name."
            }
          >
            <EnvScopeMenu envVar={envVar} workspaces={workspaces} />
          </Field>

          <Field
            label="With skills"
            hint="Also injected whenever one of these skills is in scope — and into that skill's own scripts, which no other skill's scripts can read. The highest layer, so a value set here wins."
          >
            <EnvSkillsMenu envVar={envVar} skills={skills} />
          </Field>
        </div>

        <p className="max-w-xl px-4 pb-4 pt-2 text-[11px] leading-snug text-muted-foreground">
          Values are stored in Lursor's local database in plain text, like your
          other saved keys. Anyone with access to this machine's data directory can
          read them.
        </p>
      </div>

      {/* Only the text fields need this. Sticky rather than inline so a long pane
          can't scroll the Save button out of reach of the edit that needs it. */}
      {dirty ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-background px-4 py-2">
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            Unsaved changes
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={revert}
              disabled={updateVar.isPending}
            >
              Revert
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={updateVar.isPending}>
              {updateVar.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
