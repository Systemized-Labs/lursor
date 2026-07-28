import { Plus, UploadSimple } from "@phosphor-icons/react"
import { useCallback, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { toast } from "sonner"

import { useDeleteEnvVar, useEnvVars, useResolvedEnv } from "@/api/env-vars"
import { useSkills } from "@/api/skills"
import type { EnvVar } from "@/api/types"
import { useWorkspaces } from "@/api/workspaces"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useBrowserBox } from "@/hooks/use-browser-box"
import { HeaderActions } from "@/pages/customization/header-actions"
import { EnvDetailPanel } from "./env-detail-panel"
import { EnvImportDialog } from "./env-import-dialog"
import { ANYWHERE, EnvRail, type SelectSource } from "./env-rail"
import { candidateLayers } from "./env-scope"
import { EnvVarCreateDialog } from "./env-var-create-dialog"

function matches(envVar: EnvVar, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  return (
    envVar.key.toLowerCase().includes(needle) ||
    envVar.description.toLowerCase().includes(needle)
  )
}

/**
 * The environment manager as a two-pane browser: a dense, filterable rail of every
 * variable beside a detail pane that edits it in place.
 *
 * The rail sections by reach, and the `Applies in:` filter is where the old
 * "Effective environment" card went — picking a workspace narrows the list to what
 * a run there receives and re-labels each row with the layer that won, so
 * provenance is a lens over the list rather than a panel below it.
 *
 * The selection lives in the URL (`?var=<id>`), so a pane is deep-linkable and
 * survives a reload.
 */
export function EnvPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch] = useState("")
  const [appliesIn, setAppliesIn] = useState<string>(ANYWHERE)
  const containerRef = useRef<HTMLDivElement>(null)
  const { height: browserHeight, narrow } = useBrowserBox(containerRef)

  const envVarsQuery = useEnvVars()
  const workspacesQuery = useWorkspaces()
  const skillsQuery = useSkills()
  const deleteVar = useDeleteEnvVar()

  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [toDelete, setToDelete] = useState<EnvVar | undefined>(undefined)
  // With no room for two panes the detail side becomes a sheet, opened by tapping
  // a row. Selection alone must not open it, or a deep link would land you on top
  // of the rail you are trying to read.
  const [detailOpen, setDetailOpen] = useState(false)
  // Bumped by Enter or a double click so the pane remounts with its name field
  // focused; a plain selection must not steal focus from the rail's arrow keys.
  const [focusNameAt, setFocusNameAt] = useState<string | null>(null)

  const envVars = useMemo(() => envVarsQuery.data ?? [], [envVarsQuery.data])
  const workspaces = useMemo(
    () => workspacesQuery.data ?? [],
    [workspacesQuery.data]
  )
  const skills = useMemo(() => skillsQuery.data ?? [], [skillsQuery.data])
  const workspaceNames = useMemo(
    () => new Map(workspaces.map((ws) => [ws.id, ws.name])),
    [workspaces]
  )
  const skillNames = useMemo(
    () => new Map(skills.map((s) => [s.id, s.name])),
    [skills]
  )
  // Skill *slugs*, not names: the resolver reports provenance as `skill:<slug>`.
  const skillSlugs = useMemo(
    () => new Map(skills.map((s) => [s.id, s.slug])),
    [skills]
  )

  const previewWorkspaceId = appliesIn === ANYWHERE ? null : appliesIn
  const resolvedQuery = useResolvedEnv(previewWorkspaceId ?? undefined)
  const resolved = useMemo(
    () =>
      new Map((resolvedQuery.data?.entries ?? []).map((entry) => [entry.key, entry])),
    [resolvedQuery.data]
  )

  const selectedId = searchParams.get("var") ?? undefined
  const selected = envVars.find((v) => v.id === selectedId)

  const filtered = useMemo(() => {
    const bySearch = envVars.filter((envVar) => matches(envVar, search))
    if (!previewWorkspaceId) return bySearch
    // In scope means the resolver reported this key *and* this variable is one of
    // the layers that set it. Two variables can legally share a key at different
    // layers, so a bare key match would show one that this workspace can't see.
    return bySearch.filter((envVar) => {
      const entry = resolved.get(envVar.key)
      if (!entry) return false
      const layers = candidateLayers(envVar, previewWorkspaceId, skillSlugs)
      return layers.some(
        (layer) => layer === entry.source || entry.overridden.includes(layer)
      )
    })
  }, [envVars, search, previewWorkspaceId, resolved, skillSlugs])

  const selectVar = useCallback(
    (envVar: EnvVar | undefined, source: SelectSource) => {
      // Moving off a row drops its pending focus request, so arrowing back later
      // doesn't re-steal focus into the name field.
      setFocusNameAt(null)
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (envVar) next.set("var", envVar.id)
          else next.delete("var")
          return next
        },
        { replace: true }
      )
      if (narrow && source === "pointer" && envVar) setDetailOpen(true)
    },
    [narrow, setSearchParams]
  )

  const activate = useCallback(
    (envVar: EnvVar) => {
      setFocusNameAt(`${envVar.id}:${Date.now()}`)
      if (narrow) setDetailOpen(true)
    },
    [narrow]
  )

  /** Land on a freshly created variable with its reach controls in front of you. */
  const selectNew = useCallback(
    (envVar: EnvVar) => {
      selectVar(envVar, "auto")
      if (narrow) setDetailOpen(true)
    },
    [narrow, selectVar]
  )

  async function confirmDelete() {
    if (!toDelete) return
    try {
      await deleteVar.mutateAsync(toDelete.id)
      toast.success(`${toDelete.key} deleted`)
      setToDelete(undefined)
      // The rail hands the selection to whatever takes the deleted row's place.
      setDetailOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete variable")
    }
  }

  // Rendered into the Customization header rather than a toolbar row of their
  // own, so the browser starts directly under the tab strip.
  const actions = (
    <HeaderActions>
      <Button variant="outline" onClick={() => setImportOpen(true)}>
        <UploadSimple className="h-4 w-4" />
        Import .env
      </Button>
      <Button onClick={() => setCreateOpen(true)}>
        <Plus className="h-4 w-4" />
        New variable
      </Button>
    </HeaderActions>
  )

  const rail = (
    <EnvRail
      envVars={filtered}
      total={envVars.length}
      workspaces={workspaces}
      workspaceNames={workspaceNames}
      skillNames={skillNames}
      skillSlugs={skillSlugs}
      search={search}
      onSearchChange={setSearch}
      appliesIn={appliesIn}
      onAppliesInChange={setAppliesIn}
      resolved={resolved}
      resolving={Boolean(previewWorkspaceId) && resolvedQuery.isLoading}
      selectedId={selectedId}
      onSelect={selectVar}
      onActivate={activate}
    />
  )

  const detail = selected ? (
    <EnvDetailPanel
      // Remounting on activate is what re-runs the name field's autoFocus.
      key={
        focusNameAt?.startsWith(`${selected.id}:`) ? focusNameAt : selected.id
      }
      envVar={selected}
      workspaces={workspaces}
      workspaceNames={workspaceNames}
      skills={skills}
      skillNames={skillNames}
      skillSlugs={skillSlugs}
      previewWorkspaceId={previewWorkspaceId}
      resolvedEntry={resolved.get(selected.key)}
      autoFocusName={Boolean(focusNameAt?.startsWith(`${selected.id}:`))}
      onDelete={setToDelete}
    />
  ) : null

  function clearFilters() {
    setSearch("")
    setAppliesIn(ANYWHERE)
  }

  const filtering = search.trim().length > 0 || appliesIn !== ANYWHERE

  const emptyPane = (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm font-medium text-foreground">
        {filtered.length === 0 ? "Nothing matches these filters" : "No variable selected"}
      </p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {filtered.length === 0
          ? "Widen the search or set Applies in back to Anywhere."
          : "Pick a variable on the left to set its value and choose which runs receive it."}
      </p>
      {filtered.length === 0 && filtering ? (
        <Button variant="outline" size="sm" onClick={clearFilters}>
          Clear filters
        </Button>
      ) : null}
    </div>
  )

  return (
    // The ref is the two-pane measurement: this element is always mounted and
    // always the full width the page has to work with.
    <div ref={containerRef}>
      {actions}

      {envVarsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading variables…</p>
      ) : envVarsQuery.isError ? (
        <p className="text-sm text-destructive">
          {envVarsQuery.error instanceof Error
            ? envVarsQuery.error.message
            : "Failed to load variables"}
        </p>
      ) : envVars.length === 0 ? (
        <EmptyState
          title="No variables yet"
          description="Credentials and config injected into agent runs. Add a variable, point it at the workspaces or skills that need it, and agents get it in their shell without the value ever entering their context."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" />
                New variable
              </Button>
              {/* The realistic first move: these already exist in a `.env`. */}
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <UploadSimple className="h-4 w-4" />
                Import .env
              </Button>
            </div>
          }
        />
      ) : narrow ? (
        // One column: the rail owns the width, the pane arrives as a sheet.
        <div
          style={{ height: browserHeight }}
          className="flex flex-col overflow-hidden rounded-lg border"
        >
          {rail}
        </div>
      ) : (
        <div
          style={{ height: browserHeight }}
          className="overflow-hidden rounded-lg border"
        >
          <ResizablePanelGroup direction="horizontal" autoSaveId="env-browser">
            <ResizablePanel
              defaultSize={28}
              minSize={20}
              className="flex min-w-0 flex-col"
            >
              {rail}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel minSize={40} className="flex min-w-0 flex-col">
              {detail ?? emptyPane}
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}

      <Sheet
        open={narrow && detailOpen && Boolean(selected)}
        onOpenChange={setDetailOpen}
      >
        <SheetContent
          side="right"
          // The sheet's own close button sits top-right, where the pane header's
          // actions menu lives — keep them out of each other's way.
          className="flex w-full flex-col gap-0 p-0 sm:max-w-md [&_[data-slot=env-detail-header]]:pr-12"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{selected?.key ?? "Variable"}</SheetTitle>
          </SheetHeader>
          {detail}
        </SheetContent>
      </Sheet>

      <EnvVarCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={selectNew}
      />

      <EnvImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        workspaces={workspaces}
        existing={envVars}
        onImported={selectNew}
      />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(open) => !open && setToDelete(undefined)}
        title="Delete variable"
        description={
          toDelete
            ? `${toDelete.key} will stop being injected into any run that used it.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        loading={deleteVar.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
