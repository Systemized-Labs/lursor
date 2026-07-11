import {
  AlertCircle,
  Check,
  ChevronsUpDown,
  Cpu,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Square,
  Trash2,
  X,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  isTransitional,
  type PendingServe,
  useDeleteLaiosConnection,
  useLaiosBudget,
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
} from "@/api/types"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  "Connect to laios daemons to see what's running, spin models up and down, and monitor VRAM — across one or more local or remote nodes."

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
        <PageHeader title="laios" description={DESCRIPTION} actions={action} />
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading connections…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load connections"}
        </p>
      ) : !connections || connections.length === 0 ? (
        <EmptyState
          title="No laios connections yet"
          description="Add a laios daemon URL and master key to manage models from here."
          action={
            <Button onClick={openAddConnection}>
              <Plus className="h-4 w-4" />
              Add connection
            </Button>
          }
        />
      ) : (
        <>
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
    // One bordered unit that groups everything about the active connection —
    // switcher, live status, URL, and its actions — so it reads as a single
    // "current connection" panel rather than scattered controls.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-card px-3 py-2">
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
            <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-60" />
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
              <Trash2 className="h-4 w-4" />
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
      <VramBar connectionId={connection.id} />

      {updating ? (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          updating
        </div>
      ) : null}

      {isLoading && empty ? (
        <p className="text-sm text-muted-foreground">Loading models…</p>
      ) : isError && empty ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load models"}
        </p>
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
          {/* The "serve" action lives as a tile in the grid rather than a header
              button, so it doubles as the empty-state CTA when nothing runs. */}
          <NewModelCard onClick={onServe} />
        </div>
      )}
    </div>
  )
}

// Dashed placeholder tile that kicks off the serve flow. Sits in the models
// grid so adding a model reads as "one more card", and is the sole tile (and
// thus the empty-state prompt) when nothing is running yet.
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
    <Card className={failed ? "flex flex-col" : "flex flex-col ring-1 ring-border"}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="truncate">{pending.name}</CardTitle>
          <Badge
            variant={failed ? "destructive" : "secondary"}
            className="shrink-0 gap-1 font-normal"
          >
            {failed ? (
              <AlertCircle className="h-3 w-3" />
            ) : (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}
            {label}
          </Badge>
        </div>
        <CardDescription className="truncate text-xs">{detail}</CardDescription>
      </CardHeader>
      <CardContent className="mt-auto space-y-3">
        {failed && pending.error ? (
          <p className="text-xs text-destructive">{pending.error}</p>
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
          ? "flex flex-col ring-1 ring-border transition-shadow"
          : "flex flex-col"
      }
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="truncate">{instance.served_name}</CardTitle>
          <Badge
            variant={STATE_VARIANT[instance.status]}
            className="shrink-0 gap-1 font-normal"
          >
            {transitioning ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
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
          <p className="text-xs text-destructive">{instance.error}</p>
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

// A color-coded breakdown of the daemon's VRAM: allocated (models), reserved
// (OS/engine headroom the daemon keeps), and the free remainder. Rendered as one
// segmented bar with per-segment tooltips plus a legend so the numbers are
// legible at a glance and precise on hover.
function VramBar({ connectionId }: { connectionId: string }) {
  const { data } = useLaiosBudget(connectionId)
  if (!data) return null

  const total = Math.max(0, data.total_mb)
  const reserved = Math.max(0, Math.min(data.reserved_mb, total))
  const allocated = Math.max(0, Math.min(data.allocated_mb, total - reserved))
  const available = Math.max(0, total - reserved - allocated)
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0)

  const segments = [
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
    {
      key: "available",
      label: "Available",
      value: available,
      // The free remainder reads as the empty track over the muted bar.
      bar: "bg-transparent",
      dot: "border border-border bg-background",
      hint: "Free VRAM you can serve into",
    },
  ] as const

  return (
    <TooltipProvider delayDuration={100}>
      <div className="space-y-3 rounded-lg border border-border p-4">
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
          {segments.map((s) => (
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
