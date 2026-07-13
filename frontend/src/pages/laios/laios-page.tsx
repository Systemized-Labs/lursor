import {
  WarningCircle,
  CaretDown,
  Check,
  CaretUpDown,
  Cpu,
  FileText,
  Pencil,
  Plus,
  Square,
  Stack,
  Trash,
  X,
} from "@phosphor-icons/react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  isTransitional,
  type PendingServe,
  useDeleteLaiosConnection,
  useLaiosBudget,
  useLaiosCluster,
  useLaiosConnections,
  useLaiosInstances,
  useLaiosStatus,
  useServeManager,
  useStopInstance,
} from "@/api/laios"
import type {
  LaiosConnection,
  LaiosInstance,
  LaiosInstanceStatus,
  LaiosNodeResources,
} from "@/api/types"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { InstanceLogsDialog } from "./instance-logs-dialog"
import { LaiosConnectionDialog } from "./laios-connection-dialog"
import { LaiosStatusBadge } from "./laios-status-badge"
import { ServeModelDialog } from "./serve-model-dialog"

const DESCRIPTION =
  "Connect to LAIOS daemons to see what's running, spin models up and down, and monitor VRAM — across one or more local or remote nodes."

const ACTIVE_KEY = "laios.activeConnectionId"

const MIB_PER_GB = 1024

function fmtGb(mib: number): string {
  return `${(mib / MIB_PER_GB).toFixed(1)} GB`
}

// Idle/steady states use muted styling; active work reads as "in progress";
// only running is affirmative and failed is an error. Badge has no warning/info
// variant, so transitional states use the neutral secondary variant.
const STATE_VARIANT: Record<
  LaiosInstanceStatus,
  "success" | "secondary" | "destructive" | "outline"
> = {
  running: "success",
  starting: "secondary",
  pulling: "secondary",
  pending: "secondary",
  stopping: "secondary",
  stopped: "outline",
  failed: "destructive",
}

export function LaiosPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: connections, isLoading, isError, error } = useLaiosConnections()

  const [activeId, setActiveId] = useState<string | undefined>(
    () => localStorage.getItem(ACTIVE_KEY) ?? undefined
  )
  const [connFormOpen, setConnFormOpen] = useState(false)
  const [editingConn, setEditingConn] = useState<LaiosConnection | undefined>()
  const [connToDelete, setConnToDelete] = useState<LaiosConnection | undefined>()
  const [serveOpen, setServeOpen] = useState(false)
  const [logsFor, setLogsFor] = useState<LaiosInstance | undefined>()
  const [toStop, setToStop] = useState<LaiosInstance | undefined>()

  // Keep the active selection valid as connections load / change.
  useEffect(() => {
    if (!connections) return
    const stillExists = connections.some((c) => c.id === activeId)
    if (!stillExists) {
      const next = connections[0]?.id
      setActiveId(next)
    }
  }, [connections, activeId])

  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_KEY, activeId)
  }, [activeId])

  const activeConnection = useMemo(
    () => connections?.find((c) => c.id === activeId),
    [connections, activeId]
  )

  // Owns the download → start lifecycle so in-flight serves stay visible under
  // Models even after the serve dialog closes.
  const serveManager = useServeManager(activeConnection?.id)

  const deleteConnection = useDeleteLaiosConnection()

  function openAddConnection() {
    setEditingConn(undefined)
    setConnFormOpen(true)
  }

  async function confirmDeleteConnection() {
    if (!connToDelete) return
    try {
      await deleteConnection.mutateAsync(connToDelete.id)
      toast.success("Connection removed")
      setConnToDelete(undefined)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove connection"
      )
    }
  }

  const action = (
    <Button onClick={openAddConnection}>
      <Plus className="h-4 w-4" />
      Add connection
    </Button>
  )

  return (
    <div className="space-y-6">
      {/* Embedded under Settings the tab already provides the heading, so we skip
          the description/add row entirely — adding a connection lives in the
          switcher and the empty state. Standalone still gets a page header. */}
      {embedded ? null : (
        <PageHeader title="LAIOS" description={DESCRIPTION} actions={action} />
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading connections…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load connections"}
        </p>
      ) : !connections || connections.length === 0 ? (
        <EmptyState
          title="No LAIOS connections yet"
          description="Add a LAIOS daemon URL and master key to manage models from here."
          action={
            <Button onClick={openAddConnection}>
              <Plus className="h-4 w-4" />
              Add connection
            </Button>
          }
        />
      ) : (
        <>
          {/* One node card: the connection switcher/status as its header and the
              node's GPU memory as its body — VRAM belongs to the selected node. */}
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <ConnectionBar
              connections={connections}
              activeId={activeConnection?.id}
              onSelect={setActiveId}
              onAdd={openAddConnection}
              onEdit={(c) => {
                setEditingConn(c)
                setConnFormOpen(true)
              }}
              onDelete={setConnToDelete}
            />
            {activeConnection ? (
              <>
                <VramBar connectionId={activeConnection.id} />
                <ClusterPanel connectionId={activeConnection.id} />
              </>
            ) : null}
          </div>

          {activeConnection ? (
            <ConnectionPanel
              connection={activeConnection}
              pending={serveManager.pending}
              onDismissPending={serveManager.dismiss}
              onServe={() => setServeOpen(true)}
              onLogs={setLogsFor}
              onStop={setToStop}
            />
          ) : null}
        </>
      )}

      <LaiosConnectionDialog
        open={connFormOpen}
        onOpenChange={setConnFormOpen}
        connection={editingConn}
      />

      {activeConnection ? (
        <>
          <ServeModelDialog
            open={serveOpen}
            onOpenChange={setServeOpen}
            connectionId={activeConnection.id}
            onServe={serveManager.start}
          />
          <InstanceLogsDialog
            open={Boolean(logsFor)}
            onOpenChange={(open) => !open && setLogsFor(undefined)}
            connectionId={activeConnection.id}
            instance={logsFor}
          />
          <StopInstanceDialog
            connectionId={activeConnection.id}
            instance={toStop}
            onDone={() => setToStop(undefined)}
          />
        </>
      ) : null}

      <ConfirmDialog
        open={Boolean(connToDelete)}
        onOpenChange={(open) => !open && setConnToDelete(undefined)}
        title="Remove connection"
        description={
          connToDelete
            ? `This removes "${connToDelete.name}" from Lursor. The daemon and any running models are not affected.`
            : undefined
        }
        confirmLabel="Remove"
        destructive
        loading={deleteConnection.isPending}
        onConfirm={confirmDeleteConnection}
      />
    </div>
  )
}

// A small reachability dot for a connection, driven by the same polled status
// probe as the detailed badge. Lets the switcher show health at a glance without
// opening each connection.
function ConnStatusDot({ connectionId }: { connectionId: string }) {
  const { data, isError } = useLaiosStatus(connectionId)
  const tone = isError
    ? "bg-destructive"
    : data?.status === "ok"
      ? "bg-success"
      : data
        ? // Reachable but not ok (e.g. unauthorized) is a warning, not a hard down.
          data.reachable
          ? "bg-warning"
          : "bg-destructive"
        : "bg-muted-foreground/40"
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", tone)} />
}

function ConnectionBar({
  connections,
  activeId,
  onSelect,
  onAdd,
  onEdit,
  onDelete,
}: {
  connections: LaiosConnection[]
  activeId: string | undefined
  onSelect: (id: string) => void
  onAdd: () => void
  onEdit: (c: LaiosConnection) => void
  onDelete: (c: LaiosConnection) => void
}) {
  const active = connections.find((c) => c.id === activeId)
  return (
    // The header of the node card: switcher, live status, URL, and actions for
    // the active connection. The card body (its GPU memory) sits directly below.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
      {/* A proper switcher instead of a bare select: each entry shows its live
          reachability and URL, and adding a connection lives in the same menu. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="-ml-1 h-8 justify-start gap-2 px-2 font-medium"
          >
            <span className="truncate">
              {active?.name ?? "Select a connection"}
            </span>
            <CaretUpDown className="h-4 w-4 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Connections
          </DropdownMenuLabel>
          {connections.map((c) => (
            <DropdownMenuItem
              key={c.id}
              onSelect={() => onSelect(c.id)}
              className="gap-2"
            >
              <ConnStatusDot connectionId={c.id} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-foreground">{c.name}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {c.base_url}
                  {c.has_master_key ? "" : " · no key"}
                </div>
              </div>
              {c.id === activeId ? (
                <Check className="h-4 w-4 shrink-0 text-foreground" />
              ) : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onAdd} className="gap-2">
            <Plus className="h-4 w-4" />
            Add connection
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {active ? (
        <>
          <Separator orientation="vertical" className="hidden h-5 sm:block" />
          <LaiosStatusBadge connectionId={active.id} />
          <span className="hidden truncate font-mono text-xs text-muted-foreground lg:inline">
            {active.base_url}
          </span>

          <div className="ml-auto flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              onClick={() => onEdit(active)}
              aria-label="Edit connection"
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              onClick={() => onDelete(active)}
              aria-label="Remove connection"
            >
              <Trash className="h-4 w-4" />
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}

function ConnectionPanel({
  connection,
  pending,
  onDismissPending,
  onServe,
  onLogs,
  onStop,
}: {
  connection: LaiosConnection
  pending: PendingServe[]
  onDismissPending: (key: string) => void
  onServe: () => void
  onLogs: (i: LaiosInstance) => void
  onStop: (i: LaiosInstance) => void
}) {
  const {
    data: instances,
    isLoading,
    isError,
    error,
  } = useLaiosInstances(connection.id)

  // A stopped model is gone — don't keep it in the "running" view. Keep failed
  // ones (their error is actionable) and sort active first, failed last.
  const rank = (s: LaiosInstance["status"]) =>
    s === "running" ? 0 : s === "failed" ? 2 : 1
  const visible = (instances ?? [])
    .filter((i) => i.status !== "stopped")
    .sort((a, b) => rank(a.status) - rank(b.status))
  const updating =
    pending.some((p) => p.phase !== "failed") ||
    visible.some((i) => isTransitional(i.status))
  const empty = visible.length === 0 && pending.length === 0

  return (
    <div className="space-y-5">
      {updating ? (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <DotGridLoader size="2xs" />
          updating
        </div>
      ) : null}

      {isLoading && empty ? (
        <p className="text-sm text-muted-foreground">Loading models…</p>
      ) : isError && empty ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load models"}
        </p>
      ) : empty ? (
        // Nothing running — a slim full-width CTA rather than a lone tall tile
        // stranded in a wide grid.
        <ServeModelBar onClick={onServe} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* In-flight serves first — a downloading/starting model has no daemon
              instance yet, so it lives only as a pending card until serve. */}
          {pending.map((p) => (
            <PendingCard
              key={p.key}
              pending={p}
              onDismiss={() => onDismissPending(p.key)}
            />
          ))}
          {visible.map((inst) => (
            <InstanceCard
              key={inst.id}
              instance={inst}
              onLogs={() => onLogs(inst)}
              onStop={() => onStop(inst)}
            />
          ))}
          {/* Alongside real models the serve action is one more tile in the
              grid; on its own (empty) it becomes the slim bar above instead. */}
          <NewModelCard onClick={onServe} />
        </div>
      )}
    </div>
  )
}

// The empty-state serve prompt: a slim full-width dashed bar. Used when nothing
// is running so the CTA doesn't stretch into a lone oversized tile; once models
// exist the grid uses NewModelCard instead.
function ServeModelBar({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-3 text-sm font-medium text-muted-foreground transition-colors hover:border-foreground/40 hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <Plus className="h-4 w-4" />
      Serve a model
    </button>
  )
}

// Dashed placeholder tile that kicks off the serve flow. Sits in the models
// grid alongside running models so adding one reads as "one more card".
function NewModelCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[11rem] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:border-foreground/40 hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <Plus className="h-5 w-5" />
      <span className="text-sm font-medium">Serve a model</span>
    </button>
  )
}

function PendingCard({
  pending,
  onDismiss,
}: {
  pending: PendingServe
  onDismiss: () => void
}) {
  const failed = pending.phase === "failed"
  const label =
    pending.phase === "pulling"
      ? "downloading"
      : pending.phase === "starting"
        ? "starting"
        : "failed"
  const detail =
    pending.phase === "pulling"
      ? "Downloading weights…"
      : pending.phase === "starting"
        ? "Starting engine…"
        : "Failed to start"
  return (
    <Card
      className={
        failed ? "flex h-full flex-col" : "flex h-full flex-col ring-1 ring-border"
      }
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="truncate">{pending.name}</CardTitle>
          <Badge
            variant={failed ? "destructive" : "secondary"}
            className="shrink-0 gap-1 font-normal"
          >
            {failed ? (
              <WarningCircle className="h-3 w-3" />
            ) : (
              <DotGridLoader size="2xs" />
            )}
            {label}
          </Badge>
        </div>
        <CardDescription className="truncate text-xs">{detail}</CardDescription>
      </CardHeader>
      <CardContent className="mt-auto space-y-3">
        {failed && pending.error ? (
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-destructive">
            {pending.error}
          </p>
        ) : null}
        {failed ? (
          <Button variant="outline" size="sm" onClick={onDismiss}>
            <X className="h-4 w-4" />
            Dismiss
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}

// A labelled key/value pair in the instance card's stat row.
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="truncate text-sm font-medium text-foreground">{value}</div>
    </div>
  )
}

function InstanceCard({
  instance,
  onLogs,
  onStop,
}: {
  instance: LaiosInstance
  onLogs: () => void
  onStop: () => void
}) {
  const terminal =
    instance.status === "stopped" || instance.status === "failed"
  const transitioning = isTransitional(instance.status)
  return (
    <Card
      className={
        transitioning
          ? "flex h-full flex-col ring-1 ring-border transition-shadow"
          : "flex h-full flex-col"
      }
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="truncate">{instance.served_name}</CardTitle>
          <Badge
            variant={STATE_VARIANT[instance.status]}
            className="shrink-0 gap-1 font-normal"
          >
            {transitioning ? <DotGridLoader size="2xs" /> : null}
            {instance.status}
          </Badge>
        </div>
        <CardDescription className="truncate font-mono text-xs">
          {instance.endpoint}
        </CardDescription>
      </CardHeader>
      <CardContent className="mt-auto space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Engine" value={instance.engine} />
          <Stat label="Context" value={instance.max_model_len.toLocaleString()} />
          <Stat label="VRAM" value={fmtGb(instance.vram_allocated_mb)} />
        </div>
        {instance.model_id ? (
          <p className="truncate font-mono text-xs text-muted-foreground">
            {instance.model_id}
          </p>
        ) : null}
        {instance.error ? (
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-destructive">
            {instance.error}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onLogs}>
            <FileText className="h-4 w-4" />
            Logs
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onStop}
            disabled={terminal || instance.status === "stopping"}
          >
            <Square className="h-4 w-4" />
            Stop
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

type VramSegment = {
  key: string
  label: string
  value: number
  bar: string
  dot: string
  hint: string
}

// A color-coded breakdown of VRAM — what's in use vs. the free remainder —
// rendered as one segmented bar with per-segment tooltips plus a legend so the
// numbers are legible at a glance and precise on hover.
//
// Scope follows the setup. In a cluster (more than one node known) the bar
// reflects the whole cluster: aggregate free/total across online nodes, so the
// headline matches the capacity you can actually serve into. The per-node
// breakdown lives in the Cluster panel below, and since only free/total are
// known per node, the used portion is a single aggregate segment. On a single
// node the daemon's budget gives the finer allocated/reserved split.
function VramBar({ connectionId }: { connectionId: string }) {
  const { data: budget } = useLaiosBudget(connectionId)
  const { data: cluster } = useLaiosCluster(connectionId)

  const res = cluster?.resources
  const isCluster = !!res && res.total_nodes_known > 1

  let total: number
  let available: number
  let usedSegments: VramSegment[]

  if (isCluster && res) {
    total = Math.max(0, res.total_vram_mb)
    available = Math.max(0, Math.min(res.free_vram_mb, total))
    usedSegments = [
      {
        key: "inUse",
        label: "In use",
        value: Math.max(0, total - available),
        bar: "bg-primary",
        dot: "bg-primary",
        hint: "VRAM held across all online nodes",
      },
    ]
  } else {
    if (!budget) return null
    total = Math.max(0, budget.total_mb)
    const reserved = Math.max(0, Math.min(budget.reserved_mb, total))
    const allocated = Math.max(0, Math.min(budget.allocated_mb, total - reserved))
    available = Math.max(0, total - reserved - allocated)
    usedSegments = [
      {
        key: "allocated",
        label: "Allocated",
        value: allocated,
        bar: "bg-primary",
        dot: "bg-primary",
        hint: "Held by running models",
      },
      {
        key: "reserved",
        label: "Reserved",
        value: reserved,
        bar: "bg-warning",
        dot: "bg-warning",
        hint: "Headroom the daemon keeps for the OS and engine",
      },
    ]
  }

  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0)

  const segments: VramSegment[] = [
    ...usedSegments,
    {
      key: "available",
      label: "Available",
      value: available,
      // The free remainder reads as the empty track over the muted bar.
      bar: "bg-transparent",
      dot: "border border-border bg-background",
      hint: "Free VRAM you can serve into",
    },
  ]

  return (
    <TooltipProvider delayDuration={100}>
      <div className="space-y-3 p-4">
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            GPU memory
          </div>
          <div className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {fmtGb(available)}
            </span>{" "}
            free of {fmtGb(total)}
          </div>
        </div>

        {isCluster && res ? (
          <div className="-mt-1.5 text-xs text-muted-foreground">
            Aggregate across {res.node_count} online node
            {res.node_count === 1 ? "" : "s"}
          </div>
        ) : null}

        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
          {segments
            .filter((s) => s.value > 0)
            .map((s) => (
              <Tooltip key={s.key}>
                <TooltipTrigger asChild>
                  <div
                    className={cn("h-full", s.bar)}
                    style={{
                      // Available grows to fill so rounding never leaves a gap.
                      flex:
                        s.key === "available" ? "1 1 0%" : `0 0 ${pct(s.value)}%`,
                    }}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  <div className="font-medium">{s.label}</div>
                  <div>
                    {fmtGb(s.value)} · {pct(s.value).toFixed(0)}%
                  </div>
                  <div className="text-primary-foreground/70">{s.hint}</div>
                </TooltipContent>
              </Tooltip>
            ))}
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          {/* "Available" is already stated top-right ("… free of …"), so the
              legend only needs the used segments. */}
          {segments
            .filter((s) => s.key !== "available")
            .map((s) => (
            <div key={s.key} className="flex items-center gap-1.5 text-xs">
              <span className={cn("h-2.5 w-2.5 rounded-full", s.dot)} />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="font-medium text-foreground">
                {fmtGb(s.value)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </TooltipProvider>
  )
}

// Multi-node rollup. Rendered only when the daemon reports more than one node
// so single-node setups stay uncluttered. Totals cover online nodes only; a
// stale/offline worker is listed (dimmed) but excluded from the aggregate, so
// the numbers reflect capacity you can actually serve into right now.
function ClusterPanel({ connectionId }: { connectionId: string }) {
  const { data } = useLaiosCluster(connectionId)
  const [open, setOpen] = useState(false)
  const res = data?.resources
  if (!res || res.total_nodes_known <= 1) return null

  return (
    // A section within the node card (not its own boxed panel) — a top border
    // separates it from the VRAM bar. Collapsed by default so the card stays
    // compact; the header keeps the at-a-glance node/GPU summary visible and
    // expands to the per-node breakdown. The aggregate free/total lives once,
    // in the GPU memory header directly above, so it isn't repeated here.
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-baseline justify-between gap-2 p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <CaretDown
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground transition-transform",
              open ? "rotate-0" : "-rotate-90"
            )}
          />
          <Stack className="h-4 w-4 text-muted-foreground" />
          Cluster
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {res.node_count}
          </span>{" "}
          of {res.total_nodes_known} node{res.total_nodes_known === 1 ? "" : "s"}{" "}
          online · {res.total_gpus} GPU{res.total_gpus === 1 ? "" : "s"}
        </div>
      </button>

      {open ? (
        <div className="divide-y divide-border px-4 pb-4">
          {res.nodes.map((n) => (
            <ClusterNodeRow key={n.node_id} node={n} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ClusterNodeRow({ node }: { node: LaiosNodeResources }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 py-2 text-xs",
        !node.online && "opacity-50"
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            node.online ? "bg-success" : "bg-muted-foreground"
          )}
        />
        <span className="truncate font-medium text-foreground">
          {node.name}
        </span>
        <Badge variant="outline" className="shrink-0 font-normal">
          {node.role}
        </Badge>
        <span className="text-muted-foreground">{node.status}</span>
      </div>
      <div className="shrink-0 text-muted-foreground">
        {node.gpus} GPU{node.gpus === 1 ? "" : "s"} ·{" "}
        <span className="font-medium text-foreground">
          {fmtGb(node.free_vram_mb)}
        </span>{" "}
        free / {fmtGb(node.total_vram_mb)}
      </div>
    </div>
  )
}

function StopInstanceDialog({
  connectionId,
  instance,
  onDone,
}: {
  connectionId: string
  instance: LaiosInstance | undefined
  onDone: () => void
}) {
  const stop = useStopInstance(connectionId)

  async function confirm() {
    if (!instance) return
    try {
      await stop.mutateAsync(instance.id)
      toast.success(`Stopping ${instance.served_name}`)
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to stop model")
    }
  }

  return (
    <ConfirmDialog
      open={Boolean(instance)}
      onOpenChange={(open) => !open && onDone()}
      title="Stop model"
      description={
        instance
          ? `Stop "${instance.served_name}"? This tears down the engine and frees its VRAM.`
          : undefined
      }
      confirmLabel="Stop"
      destructive
      loading={stop.isPending}
      onConfirm={confirm}
    />
  )
}
