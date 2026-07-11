import { FileText, Loader2, Pencil, Plus, Server, Square, Trash2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  isTransitional,
  useDeleteLaiosConnection,
  useLaiosBudget,
  useLaiosConnections,
  useLaiosInstances,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { InstanceLogsDialog } from "./instance-logs-dialog"
import { LaiosConnectionDialog } from "./laios-connection-dialog"
import { LaiosStatusBadge } from "./laios-status-badge"
import { ServeModelDialog } from "./serve-model-dialog"

const DESCRIPTION =
  "Connect to laios daemons to see what's running, spin models up and down, and monitor VRAM — across one or more local or remote nodes."

const ACTIVE_KEY = "laios.activeConnectionId"

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

  const deleteConnection = useDeleteLaiosConnection()

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
    <Button
      onClick={() => {
        setEditingConn(undefined)
        setConnFormOpen(true)
      }}
    >
      <Plus className="h-4 w-4" />
      Add connection
    </Button>
  )

  return (
    <div className="space-y-6">
      {embedded ? (
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">{DESCRIPTION}</p>
          {action}
        </div>
      ) : (
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
            <Button
              onClick={() => {
                setEditingConn(undefined)
                setConnFormOpen(true)
              }}
            >
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
            onEdit={(c) => {
              setEditingConn(c)
              setConnFormOpen(true)
            }}
            onDelete={setConnToDelete}
          />

          {activeConnection ? (
            <ConnectionPanel
              connection={activeConnection}
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

function ConnectionBar({
  connections,
  activeId,
  onSelect,
  onEdit,
  onDelete,
}: {
  connections: LaiosConnection[]
  activeId: string | undefined
  onSelect: (id: string) => void
  onEdit: (c: LaiosConnection) => void
  onDelete: (c: LaiosConnection) => void
}) {
  const active = connections.find((c) => c.id === activeId)
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select value={activeId} onValueChange={onSelect}>
        <SelectTrigger className="w-56">
          <SelectValue placeholder="Select a connection" />
        </SelectTrigger>
        <SelectContent>
          {connections.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {active ? <LaiosStatusBadge connectionId={active.id} /> : null}

      {active ? (
        <span className="truncate font-mono text-xs text-muted-foreground">
          {active.base_url}
          {active.has_master_key ? "" : " · no key"}
        </span>
      ) : null}

      {active ? (
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onEdit(active)}
            aria-label="Edit connection"
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onDelete(active)}
            aria-label="Remove connection"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function ConnectionPanel({
  connection,
  onServe,
  onLogs,
  onStop,
}: {
  connection: LaiosConnection
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
  const updating = visible.some((i) => isTransitional(i.status))

  return (
    <div className="space-y-4">
      <BudgetStrip connectionId={connection.id} />

      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">Models</h3>
          {updating ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              updating
            </span>
          ) : null}
        </div>
        <Button size="sm" onClick={onServe}>
          <Server className="h-4 w-4" />
          Serve a model
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading models…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load models"}
        </p>
      ) : visible.length === 0 ? (
        <EmptyState
          title="Nothing running"
          description="Serve a model from the catalog to see it here."
          action={
            <Button size="sm" onClick={onServe}>
              <Server className="h-4 w-4" />
              Serve a model
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((inst) => (
            <InstanceCard
              key={inst.id}
              instance={inst}
              onLogs={() => onLogs(inst)}
              onStop={() => onStop(inst)}
            />
          ))}
        </div>
      )}
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
          {instance.engine} · {instance.endpoint}
        </CardDescription>
      </CardHeader>
      <CardContent className="mt-auto space-y-3">
        <div className="text-xs text-muted-foreground">
          {instance.model_id ? <div>model: {instance.model_id}</div> : null}
          <div>
            ctx {instance.max_model_len.toLocaleString()} ·{" "}
            {instance.vram_allocated_mb.toLocaleString()} MiB
          </div>
        </div>
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

function BudgetStrip({ connectionId }: { connectionId: string }) {
  const { data } = useLaiosBudget(connectionId)
  if (!data) return null
  const available = Math.max(0, data.total_mb - data.reserved_mb - data.allocated_mb)
  const items: [string, string][] = [
    ["Total", `${data.total_mb.toLocaleString()} MiB`],
    ["Allocated", `${data.allocated_mb.toLocaleString()} MiB`],
    ["Reserved", `${data.reserved_mb.toLocaleString()} MiB`],
    ["Available", `${available.toLocaleString()} MiB`],
  ]
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-md border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-sm font-medium text-foreground">{value}</div>
        </div>
      ))}
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
