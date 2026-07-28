import {
  ArrowLineUp,
  Copy,
  DotsThree,
  LinkSimple,
  Pencil,
  Sparkle,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react"
import { toast } from "sonner"

import { useSkillFile } from "@/api/skills"
import type { Skill, Workspace } from "@/api/types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MarkdownRenderer } from "@/components/ui/markdown-renderer"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { skillFolder } from "@/lib/skill-location"
import { cn, copyToClipboard } from "@/lib/utils"
import { SkillEnvMenu } from "./skill-env-menu"
import { SkillScopeMenu } from "./skill-scope-menu"

/** The skill's own instructions file — always present. */
const SKILL_FILE = "SKILL.md"

/**
 * Drop a leading YAML frontmatter block from the preview.
 *
 * `SKILL.md` opens with `---\nname: …\n---`, which markdown reads as a setext
 * heading and renders as noise. The two fields it holds are the pane's own title
 * and subtitle, so nothing is lost. The editor still shows the file verbatim.
 */
function stripFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content)
  return match ? content.slice(match[0].length) : content
}

interface FieldProps {
  label: string
  children: React.ReactNode
  /** Sits under the control, for the sentence a bare icon button can't carry. */
  hint?: React.ReactNode
}

function Field({ label, children, hint }: FieldProps) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-3 px-4 py-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
      <span className="pt-1.5 text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {/* Capped rather than fluid: on a wide window the pane is over 1000px, and
          a one-line hint stretched across all of it is harder to read than the
          same sentence wrapped twice. */}
      <div className="min-w-0 max-w-xl space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
        {hint ? (
          <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    </div>
  )
}

interface SkillDetailPanelProps {
  skill: Skill
  workspaces: Workspace[]
  workspaceNames: Map<string, string>
  onEdit: (skill: Skill) => void
  onOpenInWorkspace: (skill: Skill) => void
  onPromote: (skill: Skill) => void
  onCopy: (skill: Skill) => void
  /** Symlink a personal skill into the catalog — no copy, no confirmation. */
  onLink: (skill: Skill) => void
  onToggle: (skill: Skill, enabled: boolean) => void
  onDelete: (skill: Skill) => void
}

/**
 * Everything about one skill: a labelled property list over the controls the row
 * used to cram in unlabelled, then its instructions.
 *
 * The division of labour with {@link SkillEditorDialog} is deliberate — this pane
 * is for reading and pointing (what is this, where does it apply, what does it
 * say), the dialog is for authoring.
 */
export function SkillDetailPanel({
  skill,
  workspaces,
  workspaceNames,
  onEdit,
  onOpenInWorkspace,
  onPromote,
  onCopy,
  onLink,
  onToggle,
  onDelete,
}: SkillDetailPanelProps) {
  const isLocal = skill.origin === "local"
  const isExternal = skill.origin === "external"
  const isLinked = Boolean(skill.link_target)
  const bundled = [...skill.resources, ...skill.scripts]
  const folder = skillFolder(skill, workspaces)
  const preview = useSkillFile(skill.id, SKILL_FILE)

  async function copyFolder() {
    if (!folder) return
    const ok = await copyToClipboard(folder)
    toast[ok ? "success" : "error"](
      ok ? "Folder path copied" : "Couldn't copy the path"
    )
  }

  const moveOrCopy = skill.is_owned_root ? (
    <Button variant="outline" size="sm" onClick={() => onPromote(skill)}>
      <ArrowLineUp className="h-3.5 w-3.5" />
      Move to catalog
    </Button>
  ) : (
    <Button variant="outline" size="sm" onClick={() => onCopy(skill)}>
      <Copy className="h-3.5 w-3.5" />
      Copy to catalog
    </Button>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        data-slot="skill-detail-header"
        className="flex shrink-0 items-start gap-2 border-b border-border/60 px-4 py-3"
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-medium text-foreground">
              {skill.name}
            </h3>
            {/* Only foreign roots are badged: our own conventions are the norm,
                and this is what tells two same-named skills apart. A linked entry
                sits in the catalog but its files don't, so it is badged with where
                they actually are. */}
            {(isLinked ? skill.link_label : !skill.is_owned_root && skill.root_label) ? (
              <span
                className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                title={
                  isLinked
                    ? `Linked from ${skill.link_target} — edits here change that file`
                    : undefined
                }
              >
                {isLinked ? `↳ ${skill.link_label}` : skill.root_label}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {skill.description || "No description"}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label="Skill actions"
            >
              <DotsThree className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onEdit(skill)}>
              <Pencil className="h-4 w-4" />
              Edit files
            </DropdownMenuItem>
            {/* The same files, in a workspace: an agent that can rewrite them, a
                terminal to run the scripts, and every sibling skill to crib
                from. Local skills open in the repo that owns them; skills in a
                personal folder belong to no workspace, so they stay in the
                editor dialog. */}
            {!isExternal && (
              <DropdownMenuItem onSelect={() => onOpenInWorkspace(skill)}>
                <Sparkle className="h-4 w-4" />
                {isLocal ? "Open in workspace" : "Open in Skill Studio"}
              </DropdownMenuItem>
            )}
            {/* Linking is the way in for a personal skill: it needs no copy, so
                the Studio ends up editing the file Claude Code actually reads. */}
            {isExternal && (
              <DropdownMenuItem onSelect={() => onLink(skill)}>
                <LinkSimple className="h-4 w-4" />
                Link into catalog
              </DropdownMenuItem>
            )}
            {/* Moving is only ours to do in .agents/skills. Anywhere else the
                folder belongs to another tool, so we take a copy. */}
            {(isLocal || isExternal) &&
              (skill.is_owned_root ? (
                <DropdownMenuItem onSelect={() => onPromote(skill)}>
                  <ArrowLineUp className="h-4 w-4" />
                  Move to catalog
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => onCopy(skill)}>
                  <Copy className="h-4 w-4" />
                  Copy to catalog
                </DropdownMenuItem>
              ))}
            <DropdownMenuSeparator />
            {/* Delete has one meaning throughout, linked or not: the folder goes.
                Removing only the link would be undone by the next reconcile, since
                discovery links automatically — a safe-looking click that silently
                did nothing is worse than a loud one that does what it says. The
                confirmation names the absolute path. */}
            <DropdownMenuItem onSelect={() => onDelete(skill)}>
              <Trash className="h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Plain overflow, not `ScrollArea`: its viewport wraps children in a
          `display: table` box, which takes the width of the widest thing in an
          arbitrary SKILL.md (a long URL, an inline path) and drags the property
          list out with it. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Frontmatter that doesn't parse overrides everything below it: the
            assignment, the switch and the layer all still say where this skill
            would apply, and none of them are true while it can't be read. Said
            once, at the top, with the reason and the fix — not as a badge that
            leaves the user to work out why nothing loads. */}
        {skill.error ? (
          <div className="flex items-start gap-2 border-b border-border/60 bg-destructive/10 px-4 py-3">
            <WarningCircle
              weight="fill"
              className="mt-px h-4 w-4 shrink-0 text-destructive"
            />
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-medium text-foreground">
                Excluded from every run — SKILL.md can't be read
              </p>
              <p className="text-xs text-muted-foreground">{skill.error}</p>
              <p className="text-xs text-muted-foreground">
                The frontmatter between the <code>---</code> lines has to be valid
                YAML. A <code>name</code> or <code>description</code> containing a
                colon needs quoting.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-1"
                onClick={() => onEdit(skill)}
              >
                <Pencil className="h-3.5 w-3.5" />
                Fix in editor
              </Button>
            </div>
          </div>
        ) : null}
        <div className="divide-y divide-border/40 py-1">
          <Field
            label="Enabled"
            hint={
              skill.error
                ? "Overridden while SKILL.md can't be read — nothing loads it either way."
                : skill.enabled
                  ? "Loaded by agents in scope. Switch off to keep it without loading it."
                  : "Kept, but loaded by nothing."
            }
          >
            <Switch
              checked={skill.enabled}
              onCheckedChange={(enabled) => onToggle(skill, enabled)}
              aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
            />
          </Field>

          {/* Reach is editable everywhere except a repo, whose skills apply where
              their files are. For a repo skill the limitation is stated with its
              escape hatch next to it, rather than leaving a dead label and no
              route out. */}
          <Field
            label="Applies in"
            hint={
              isLocal
                ? `Lives in ${skill.root || ".agents/skills"} in this repo, so it applies there and nowhere else. Bring it into the catalog to assign it elsewhere.`
                : isExternal
                  ? `Read in place from ${skill.root}, which another tool owns — pointing it somewhere moves no files.`
                  : undefined
            }
          >
            {isLocal ? (
              <>
                <span className="truncate text-xs text-foreground">
                  {workspaceNames.get(skill.workspace_id ?? "") ??
                    "Unknown workspace"}
                </span>
                {moveOrCopy}
              </>
            ) : (
              <SkillScopeMenu skill={skill} workspaces={workspaces} />
            )}
          </Field>

          <Field
            label="Variables"
            hint="Injected into the agent's shell and this skill's scripts when it is in scope. The agent is told the names, never the values."
          >
            <SkillEnvMenu skill={skill} />
          </Field>

          {/* Editing a linked or discovered skill writes to the real file in
              someone else's directory. That is the point, and it is also the one
              thing about it that could surprise you, so it is said in advance
              rather than discovered afterwards. */}
          <Field
            label="Files"
            hint={
              isLinked
                ? `Linked, not copied: saving writes to ${skill.link_target}, which ${skill.link_label} reads too.`
                : undefined
            }
          >
            <span
              className="text-xs text-foreground"
              title={[SKILL_FILE, ...bundled].join("\n")}
            >
              {bundled.length === 0
                ? SKILL_FILE
                : `${SKILL_FILE} + ${bundled.length}`}
            </span>
            <Button variant="outline" size="sm" onClick={() => onEdit(skill)}>
              <Pencil className="h-3.5 w-3.5" />
              Edit files
            </Button>
          </Field>

          <Field label="Folder">
            {folder ? (
              <>
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-1 text-[11px] text-muted-foreground">
                  {folder}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => void copyFolder()}
                  aria-label="Copy folder path"
                  title="Copy folder path"
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">
                Not on disk yet
              </span>
            )}
          </Field>
        </div>

        <Separator />

        {/* The payload: a skill *is* its instructions, and reading them used to
            cost a modal open, a Monaco mount and a modal close.

            Held to a reading measure rather than the pane's full width. This pane
            can be 1100px on a wide window, and SKILL.md is prose — at that width
            the eye loses the line it is on between the right edge and the start of
            the next one. Wide enough that a fenced code block still has room. */}
        <div className="max-w-4xl px-4 py-4">
          {preview.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading SKILL.md…</p>
          ) : preview.isError ? (
            <p className="text-xs text-destructive">
              {preview.error instanceof Error
                ? preview.error.message
                : "Failed to read SKILL.md"}
            </p>
          ) : (
            <MarkdownRenderer
              className={cn(
                "text-foreground",
                !skill.enabled && "opacity-70"
              )}
            >
              {stripFrontmatter(preview.data?.content ?? "").trim() ||
                "_No instructions yet._"}
            </MarkdownRenderer>
          )}
        </div>
      </div>
    </div>
  )
}
