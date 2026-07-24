import {
  WarningCircle,
  CaretDown,
  Check,
  CaretUpDown,
  Copy,
  Cpu,
  FileText,
  Gear,
  HardDrives,
  Lightning,
  Pencil,
  Plus,
  ShieldCheck,
  Square,
  Stack,
  Trash,
  X,
} from "@phosphor-icons/react"
import { type ComponentType, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  isTransitional,
  type DownloadCard,
  useDaemonReconnect,
  useDeleteLaiosConnection,
  useLaiosBudget,
  useLaiosCluster,
  useLaiosClusterToken,
  useLaiosConnections,
  useLaiosInstances,
  useLaiosMetrics,
  useLaiosStatus,
  useRemoveInstance,
  useRemoveWorker,
  useServeManager,
  useStopInstance,
} from "@/api/laios"
import type {
  LaiosConnection,
  LaiosInstance,
  LaiosInstanceStatus,
  LaiosModelMetrics,
  LaiosNodeResources,
} from "@/api/types"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
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
import { DaemonDialog } from "./daemon-dialog"
import { InstanceLogsDialog } from "./instance-logs-dialog"
import { LaiosConnectionDialog } from "./laios-connection-dialog"
import { LaiosStatusBadge } from "./laios-status-badge"
import { ModelLibrary } from "./model-library"

const DESCRIPTION =
  "Connect to LAIOS daemons to see what's running, spin models up and down, and monitor VRAM — across one or more local or remote nodes."

const ACTIVE_KEY = "laios.activeConnectionId"

const MIB_PER_GB = 1024

function fmtGb(mib: number): string {
  return `${(mib / MIB_PER_GB).toFixed(1)} GB`
}

// Download progress is reported in raw bytes by the daemon; render it in the
// largest sensible unit so a multi-GB pull reads cleanly.
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
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

export function LaiosPage() {
  const { data: connections, isLoading, isError, error } = useLaiosConnections()

  const [activeId, setActiveId] = useState<string | undefined>(
    () => localStorage.getItem(ACTIVE_KEY) ?? undefined
  )
  const [connFormOpen, setConnFormOpen] = useState(false)
  const [editingConn, setEditingConn] = useState<LaiosConnection | undefined>()
  const [connToDelete, setConnToDelete] = useState<LaiosConnection | undefined>()
  const [daemonOpen, setDaemonOpen] = useState(false)
  const [logsFor, setLogsFor] = useState<LaiosInstance | undefined>()
  const [toStop, setToStop] = useState<LaiosInstance | undefined>()
  const [toRemove, setToRemove] = useState<LaiosInstance | undefined>()

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

  // Owns the daemon-restart reconnect indicator at the page level, so it
  // outlives the (now-closing) daemon dialog that triggers the restart.
  const reconnect = useDaemonReconnect()

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

  const hasConnections = Boolean(connections && connections.length > 0)

  return (
    <div className="space-y-6">
      {/* The add-connection action only belongs in the header once at least one
          connection exists; before that the intro below carries the primary
          call to action so the empty page isn't split between two CTAs. */}
      <PageHeader
        title="LAIOS"
        description={DESCRIPTION}
        actions={hasConnections ? action : undefined}
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading connections…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load connections"}
        </p>
      ) : !connections || connections.length === 0 ? (
        <LaiosIntro onAddConnection={openAddConnection} />
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
              onManage={() => setDaemonOpen(true)}
              onDelete={setConnToDelete}
              reconnectingId={reconnect.reconnectingId}
            />
            {activeConnection ? (
              <>
                <VramBar connectionId={activeConnection.id} />
                <ClusterPanel connectionId={activeConnection.id} />
              </>
            ) : null}
          </div>

          {activeConnection ? (
            <>
              <ConnectionPanel
                connection={activeConnection}
                downloads={serveManager.downloads}
                onDismissDownload={serveManager.dismiss}
                onCancelDownload={serveManager.cancel}
                onLogs={setLogsFor}
                onStop={setToStop}
                onRemove={setToRemove}
              />
              {/* Browsing + serving lives inline, right beneath what's running —
                  the persistent VRAM bar above answers "will it fit". */}
              <ModelLibrary
                connectionId={activeConnection.id}
                onServe={serveManager.start}
              />
            </>
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
          <InstanceLogsDialog
            open={Boolean(logsFor)}
            onOpenChange={(open) => !open && setLogsFor(undefined)}
            connectionId={activeConnection.id}
            instance={logsFor}
          />
          <DaemonDialog
            open={daemonOpen}
            onOpenChange={setDaemonOpen}
            connectionId={activeConnection.id}
            onRestartInitiated={() => reconnect.start(activeConnection.id)}
          />
          <StopInstanceDialog
            connectionId={activeConnection.id}
            instance={toStop}
            onDone={() => setToStop(undefined)}
          />
          <RemoveInstanceDialog
            connectionId={activeConnection.id}
            instance={toRemove}
            onDone={() => setToRemove(undefined)}
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

// Shown before any daemon is connected: a short brief on what LAIOS is and why
// you'd wire it in, so the empty page teaches rather than just prompting. The
// add-connection CTA lives here (not the header) while the page is empty.
const INTRO_POINTS: ReadonlyArray<{
  icon: ComponentType<{ className?: string }>
  title: string
  body: string
}> = [
  {
    icon: Lightning,
    title: "Serve models on demand",
    body: "Spin open models up and down from here and use them like any other OpenAI-compatible provider.",
  },
  {
    icon: HardDrives,
    title: "See your VRAM",
    body: "Live GPU memory and what's holding it, across one or more local or remote nodes.",
  },
  {
    icon: ShieldCheck,
    title: "Stays on your hardware",
    body: "Inference runs on your own GPUs — your prompts and weights never leave the box.",
  },
]

function LaiosIntro({ onAddConnection }: { onAddConnection: () => void }) {
  return (
    <div className="rounded-lg border border-border bg-card p-6 sm:p-8">
      <div className="flex max-w-2xl flex-col gap-2">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-foreground">
          <Cpu className="h-5 w-5" />
        </div>
        <h2 className="mt-2 text-lg font-semibold text-foreground">
          Run models on your own hardware
        </h2>
        <p className="text-sm text-muted-foreground">
          LAIOS is a local-first inference control plane. Connect a LAIOS daemon
          to serve open models on your own GPUs, watch VRAM, and use them here
          without your data leaving your machine.
        </p>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {INTRO_POINTS.map((p) => (
          <div key={p.title} className="flex flex-col gap-1.5">
            <p.icon className="h-5 w-5 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">{p.title}</p>
            <p className="text-xs text-muted-foreground">{p.body}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={onAddConnection}>
          <Plus className="h-4 w-4" />
          Add connection
        </Button>
        <span className="text-xs text-muted-foreground">
          You'll need a LAIOS daemon URL and its master key.
        </span>
      </div>
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
  onManage,
  onDelete,
  reconnectingId,
}: {
  connections: LaiosConnection[]
  activeId: string | undefined
  onSelect: (id: string) => void
  onAdd: () => void
  onEdit: (c: LaiosConnection) => void
  onManage: (c: LaiosConnection) => void
  onDelete: (c: LaiosConnection) => void
  reconnectingId: string | undefined
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
          {/* While the daemon is cycling through a restart, replace the status
              badge (which would just read "Unreachable") with a clear
              restarting indicator. */}
          {reconnectingId === active.id ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <DotGridLoader size="2xs" />
              Restarting…
            </span>
          ) : (
            <LaiosStatusBadge connectionId={active.id} />
          )}
          <span className="hidden truncate font-mono text-xs text-muted-foreground lg:inline">
            {active.base_url}
          </span>

          <div className="ml-auto flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              onClick={() => onManage(active)}
              aria-label="Manage daemon"
            >
              <Gear className="h-4 w-4" />
            </Button>
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
  downloads,
  onDismissDownload,
  onCancelDownload,
  onLogs,
  onStop,
  onRemove,
}: {
  connection: LaiosConnection
  downloads: DownloadCard[]
  onDismissDownload: (key: string) => void
  onCancelDownload: (key: string) => void
  onLogs: (i: LaiosInstance) => void
  onStop: (i: LaiosInstance) => void
  onRemove: (i: LaiosInstance) => void
}) {
  const {
    data: instances,
    isLoading,
    isError,
    error,
  } = useLaiosInstances(connection.id)
  const { data: metrics } = useLaiosMetrics(connection.id)

  // Metrics are reported per served model; index by instance id so each card can
  // show its own request/throughput line when the gateway exposes metrics.
  const metricsByInstance = useMemo(() => {
    const m = new Map<string, LaiosModelMetrics>()
    for (const row of metrics?.models ?? []) {
      if (row.instance_id) m.set(row.instance_id, row)
    }
    return m
  }, [metrics])

  // A stopped model is gone — don't keep it in the "running" view. Keep failed
  // ones (their error is actionable) and sort active first, failed last.
  const rank = (s: LaiosInstance["status"]) =>
    s === "running" ? 0 : s === "failed" ? 2 : 1
  const visible = (instances ?? [])
    .filter((i) => i.status !== "stopped")
    .sort((a, b) => rank(a.status) - rank(b.status))
  const updating =
    downloads.some((d) => d.phase !== "failed") ||
    visible.some((i) => isTransitional(i.status))
  const empty = visible.length === 0 && downloads.length === 0

  // Nothing running and nothing loading/failing: the section stays out of the
  // way entirely — the Library below carries serving. Only surface a spinner
  // or error while the first fetch is resolving.
  if (empty) {
    if (isLoading) {
      return <p className="text-sm text-muted-foreground">Loading models…</p>
    }
    if (isError) {
      return (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load models"}
        </p>
      )
    }
    return null
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground">Running</h2>
        {updating ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <DotGridLoader size="2xs" />
            updating
          </span>
        ) : null}
      </div>

      {/* A stacked list of full-width rows rather than a card grid: a running
          model carries wide, horizontal detail (endpoint, stats, actions), so
          one or two of them read as an intentional list instead of lone tiles
          stranded in an empty grid. */}
      <div className="space-y-3">
        {/* In-flight downloads first — a downloading/starting model has no
            daemon instance yet, so it lives only as a download row until
            serve. Progress is read live from the daemon's pull job. */}
        {downloads.map((d) => (
          <DownloadTile
            key={d.key}
            download={d}
            onDismiss={() => onDismissDownload(d.key)}
            onCancel={() => onCancelDownload(d.key)}
          />
        ))}
        {visible.map((inst) => (
          <InstanceCard
            key={inst.id}
            instance={inst}
            metrics={metricsByInstance.get(inst.id)}
            onLogs={() => onLogs(inst)}
            onStop={() => onStop(inst)}
            onRemove={() => onRemove(inst)}
          />
        ))}
      </div>
    </div>
  )
}

function DownloadTile({
  download,
  onDismiss,
  onCancel,
}: {
  download: DownloadCard
  onDismiss: () => void
  onCancel: () => void
}) {
  const failed = download.phase === "failed"
  const pulling = download.phase === "pulling"
  const label =
    download.phase === "pulling"
      ? "downloading"
      : download.phase === "starting"
        ? "starting"
        : "failed"

  // Progress only exists while pulling; the daemon reports bytes best-effort, so
  // a known total gives a determinate bar, otherwise we show bytes fetched.
  const { bytesDone, bytesTotal } = download
  const hasProgress = pulling && bytesDone != null
  const pct =
    hasProgress && bytesTotal != null && bytesTotal > 0
      ? Math.min(100, Math.round((bytesDone / bytesTotal) * 100))
      : undefined

  const detail = pulling
    ? hasProgress
      ? bytesTotal != null && bytesTotal > 0
        ? `${fmtBytes(bytesDone)} of ${fmtBytes(bytesTotal)}`
        : `${fmtBytes(bytesDone)} downloaded`
      : "Downloading weights…"
    : download.phase === "starting"
      ? "Starting engine…"
      : "Failed to start"

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-4",
        !failed && "ring-1 ring-border"
      )}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">
              {download.name}
            </h3>
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
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>
        </div>

        {hasProgress ? (
          <div className="w-full space-y-1 sm:w-56">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full bg-primary transition-all",
                  // No known total — an indeterminate-ish sliver that still
                  // conveys "working" without implying a percentage.
                  pct == null && "w-1/3 animate-pulse"
                )}
                style={pct != null ? { width: `${pct}%` } : undefined}
              />
            </div>
            {pct != null ? (
              <div className="text-right text-[0.65rem] text-muted-foreground">
                {pct}%
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="shrink-0 sm:ml-auto">
          {failed ? (
            <Button variant="outline" size="sm" onClick={onDismiss}>
              <X className="h-4 w-4" />
              Dismiss
            </Button>
          ) : pulling ? (
            // While weights are still downloading the pull can be aborted — asks
            // the daemon to cancel the job and clears the row.
            <Button variant="outline" size="sm" onClick={onCancel}>
              <X className="h-4 w-4" />
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      {failed && download.error ? (
        <p className="mt-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-destructive">
          {download.error}
        </p>
      ) : null}
    </div>
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
  metrics,
  onLogs,
  onStop,
  onRemove,
}: {
  instance: LaiosInstance
  metrics?: LaiosModelMetrics
  onLogs: () => void
  onStop: () => void
  onRemove: () => void
}) {
  const terminal =
    instance.status === "stopped" || instance.status === "failed"
  const transitioning = isTransitional(instance.status)
  // Only show throughput once the model has actually served requests.
  const showMetrics =
    instance.status === "running" && metrics && metrics.request_count > 0
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-4",
        transitioning && "ring-1 ring-border"
      )}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
        {/* Identity: name, live state, and the gateway endpoint. */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">
              {instance.served_name}
            </h3>
            <Badge
              variant={STATE_VARIANT[instance.status]}
              className="shrink-0 gap-1 font-normal"
            >
              {transitioning ? <DotGridLoader size="2xs" /> : null}
              {instance.status}
            </Badge>
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {instance.endpoint}
          </p>
          {instance.model_id ? (
            <p className="truncate font-mono text-xs text-muted-foreground/70">
              {instance.model_id}
            </p>
          ) : null}
        </div>

        {/* Stats band: the always-known facts, plus live throughput once served. */}
        <div className="flex shrink-0 items-center gap-6 sm:gap-8">
          <Stat label="Engine" value={instance.engine} />
          <Stat label="Context" value={instance.max_model_len.toLocaleString()} />
          <Stat label="VRAM" value={fmtGb(instance.vram_allocated_mb)} />
          {showMetrics && metrics ? (
            <>
              <Stat
                label="Requests"
                value={metrics.request_count.toLocaleString()}
              />
              {metrics.tokens_per_second > 0 ? (
                <Stat
                  label="Throughput"
                  value={`${metrics.tokens_per_second.toFixed(1)} tok/s`}
                />
              ) : null}
            </>
          ) : null}
        </div>

        {/* Actions pinned to the right on wide rows. */}
        <div className="flex items-center gap-2 lg:ml-auto">
          <Button variant="outline" size="sm" onClick={onLogs}>
            <FileText className="h-4 w-4" />
            Logs
          </Button>
          {/* A terminal row (a failed spin-up, or a stopped model still shown)
              is dead weight — offer Remove to clear it. A live one gets Stop. */}
          {terminal ? (
            <Button variant="outline" size="sm" onClick={onRemove}>
              <Trash className="h-4 w-4" />
              Remove
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={onStop}
              disabled={instance.status === "stopping"}
            >
              <Square className="h-4 w-4" />
              Stop
            </Button>
          )}
        </div>
      </div>

      {instance.error ? (
        <p className="mt-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-destructive">
          {instance.error}
        </p>
      ) : null}
    </div>
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

// Distinct, theme-aware colors cycled per running model so each model's slice
// of the "in use" bar is individually legible. System/overhead and the free
// remainder use the muted/track styles below, not this palette.
const MODEL_BARS: ReadonlyArray<{ bar: string; dot: string }> = [
  { bar: "bg-primary", dot: "bg-primary" },
  { bar: "bg-info", dot: "bg-info" },
  { bar: "bg-success", dot: "bg-success" },
  { bar: "bg-warning", dot: "bg-warning" },
  { bar: "bg-chart-2", dot: "bg-chart-2" },
  { bar: "bg-chart-4", dot: "bg-chart-4" },
]

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
  const { data: instances } = useLaiosInstances(connectionId)

  const res = cluster?.resources
  const isCluster = !!res && res.total_nodes_known > 1

  let total: number
  let available: number
  let usedSegments: VramSegment[]

  if (isCluster && res) {
    total = Math.max(0, res.total_vram_mb)
    available = Math.max(0, Math.min(res.free_vram_mb, total))
    const inUse = Math.max(0, total - available)

    // Break "in use" down by running model. Only free/total are measured per
    // node, so each model's slice is its declared allocation, clamped so the
    // slices never exceed measured in-use; whatever is left over is system and
    // engine overhead (OS, CUDA context, KV pool not attributed to a model).
    const nodeName = (id: string) =>
      res.nodes.find((n) => n.node_id === id)?.name ?? id
    const running = (instances ?? []).filter(
      (i) => i.status === "running" && i.vram_allocated_mb > 0
    )

    let budgetLeft = inUse
    const modelSegments: VramSegment[] = running.map((inst, idx) => {
      const value = Math.max(0, Math.min(inst.vram_allocated_mb, budgetLeft))
      budgetLeft -= value
      const color = MODEL_BARS[idx % MODEL_BARS.length]
      return {
        key: `model:${inst.id}`,
        label: inst.served_name,
        value,
        bar: color.bar,
        dot: color.dot,
        hint: `Held by ${inst.served_name} on ${nodeName(inst.node_id)}`,
      }
    })

    if (modelSegments.length > 0) {
      const system = Math.max(0, budgetLeft)
      usedSegments = [
        ...modelSegments,
        ...(system > 0
          ? [
              {
                key: "system",
                label: "System & overhead",
                value: system,
                bar: "bg-muted-foreground",
                dot: "bg-muted-foreground",
                hint: "OS, engine runtime, and memory not attributed to a model",
              },
            ]
          : []),
      ]
    } else {
      // No running models tracked (or still loading) — keep the single opaque
      // segment rather than mislabeling baseline usage.
      usedSegments = [
        {
          key: "inUse",
          label: "In use",
          value: inUse,
          bar: "bg-primary",
          dot: "bg-primary",
          hint: "VRAM held across all online nodes",
        },
      ]
    }
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
  const { data: instances } = useLaiosInstances(connectionId)
  const token = useLaiosClusterToken(connectionId)
  const removeWorker = useRemoveWorker(connectionId)
  const [open, setOpen] = useState(false)
  const [workerToRemove, setWorkerToRemove] = useState<
    LaiosNodeResources | undefined
  >()
  const res = data?.resources
  if (!res || res.total_nodes_known <= 1) return null

  const isHead = data?.role === "head"
  const running = (instances ?? []).filter((i) => i.status === "running")
  const modelsForNode = (nodeId: string) =>
    running.filter((i) => i.node_id === nodeId)

  async function copyJoinToken() {
    try {
      const { data: t } = await token.refetch({ throwOnError: true })
      if (!t?.join_token) throw new Error("No join token available")
      await navigator.clipboard.writeText(t.join_token)
      toast.success("Join token copied to clipboard")
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to fetch join token"
      )
    }
  }

  async function confirmRemoveWorker() {
    if (!workerToRemove) return
    try {
      await removeWorker.mutateAsync(workerToRemove.node_id)
      toast.success(`Removed ${workerToRemove.name}`)
      setWorkerToRemove(undefined)
    } catch (err) {
      // The daemon returns 409 when an active instance is still placed there.
      toast.error(err instanceof Error ? err.message : "Failed to remove worker")
    }
  }

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
        <div className="px-4 pb-4">
          <div className="divide-y divide-border">
            {res.nodes.map((n) => (
              <ClusterNodeRow
                key={n.node_id}
                node={n}
                models={modelsForNode(n.node_id)}
                // Only the head can drop workers, and only worker rows are
                // removable (you can't evict the head from itself).
                onRemove={
                  isHead && n.role === "worker"
                    ? () => setWorkerToRemove(n)
                    : undefined
                }
              />
            ))}
          </div>

          {/* Adding a node needs the head's join token; offer to copy it here so
              the whole membership workflow lives in one place. */}
          {isHead ? (
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                Add a worker with the head's join token.
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={copyJoinToken}
                disabled={token.isFetching}
              >
                {token.isFetching ? (
                  <DotGridLoader size="2xs" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                Copy join token
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={Boolean(workerToRemove)}
        onOpenChange={(o) => !o && setWorkerToRemove(undefined)}
        title="Remove worker"
        description={
          workerToRemove
            ? `Drop "${workerToRemove.name}" from the cluster? It stops contributing capacity; if it's still running it will need to rejoin with the join token.`
            : undefined
        }
        confirmLabel="Remove"
        destructive
        loading={removeWorker.isPending}
        onConfirm={confirmRemoveWorker}
      />
    </div>
  )
}

function ClusterNodeRow({
  node,
  models,
  onRemove,
}: {
  node: LaiosNodeResources
  models: LaiosInstance[]
  onRemove?: () => void
}) {
  return (
    <div className={cn("py-2 text-xs", !node.online && "opacity-50")}>
      <div className="flex items-center justify-between gap-3">
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
        <div className="flex shrink-0 items-center gap-2">
          <div className="text-muted-foreground">
            {node.gpus} GPU{node.gpus === 1 ? "" : "s"} ·{" "}
            <span className="font-medium text-foreground">
              {fmtGb(node.free_vram_mb)}
            </span>{" "}
            free / {fmtGb(node.total_vram_mb)}
          </div>
          {onRemove ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-destructive"
              onClick={onRemove}
              aria-label={`Remove ${node.name}`}
            >
              <Trash className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      {/* What's holding this node's VRAM: one line per running model. Indented
          under the node so the attribution reads as a child of the node row. */}
      {models.length > 0 ? (
        <div className="mt-1.5 space-y-1 pl-4">
          {models.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-3 text-muted-foreground"
            >
              <span className="truncate">{m.served_name}</span>
              <span className="shrink-0 font-medium text-foreground">
                {fmtGb(m.vram_allocated_mb)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
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

function RemoveInstanceDialog({
  connectionId,
  instance,
  onDone,
}: {
  connectionId: string
  instance: LaiosInstance | undefined
  onDone: () => void
}) {
  const remove = useRemoveInstance(connectionId)

  async function confirm() {
    if (!instance) return
    try {
      await remove.mutateAsync(instance.id)
      toast.success(`Removed ${instance.served_name}`)
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove model")
    }
  }

  // Stopped models are already torn down; a failed one may have leftovers the
  // daemon clears best-effort. Either way the record is forgotten after this.
  const failed = instance?.status === "failed"
  return (
    <ConfirmDialog
      open={Boolean(instance)}
      onOpenChange={(open) => !open && onDone()}
      title="Remove model"
      description={
        instance
          ? failed
            ? `Remove "${instance.served_name}"? This clears the failed spin-up and frees any VRAM it still holds.`
            : `Remove "${instance.served_name}" from the list? This forgets the record; the model is already stopped.`
          : undefined
      }
      confirmLabel="Remove"
      destructive
      loading={remove.isPending}
      onConfirm={confirm}
    />
  )
}
