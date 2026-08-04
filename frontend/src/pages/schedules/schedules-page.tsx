import { Plus } from "@phosphor-icons/react"
import { useCallback, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { toast } from "sonner"

import { useAgents } from "@/api/agents"
import { useDeleteSchedule, useSchedules } from "@/api/schedules"
import { useActiveRuns } from "@/api/threads"
import type { Schedule } from "@/api/types"
import { useWorkspaces } from "@/api/workspaces"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
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
import { useOptimisticRuns } from "@/hooks/use-optimistic-runs"
import { ScheduleCreateDialog } from "./schedule-create-dialog"
import { ScheduleDetailPanel } from "./schedule-detail-panel"
import { ScheduleRail, type SelectSource } from "./schedule-rail"

const DESCRIPTION =
  "Prompts that fire on a cron schedule. Each fire opens its own conversation in the workspace you point it at, using that agent's full toolset — with nobody watching. Schedules only fire while Lursor is running; anything due while it was closed is reported, never replayed."

function matches(schedule: Schedule, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  return (
    schedule.name.toLowerCase().includes(needle) ||
    schedule.description.toLowerCase().includes(needle) ||
    schedule.prompt.toLowerCase().includes(needle) ||
    schedule.cron.includes(needle)
  )
}

/**
 * Scheduled jobs as a two-pane browser: a rail of every schedule beside a detail
 * pane that edits one in place, following the environment manager's shape.
 *
 * A top-level destination rather than a workspace tab, because a schedule spans a
 * workspace, an agent and a time — and the question it answers ("what fires
 * tonight, and what did last night's run do?") is inherently cross-workspace.
 *
 * The selection lives in the URL (`?schedule=<id>`), so a pane is deep-linkable and
 * survives a reload.
 */
export function SchedulesPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch] = useState("")
  const containerRef = useRef<HTMLDivElement>(null)
  const { height: browserHeight, narrow } = useBrowserBox(containerRef)

  const schedulesQuery = useSchedules()
  const workspacesQuery = useWorkspaces()
  const agentsQuery = useAgents()
  const deleteSchedule = useDeleteSchedule()

  // The same live-run source the sidebar reads, so a firing schedule reads as
  // working here without any new transport.
  const activeRunsQuery = useActiveRuns()
  const optimisticRuns = useOptimisticRuns()
  const runningThreadIds = useMemo(
    () => new Set([...(activeRunsQuery.data ?? []), ...optimisticRuns]),
    [activeRunsQuery.data, optimisticRuns]
  )

  const [createOpen, setCreateOpen] = useState(false)
  const [toDelete, setToDelete] = useState<Schedule | undefined>(undefined)
  // With no room for two panes the detail side becomes a sheet, opened by tapping
  // a row. Selection alone must not open it, or a deep link would land you on top
  // of the rail you are trying to read.
  const [detailOpen, setDetailOpen] = useState(false)
  // Bumped by Enter or a double click so the pane remounts with its name field
  // focused; a plain selection must not steal focus from the rail's arrow keys.
  const [focusNameAt, setFocusNameAt] = useState<string | null>(null)

  const schedules = useMemo(
    () => schedulesQuery.data ?? [],
    [schedulesQuery.data]
  )
  const allWorkspaces = useMemo(
    () => workspacesQuery.data ?? [],
    [workspacesQuery.data]
  )
  // The Skill Studio (`is_system`) is a fixed destination for authoring skills,
  // not one of your projects — nobody means it when they schedule standing work,
  // and offering it first made it the accidental default. Excluded from the
  // pickers; still resolved for *naming* below, so an existing schedule pointed at
  // it (or at a workspace since deleted) still reads correctly.
  const workspaces = useMemo(
    () => allWorkspaces.filter((ws) => !ws.is_system),
    [allWorkspaces]
  )
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data])

  const workspaceNames = useMemo(
    () => new Map(allWorkspaces.map((ws) => [ws.id, ws.name])),
    [allWorkspaces]
  )
  const agentNames = useMemo(
    () => new Map(agents.map((a) => [a.id, a.name])),
    [agents]
  )

  const selectedId = searchParams.get("schedule") ?? undefined
  const selected = schedules.find((s) => s.id === selectedId)

  const filtered = useMemo(
    () => schedules.filter((schedule) => matches(schedule, search)),
    [schedules, search]
  )

  const selectSchedule = useCallback(
    (schedule: Schedule | undefined, source: SelectSource) => {
      // Moving off a row drops its pending focus request, so arrowing back later
      // doesn't re-steal focus into the name field.
      setFocusNameAt(null)
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (schedule) next.set("schedule", schedule.id)
          else next.delete("schedule")
          return next
        },
        { replace: true }
      )
      if (narrow && source === "pointer" && schedule) setDetailOpen(true)
    },
    [narrow, setSearchParams]
  )

  const activate = useCallback(
    (schedule: Schedule) => {
      setFocusNameAt(`${schedule.id}:${Date.now()}`)
      if (narrow) setDetailOpen(true)
    },
    [narrow]
  )

  /** Land on a freshly created schedule with its full configuration in front of you. */
  const selectNew = useCallback(
    (schedule: Schedule) => {
      selectSchedule(schedule, "auto")
      if (narrow) setDetailOpen(true)
    },
    [narrow, selectSchedule]
  )

  async function confirmDelete() {
    if (!toDelete) return
    try {
      await deleteSchedule.mutateAsync(toDelete.id)
      toast.success(`${toDelete.name} deleted`)
      setToDelete(undefined)
      setDetailOpen(false)
      if (toDelete.id === selectedId) selectSchedule(undefined, "auto")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete schedule")
    }
  }

  const canCreate = workspaces.length > 0 && agents.length > 0

  const rail = (
    <ScheduleRail
      schedules={filtered}
      total={schedules.length}
      workspaceNames={workspaceNames}
      agentNames={agentNames}
      runningThreadIds={runningThreadIds}
      search={search}
      onSearchChange={setSearch}
      selectedId={selectedId}
      onSelect={selectSchedule}
      onActivate={activate}
    />
  )

  const detail = selected ? (
    <ScheduleDetailPanel
      // Remounting on activate is what re-runs the name field's autoFocus.
      key={
        focusNameAt?.startsWith(`${selected.id}:`) ? focusNameAt : selected.id
      }
      schedule={selected}
      workspaces={workspaces}
      workspaceNames={workspaceNames}
      agents={agents}
      runningThreadIds={runningThreadIds}
      autoFocusName={Boolean(focusNameAt?.startsWith(`${selected.id}:`))}
      onDelete={setToDelete}
    />
  ) : null

  const emptyPane = (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm font-medium text-foreground">
        {filtered.length === 0 ? "Nothing matches that search" : "No schedule selected"}
      </p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {filtered.length === 0
          ? "Widen the search to see the rest."
          : "Pick a schedule on the left to change when it fires, what it says, and how far it is allowed to go."}
      </p>
      {filtered.length === 0 && search ? (
        <Button variant="outline" size="sm" onClick={() => setSearch("")}>
          Clear search
        </Button>
      ) : null}
    </div>
  )

  return (
    <div className={embedded ? "space-y-6" : "space-y-6 px-4 py-6 sm:px-0"}>
      {/* See LaiosPage: embedded, the dialog's category rail is the heading. */}
      {embedded ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="min-w-0 text-sm text-muted-foreground">{DESCRIPTION}</p>
          <Button onClick={() => setCreateOpen(true)} disabled={!canCreate}>
            <Plus className="h-4 w-4" />
            New schedule
          </Button>
        </div>
      ) : (
        <PageHeader
          title="Schedules"
          description={DESCRIPTION}
          actions={
            <Button onClick={() => setCreateOpen(true)} disabled={!canCreate}>
              <Plus className="h-4 w-4" />
              New schedule
            </Button>
          }
        />
      )}

      {/* The ref is the two-pane measurement: this element is always mounted and
          always the full width the page has to work with. */}
      <div ref={containerRef}>
        {schedulesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading schedules…</p>
        ) : schedulesQuery.isError ? (
          <p className="text-sm text-destructive">
            {schedulesQuery.error instanceof Error
              ? schedulesQuery.error.message
              : "Failed to load schedules"}
          </p>
        ) : !canCreate ? (
          <EmptyState
            title="A schedule needs a workspace and an agent"
            description="Create at least one of each first — a schedule fires one agent's prompt inside one workspace, so it can't exist without them."
          />
        ) : schedules.length === 0 ? (
          <EmptyState
            title="No schedules yet"
            description="Give an agent standing work: a nightly dependency check, a weekday summary of yesterday's commits, a Monday sweep of failing tests. Each fire opens its own conversation you can read whenever you get to it."
            action={
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" />
                New schedule
              </Button>
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
            <ResizablePanelGroup
              direction="horizontal"
              autoSaveId="schedules-browser"
            >
              <ResizablePanel
                defaultSize={32}
                minSize={22}
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
      </div>

      <Sheet
        open={narrow && detailOpen && Boolean(selected)}
        onOpenChange={setDetailOpen}
      >
        <SheetContent
          side="right"
          // The sheet's own close button sits top-right, where the pane header's
          // actions live — keep them out of each other's way.
          className="flex w-full flex-col gap-0 p-0 sm:max-w-md [&_[data-slot=schedule-detail-header]]:pr-12"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{selected?.name ?? "Schedule"}</SheetTitle>
          </SheetHeader>
          {detail}
        </SheetContent>
      </Sheet>

      <ScheduleCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        workspaces={workspaces}
        agents={agents}
        onCreated={selectNew}
      />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(open) => !open && setToDelete(undefined)}
        title="Delete schedule"
        description={
          toDelete
            ? `${toDelete.name} will stop firing. The conversations it already created are kept in ${workspaceNames.get(toDelete.workspace_id) ?? "its workspace"} and lose their schedule marker.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        loading={deleteSchedule.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
