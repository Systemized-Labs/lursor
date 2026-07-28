import { FileArrowUp } from "@phosphor-icons/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { useCreateEnvVar } from "@/api/env-vars"
import type { EnvVar, Workspace } from "@/api/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/responsive-dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { parseDotEnv } from "@/lib/dotenv"
import { cn } from "@/lib/utils"

/** Reach options that aren't a workspace id. */
const NOWHERE = "nowhere"
const EVERYWHERE = "everywhere"

interface EnvImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaces: Workspace[]
  /** Existing variables, so the preview can flag names that already exist. */
  existing: EnvVar[]
  /** Hand the first import back so the caller can select it in the rail. */
  onImported: (first: EnvVar) => void
}

/**
 * Bulk-add from a `.env` file, by paste or by picking the file.
 *
 * Every credential a workspace needs already exists in a `.env` somewhere, and
 * retyping a dozen of them one modal at a time was the single reason this screen
 * stayed empty. Parsing happens in the browser and the result is shown before
 * anything is written — nothing is imported that you haven't seen on screen.
 *
 * Names that already exist at the chosen layer are unticked up front rather than
 * failing at write time: the backend rejects a duplicate within a layer so that
 * precedence is always well defined, and finding that out one 409 at a time is a
 * worse way to learn it.
 */
export function EnvImportDialog({
  open,
  onOpenChange,
  workspaces,
  existing,
  onImported,
}: EnvImportDialogProps) {
  const [text, setText] = useState("")
  const [reach, setReach] = useState<string>(NOWHERE)
  const [isSecret, setIsSecret] = useState(true)
  const [skipped, setSkipped] = useState<string[]>([])
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const createVar = useCreateEnvVar()

  useEffect(() => {
    if (!open) return
    setText("")
    setReach(NOWHERE)
    setIsSecret(true)
    setSkipped([])
    setImporting(false)
  }, [open])

  const entries = useMemo(() => parseDotEnv(text), [text])

  /** Names already taken at the layer being imported into. */
  const clashes = useMemo(() => {
    const taken = new Set(
      existing
        .filter((v) =>
          reach === EVERYWHERE
            ? v.is_global
            : reach === NOWHERE
              ? false
              : v.workspace_ids.includes(reach)
        )
        .map((v) => v.key)
    )
    return new Set(entries.filter((e) => taken.has(e.key)).map((e) => e.key))
  }, [entries, existing, reach])

  /**
   * Names that exist at *some* layer but not this one. Legal — the whole point of
   * the precedence chain is a per-workspace value over a global fallback — so
   * these stay ticked, but they are worth saying: it is equally often a typo.
   */
  const elsewhere = useMemo(() => {
    const all = new Set(existing.map((v) => v.key))
    return new Set(
      entries.filter((e) => all.has(e.key) && !clashes.has(e.key)).map((e) => e.key)
    )
  }, [entries, existing, clashes])

  // Clashes are unticked automatically, but a name is only auto-skipped once —
  // re-ticking one and changing an unrelated setting must not silently untick it
  // again. `skipped` holds only what the user turned off by hand plus the clashes
  // they have not overridden.
  const [overridden, setOverridden] = useState<string[]>([])
  useEffect(() => {
    setOverridden([])
  }, [reach])

  const selected = useMemo(
    () =>
      entries.filter(
        (e) =>
          !skipped.includes(e.key) &&
          (!clashes.has(e.key) || overridden.includes(e.key))
      ),
    [entries, skipped, clashes, overridden]
  )

  function toggle(key: string) {
    if (clashes.has(key)) {
      setOverridden((prev) =>
        prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
      )
      return
    }
    setSkipped((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    )
  }

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = "" // allow re-picking the same file
    if (!file) return
    try {
      setText(await file.text())
    } catch {
      toast.error("Couldn't read that file")
    }
  }

  async function handleImport() {
    if (selected.length === 0) return
    setImporting(true)
    const created: EnvVar[] = []
    const failed: string[] = []
    for (const entry of selected) {
      try {
        created.push(
          await createVar.mutateAsync({
            key: entry.key,
            value: entry.value,
            is_secret: isSecret,
            is_global: reach === EVERYWHERE,
            workspace_ids:
              reach === EVERYWHERE || reach === NOWHERE ? [] : [reach],
          })
        )
      } catch {
        failed.push(entry.key)
      }
    }
    setImporting(false)

    if (created.length > 0) {
      toast.success(
        `Imported ${created.length} variable${created.length === 1 ? "" : "s"}${
          failed.length > 0 ? ` — ${failed.length} failed` : ""
        }`
      )
      onOpenChange(false)
      onImported(created[0])
    } else {
      toast.error(`Couldn't import ${failed.join(", ")}`)
    }
  }

  const reachLabel =
    reach === EVERYWHERE
      ? "everywhere"
      : reach === NOWHERE
        ? null
        : (workspaces.find((ws) => ws.id === reach)?.name ?? "a workspace")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from .env</DialogTitle>
          <DialogDescription>
            Paste the file, or pick it. Parsing happens here in the browser and
            nothing is stored until you import — multi-line values and{" "}
            <code>${"{VAR}"}</code> interpolation aren't read, so check the list
            below.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="env-import-text">File contents</Label>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => void handleFile(e)}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <FileArrowUp className="h-3.5 w-3.5" />
                Choose a file
              </Button>
            </div>
            <Textarea
              id="env-import-text"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"STRIPE_SECRET_KEY=sk_live_…\nDATABASE_URL=postgres://…"}
              className="min-h-[140px] font-mono text-xs"
              spellCheck={false}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="env-import-reach">Apply to</Label>
            <Select value={reach} onValueChange={setReach}>
              <SelectTrigger id="env-import-reach">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-[50vh]">
                <SelectItem value={NOWHERE}>Nothing yet — decide later</SelectItem>
                <SelectItem value={EVERYWHERE}>Every workspace</SelectItem>
                {workspaces.map((ws) => (
                  <SelectItem key={ws.id} value={ws.id}>
                    {ws.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {reach === EVERYWHERE
                ? "Every run, in every workspace, will receive these. Narrow any of them afterwards."
                : reachLabel
                  ? `Runs in ${reachLabel} will receive these. Change any of them afterwards.`
                  : "They'll land under “Not applied”, receiving nothing, until you give them a reach."}
            </p>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="env-import-secret" className="text-foreground">
                Import as secrets
              </Label>
              <p className="text-xs text-muted-foreground">
                A `.env` is usually all credentials. Off treats them as readable
                config — you can flip any of them afterwards.
              </p>
            </div>
            <Switch
              id="env-import-secret"
              checked={isSecret}
              onCheckedChange={setIsSecret}
            />
          </div>

          {text.trim() ? (
            <div className="grid gap-2">
              <Label>
                Found {entries.length} variable{entries.length === 1 ? "" : "s"}
                {clashes.size > 0
                  ? ` · ${clashes.size} already ${clashes.size === 1 ? "exists" : "exist"}`
                  : ""}
              </Label>
              {entries.length === 0 ? (
                <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                  Nothing here parsed as <code>KEY=value</code>.
                </p>
              ) : (
                <div className="max-h-56 overflow-y-auto rounded-md border">
                  {entries.map((entry) => {
                    const clash = clashes.has(entry.key)
                    const on = selected.some((s) => s.key === entry.key)
                    return (
                      <label
                        key={entry.key}
                        className="flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 last:border-b-0 hover:bg-accent/40"
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(entry.key)}
                          className="h-3.5 w-3.5 shrink-0 accent-primary"
                        />
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate font-mono text-xs",
                            on ? "text-foreground" : "text-muted-foreground"
                          )}
                        >
                          {entry.key}
                        </span>
                        {clash ? (
                          <span className="shrink-0 text-[10px] text-destructive">
                            already applied {reachLabel}
                          </span>
                        ) : (
                          <>
                            {elsewhere.has(entry.key) ? (
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                name already in use
                              </span>
                            ) : null}
                            {/* An empty value says so even when importing as
                                secrets — dots over nothing would claim a
                                credential got imported when none did. */}
                            <span className="max-w-[40%] shrink-0 truncate font-mono text-[10px] text-muted-foreground">
                              {!entry.value
                                ? "(empty)"
                                : isSecret
                                  ? "••••••••"
                                  : entry.value}
                            </span>
                          </>
                        )}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={importing}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleImport()}
            disabled={importing || selected.length === 0}
          >
            {importing
              ? "Importing…"
              : selected.length === 0
                ? "Import"
                : `Import ${selected.length} variable${selected.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
