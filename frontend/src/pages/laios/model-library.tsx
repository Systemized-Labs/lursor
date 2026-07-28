import {
  Broom,
  CaretDown,
  CheckCircle,
  Lightning,
  MagnifyingGlass,
  Square,
  Stack,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import {
  useDeleteModel,
  useLaiosBudget,
  useLaiosCatalog,
  useLaiosCluster,
  useLaiosInstances,
  useLaiosModels,
  useLaiosPartialModels,
  useStopInstance,
} from "@/api/laios"
import type {
  LaiosInstance,
  LaiosModel,
  LaiosOrphanedModel,
  LaiosServeInput,
} from "@/api/types"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import {
  nodeTargets,
  placementInput,
  placementLabel,
  placementNodes,
  recipeConstraints,
  resolvePlacement,
  type Placement,
  type RecipeConstraints,
} from "./placement"
import { PlacementPicker } from "./placement-picker"

interface ModelLibraryProps {
  connectionId: string
  // Kicks off the download → start flow; a live card appears in Running above.
  onServe: (input: LaiosServeInput, name: string) => void
}

const MIB_PER_GB = 1024

function gb(mib: number): string {
  return `${(mib / MIB_PER_GB).toFixed(1)} GB`
}

// On-disk byte counts render in the largest sensible unit.
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

// Compact "time since" for the last-served stamp; null when never/unparseable.
function fmtAgo(iso?: string | null): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const secs = Math.round((Date.now() - then) / 1000)
  if (secs < 60) return "just now"
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

type Fit =
  | "ok"
  | "tight"
  | "cluster"
  | "solo-only"
  | "needs-nodes"
  | "too-big"
  | "no-fit"
  | "unknown"

interface Compat {
  fit: Fit
  /** Hard, permanent incompatibility for the current placement. */
  unavailable: boolean
  /** Whether the model can be served right now. */
  canServe: boolean
  reason: string
}

// Normalized VRAM pool the chosen placement can draw on: `usable` is the most a
// single model could ever get there; `available` is what's free right now.
// `label` names the destination so every verdict says where it applies.
interface VramPool {
  usable: number
  available: number
  label: string
}

// Classify a model against the chosen placement: first the topology rules the
// daemon enforces on `/v1/serve`, then whether it fits in that placement's VRAM.
function classify(
  est: number | null,
  constraints: RecipeConstraints,
  placement: Placement,
  nodeCount: number,
  shardAvailable: boolean,
  pool: VramPool | undefined
): Compat {
  const sharding = placement.kind === "shard"
  const { clusterOnly, soloOnly, minNodes, maxNodes } = constraints

  if (!sharding && clusterOnly) {
    return {
      fit: "cluster",
      unavailable: true,
      canServe: false,
      reason: shardAvailable
        ? `Needs ${minNodes} nodes together — switch to Multiple to serve it.`
        : `Requires a multi-node cluster (${minNodes} nodes).`,
    }
  }
  if (sharding && soloOnly) {
    return {
      fit: "solo-only",
      unavailable: true,
      canServe: false,
      reason: "Runs on one node only — switch to One node to serve it.",
    }
  }
  if (sharding && nodeCount < minNodes) {
    return {
      fit: "needs-nodes",
      unavailable: false,
      canServe: false,
      reason: `Needs at least ${minNodes} nodes — ${nodeCount} selected.`,
    }
  }
  if (sharding && maxNodes != null && nodeCount > maxNodes) {
    return {
      fit: "needs-nodes",
      unavailable: false,
      canServe: false,
      reason: `Runs on at most ${maxNodes} nodes — ${nodeCount} selected.`,
    }
  }

  if (est == null || !pool) {
    return { fit: "unknown", unavailable: false, canServe: true, reason: "" }
  }
  const { usable, available, label } = pool
  if (est > usable) {
    return {
      fit: "too-big",
      unavailable: true,
      canServe: false,
      reason: `Too large for ${label} — needs ${gb(est)}, only ${gb(usable)} usable.`,
    }
  }
  if (est > available) {
    return {
      fit: "no-fit",
      unavailable: false,
      canServe: false,
      reason: `Not enough free VRAM on ${label} — needs ${gb(est)}, ${gb(available)} free. Stop a running model or pick another node.`,
    }
  }
  return {
    fit: est > available * 0.85 ? "tight" : "ok",
    unavailable: false,
    canServe: true,
    reason: `Fits on ${label} — ${gb(est)} of ${gb(available)} free.`,
  }
}

// A single unified list entry: a catalog recipe, optionally backed by installed
// weights and/or a live instance. This is the merge — recipes you could serve
// and models already on disk are the same objects here.
interface ModelEntry {
  key: string
  recipeId: string | null
  name: string
  engine: string
  description: string | null
  vramEstimateMb: number | null
  constraints: RecipeConstraints
  installed: boolean
  recipePresent: boolean
  model?: LaiosModel
  running?: LaiosInstance
  fit: Compat
}

type FilterKey = "all" | "ready" | "installed" | "running"

const FILTERS: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "ready", label: "Ready" },
  { key: "installed", label: "Installed" },
  { key: "running", label: "Running" },
]

// A short fit pill for the collapsed row: label + tone by fit outcome. Running
// models don't use this (they show a "live" badge instead).
function fitPill(entry: ModelEntry): { label: string; className: string } | null {
  if (!entry.recipeId) {
    return {
      label: "no recipe",
      className: "border-destructive/40 bg-destructive/10 text-destructive",
    }
  }
  switch (entry.fit.fit) {
    case "ok":
      return {
        label: "fits",
        className: "border-success/40 bg-success/10 text-success",
      }
    case "tight":
      return {
        label: "tight",
        className: "border-warning/40 bg-warning/10 text-warning",
      }
    case "no-fit":
      return {
        label: "no room",
        className: "border-destructive/40 bg-destructive/10 text-destructive",
      }
    case "too-big":
      return {
        label: "too big",
        className: "border-destructive/40 bg-destructive/10 text-destructive",
      }
    case "cluster":
      return {
        label: "cluster only",
        className: "border-destructive/40 bg-destructive/10 text-destructive",
      }
    case "solo-only":
      return {
        label: "single node",
        className: "border-destructive/40 bg-destructive/10 text-destructive",
      }
    case "needs-nodes":
      return {
        label: "more nodes",
        className: "border-warning/40 bg-warning/10 text-warning",
      }
    default:
      return null
  }
}

/**
 * The Models library: an always-present page section that browses every model
 * (catalog recipes + installed weights) against the page's live VRAM, and serves
 * one inline — no dialog. Rows expand accordion-style to reveal fit, run stats,
 * serve options, and actions. Serving hands off to the parent's serve manager (a
 * live card appears under Running above); weight deletion and stopping run inline.
 */
export function ModelLibrary({ connectionId, onServe }: ModelLibraryProps) {
  const { data: catalog, isLoading: catalogLoading } =
    useLaiosCatalog(connectionId)
  const { data: models } = useLaiosModels(connectionId)
  const { data: instances } = useLaiosInstances(connectionId)
  const { data: orphans } = useLaiosPartialModels(connectionId)
  const { data: budget } = useLaiosBudget(connectionId)
  const { data: cluster } = useLaiosCluster(connectionId)
  const deleteModel = useDeleteModel(connectionId)
  const stopInstance = useStopInstance(connectionId)

  const [placement, setPlacement] = useState<Placement>({ kind: "head" })
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<FilterKey>("all")
  const [expandedKey, setExpandedKey] = useState<string | undefined>()
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [maxLen, setMaxLen] = useState("")
  const [servedName, setServedName] = useState("")
  const [toDelete, setToDelete] = useState<ModelEntry | undefined>()
  const [orphanToDelete, setOrphanToDelete] = useState<
    LaiosOrphanedModel | undefined
  >()
  const [toStop, setToStop] = useState<ModelEntry | undefined>()

  // Every node this daemon can place on, head first. Empty when the daemon has
  // no cluster, which is what hides the picker.
  const targets = useMemo(() => nodeTargets(cluster), [cluster])
  const isCluster = (cluster?.resources?.total_nodes_known ?? 0) > 1
  const shardAvailable =
    isCluster && targets.some((t) => t.role === "worker" && t.shardable)

  // A worker can drop out (or the whole cluster can) while it's selected, so
  // the placement actually used is always re-derived from live membership.
  const active = useMemo<Placement>(
    () => (isCluster ? resolvePlacement(placement, targets) : { kind: "head" }),
    [isCluster, placement, targets]
  )
  const activeNodes = useMemo(
    () => placementNodes(active, targets),
    [active, targets]
  )

  // VRAM the placement can draw on. Standalone daemons keep using /v1/budget
  // (it accounts for the scheduler's reserve); once there's a cluster, every
  // node — including the head — is measured the same way off the rollup, so
  // the numbers in the picker and the verdicts agree.
  const activePool = useMemo<VramPool | undefined>(() => {
    if (!isCluster) {
      if (!budget) return undefined
      const usable = Math.max(0, budget.total_mb - budget.reserved_mb)
      return {
        usable,
        available: Math.max(0, usable - budget.allocated_mb),
        label: "this machine",
      }
    }
    if (activeNodes.length === 0) return undefined
    return {
      usable: activeNodes.reduce((sum, n) => sum + n.totalVramMb, 0),
      available: activeNodes.reduce((sum, n) => sum + n.freeVramMb, 0),
      label: placementLabel(active, targets),
    }
  }, [isCluster, budget, activeNodes, active, targets])

  // Build the merged entries: index installed weights by every recipe id they
  // can serve (solo/cluster variants share weights), then fold them into the
  // catalog. Installed weights with no matching recipe get their own entries.
  const entries = useMemo<ModelEntry[]>(() => {
    // Older daemons omit some optional array fields (usable_recipes, etc.), so
    // never assume they're present — coerce before iterating.
    const usable = (m: LaiosModel) => m.usable_recipes ?? []
    const modelByRecipe = new Map<string, LaiosModel>()
    for (const m of models ?? []) {
      const ids = [m.recipe_id, ...usable(m)].filter(Boolean)
      for (const rid of ids) if (!modelByRecipe.has(rid)) modelByRecipe.set(rid, m)
    }
    const catalogIds = new Set((catalog ?? []).map((r) => r.id))

    // "Running" is attributed from the authoritative instances list keyed by the
    // instance's own recipe_id — NOT from a shared-weights manifest, whose single
    // running_instance would otherwise light up every recipe that can serve those
    // weights (e.g. the solo and 4-node variants) as live at once.
    const runningByRecipe = new Map<string, LaiosInstance>()
    for (const inst of instances ?? []) {
      if (inst.status === "stopped" || inst.status === "failed") continue
      const prev = runningByRecipe.get(inst.recipe_id)
      if (!prev || (inst.status === "running" && prev.status !== "running")) {
        runningByRecipe.set(inst.recipe_id, inst)
      }
    }

    const fromCatalog: ModelEntry[] = (catalog ?? []).map((r) => {
      const model = modelByRecipe.get(r.id)
      const constraints = recipeConstraints(r)
      return {
        key: r.id,
        recipeId: r.id,
        name: r.name,
        engine: r.engine,
        description: r.description,
        vramEstimateMb: r.vram_estimate_mb,
        constraints,
        installed: Boolean(model?.installed),
        recipePresent: true,
        model,
        running: runningByRecipe.get(r.id),
        fit: classify(
          r.vram_estimate_mb,
          constraints,
          active,
          activeNodes.length,
          shardAvailable,
          activePool
        ),
      }
    })

    // Downloaded weights whose recipe is gone from the catalog — still worth
    // showing so they can be inspected or reclaimed, but not servable.
    const orphanModels: ModelEntry[] = (models ?? [])
      .filter(
        (m) =>
          !catalogIds.has(m.recipe_id) &&
          !usable(m).some((rid) => catalogIds.has(rid))
      )
      .map((m) => ({
        key: `model:${m.id}`,
        recipeId: null,
        name: m.name,
        engine: m.engine,
        description: null,
        vramEstimateMb: null,
        constraints: { clusterOnly: false, soloOnly: false, minNodes: 1 },
        installed: true,
        recipePresent: false,
        model: m,
        running: runningByRecipe.get(m.recipe_id),
        fit: {
          fit: "unknown",
          unavailable: true,
          canServe: false,
          reason: "No recipe for these weights — delete or re-add a recipe.",
        },
      }))

    return [...fromCatalog, ...orphanModels]
  }, [
    catalog,
    models,
    instances,
    active,
    activeNodes.length,
    shardAvailable,
    activePool,
  ])

  // Search + filter, then sort: running first, then servable, then installed,
  // unavailable last; smallest first within a group so the easiest pick is up top.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rank = (e: ModelEntry) =>
      e.running ? 0 : e.fit.canServe ? 1 : e.installed ? 2 : e.fit.unavailable ? 4 : 3
    return entries
      .filter((e) => {
        if (q && !`${e.name} ${e.recipeId ?? ""} ${e.engine}`.toLowerCase().includes(q))
          return false
        if (filter === "ready") return e.fit.canServe && !e.running
        if (filter === "installed") return e.installed
        if (filter === "running") return Boolean(e.running)
        return true
      })
      .sort((a, b) => {
        const byRank = rank(a) - rank(b)
        if (byRank !== 0) return byRank
        const sa = a.vramEstimateMb ?? Number.POSITIVE_INFINITY
        const sb = b.vramEstimateMb ?? Number.POSITIVE_INFINITY
        return sa - sb
      })
  }, [entries, query, filter])

  const installedCount = entries.filter((e) => e.installed).length
  const runningCount = entries.filter((e) => e.running).length

  function toggleExpanded(key: string) {
    setExpandedKey((cur) => (cur === key ? undefined : key))
    // Reset the per-model serve overrides whenever the open row changes.
    setShowAdvanced(false)
    setMaxLen("")
    setServedName("")
  }

  function handleServe(entry: ModelEntry) {
    if (!entry.recipeId || !entry.fit.canServe) return
    const target = placementInput(active, targets)
    // A shard is addressed by fabric IP, and the head's has to be routable —
    // a daemon still advertising loopback can't be rank 0, so say that here
    // rather than letting the serve fail deep in the cluster resolver.
    if (active.kind === "shard" && (target.nodes?.length ?? 0) < 2) {
      toast.error(
        "Multi-node serve needs every node's fabric address — set node.advertise on the head to its CX-7 IP."
      )
      return
    }
    const input: LaiosServeInput = { recipe: entry.recipeId, ...target }
    if (maxLen.trim()) {
      const n = Number(maxLen.trim())
      if (!Number.isFinite(n) || n <= 0) {
        toast.error("Max model length must be a positive number")
        return
      }
      input.max_model_len = n
    }
    if (servedName.trim()) input.served_name = servedName.trim()
    onServe(input, servedName.trim() || entry.name || entry.recipeId)
    setExpandedKey(undefined)
  }

  async function confirmDelete() {
    const target = toDelete
    if (!target?.model) return
    try {
      const res = await deleteModel.mutateAsync(target.model.id)
      toast.success(`Deleted ${target.name} · freed ${fmtBytes(res.bytes_freed)}`)
      setToDelete(undefined)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete model")
    }
  }

  async function confirmDeleteOrphan() {
    if (!orphanToDelete) return
    try {
      const res = await deleteModel.mutateAsync(orphanToDelete.dir_name)
      toast.success(`Reclaimed ${fmtBytes(res.bytes_freed)}`)
      setOrphanToDelete(undefined)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove download")
    }
  }

  async function confirmStop() {
    const target = toStop
    if (!target?.running) return
    try {
      await stopInstance.mutateAsync(target.running.id)
      toast.success(`Stopping ${target.running.served_name}`)
      setToStop(undefined)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to stop model")
    }
  }

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      {/* Header: identity, the (cluster-only) placement picker, search, filters. */}
      <div className="space-y-3 border-b border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Stack className="h-4 w-4 text-muted-foreground" />
              Library
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isCluster
                ? "Pick where models land, then browse them against that node's VRAM."
                : "Browse every model against your VRAM and serve one inline."}
            </p>
          </div>
          {isCluster ? (
            <PlacementPicker
              placement={active}
              targets={targets}
              onChange={setPlacement}
            />
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="h-9 pl-8"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => {
              const count =
                f.key === "installed"
                  ? installedCount
                  : f.key === "running"
                    ? runningCount
                    : undefined
              return (
                <FilterChip
                  key={f.key}
                  active={filter === f.key}
                  onClick={() => setFilter(f.key)}
                  label={f.label}
                  count={count}
                />
              )
            })}
          </div>
        </div>
      </div>

      {/* Rows. */}
      {catalogLoading && entries.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">
          Loading catalog…
        </p>
      ) : visible.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">
          No models match.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {visible.map((e) => (
            <ModelRow
              key={e.key}
              entry={e}
              expanded={e.key === expandedKey}
              onToggle={() => toggleExpanded(e.key)}
              showAdvanced={showAdvanced}
              onToggleAdvanced={() => setShowAdvanced((v) => !v)}
              maxLen={maxLen}
              onMaxLen={setMaxLen}
              servedName={servedName}
              onServedName={setServedName}
              targetLabel={
                isCluster ? placementLabel(active, targets) : undefined
              }
              onServe={() => handleServe(e)}
              onDelete={() => setToDelete(e)}
              onStop={() => setToStop(e)}
            />
          ))}
        </div>
      )}

      {/* Incomplete / orphaned downloads — reclaim disk. */}
      {orphans && orphans.length > 0 ? (
        <div className="border-t border-border bg-muted/20 px-4 py-3">
          <div className="flex items-center gap-1.5 pb-1 text-xs font-medium text-muted-foreground">
            <Broom className="h-3.5 w-3.5" />
            Incomplete downloads
          </div>
          <div className="divide-y divide-border/60">
            {orphans.map((o) => (
              <OrphanRow
                key={o.dir_name}
                orphan={o}
                onDelete={() => setOrphanToDelete(o)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(o) => !o && setToDelete(undefined)}
        title="Delete model weights"
        description={
          toDelete?.model
            ? `Delete "${toDelete.name}" from disk? This frees ${fmtBytes(
                toDelete.model.bytes_total
              )}. You can re-download it later from its recipe.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        loading={deleteModel.isPending}
        onConfirm={confirmDelete}
      />

      <ConfirmDialog
        open={Boolean(orphanToDelete)}
        onOpenChange={(o) => !o && setOrphanToDelete(undefined)}
        title="Remove download"
        description={
          orphanToDelete
            ? `Remove "${orphanToDelete.dir_name}" and reclaim ${fmtBytes(
                orphanToDelete.bytes_on_disk
              )}? ${
                orphanToDelete.looks_complete
                  ? "It looks complete but isn't matched to any current recipe."
                  : "This is an incomplete download."
              }`
            : undefined
        }
        confirmLabel="Remove"
        destructive
        loading={deleteModel.isPending}
        onConfirm={confirmDeleteOrphan}
      />

      <ConfirmDialog
        open={Boolean(toStop)}
        onOpenChange={(o) => !o && setToStop(undefined)}
        title="Stop model"
        description={
          toStop?.running
            ? `Stop "${toStop.running.served_name}"? This tears down the engine and frees its VRAM.`
            : undefined
        }
        confirmLabel="Stop"
        destructive
        loading={stopInstance.isPending}
        onConfirm={confirmStop}
      />
    </section>
  )
}

function FilterChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  label: string
  count?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-transparent bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      )}
    >
      {label}
      {count != null && count > 0 ? (
        <span className={cn("ml-1", active ? "opacity-80" : "opacity-60")}>
          {count}
        </span>
      ) : null}
    </button>
  )
}

// A dot conveying a model's headline state at a glance in the list.
function StatusDot({ entry }: { entry: ModelEntry }) {
  const tone = entry.running
    ? "bg-success"
    : entry.fit.canServe
      ? entry.installed
        ? "bg-info"
        : "border border-border bg-transparent"
      : entry.fit.unavailable
        ? "bg-destructive/60"
        : "bg-warning"
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", tone)} />
}

// A labelled stat in the expanded detail grid.
function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="truncate text-sm font-medium text-foreground">{value}</div>
    </div>
  )
}

function ModelRow({
  entry,
  expanded,
  onToggle,
  showAdvanced,
  onToggleAdvanced,
  maxLen,
  onMaxLen,
  servedName,
  onServedName,
  targetLabel,
  onServe,
  onDelete,
  onStop,
}: {
  entry: ModelEntry
  expanded: boolean
  onToggle: () => void
  showAdvanced: boolean
  onToggleAdvanced: () => void
  maxLen: string
  onMaxLen: (v: string) => void
  servedName: string
  onServedName: (v: string) => void
  /** Where this serve would land; undefined on a standalone daemon. */
  targetLabel?: string
  onServe: () => void
  onDelete: () => void
  onStop: () => void
}) {
  const { running, installed, model, fit } = entry
  const lastServed = fmtAgo(model?.last_served_at)
  const pill = running ? null : fitPill(entry)
  const size =
    entry.model?.bytes_total != null && entry.installed
      ? fmtBytes(entry.model.bytes_total)
      : entry.vramEstimateMb != null
        ? `≈${gb(entry.vramEstimateMb)}`
        : "size unknown"

  const hasStats = installed || (model?.run_count ?? 0) > 0

  return (
    <div className={cn(expanded && "bg-muted/30")}>
      {/* Collapsed summary — the whole row toggles the expansion. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <StatusDot entry={entry} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {entry.name}
            </span>
            {running ? (
              <Badge variant="success" className="h-4 shrink-0 gap-1 px-1.5 font-normal">
                <span className="h-1.5 w-1.5 rounded-full bg-success-foreground" />
                live
              </Badge>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{entry.engine}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0 font-mono">{size}</span>
            {installed && !running ? (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0 text-success/80">on disk</span>
              </>
            ) : null}
          </div>
        </div>
        {pill ? (
          <span
            className={cn(
              "hidden shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium sm:inline",
              pill.className
            )}
          >
            {pill.label}
          </span>
        ) : null}
        <CaretDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            expanded ? "rotate-180" : "rotate-0"
          )}
        />
      </button>

      {/* Expanded detail: fit verdict, stats, serve options, and actions. */}
      {expanded ? (
        <div className="space-y-4 px-4 pb-4 duration-200 animate-in fade-in-0">
          {entry.recipeId ? (
            <p className="font-mono text-xs text-muted-foreground">
              {entry.recipeId}
            </p>
          ) : null}
          {entry.description ? (
            <p className="text-sm text-muted-foreground">{entry.description}</p>
          ) : null}

          {/* Fit verdict for a servable pick (running models skip this). */}
          {running ? null : entry.recipeId && fit.reason ? (
            <div
              className={cn(
                "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm text-foreground",
                fit.canServe
                  ? "border-success/40 bg-success/10"
                  : "border-destructive/40 bg-destructive/10"
              )}
            >
              {fit.canServe ? (
                <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              ) : (
                <WarningCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              )}
              <span>{fit.reason}</span>
            </div>
          ) : !entry.recipeId ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
              <WarningCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span>{fit.reason}</span>
            </div>
          ) : entry.vramEstimateMb == null ? (
            <p className="text-xs text-muted-foreground">
              Size unknown — the daemon checks VRAM on launch.
            </p>
          ) : null}

          {/* Stats: on-disk facts + run history (#36). */}
          {hasStats ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {model?.bytes_total ? (
                <DetailStat label="On disk" value={fmtBytes(model.bytes_total)} />
              ) : entry.vramEstimateMb != null ? (
                <DetailStat label="Est. VRAM" value={gb(entry.vramEstimateMb)} />
              ) : null}
              {model ? (
                <DetailStat
                  label="Runs"
                  value={(model.run_count ?? 0).toLocaleString()}
                />
              ) : null}
              {lastServed ? (
                <DetailStat label="Last served" value={lastServed} />
              ) : null}
              {model?.last_max_model_len ? (
                <DetailStat
                  label="Last ctx"
                  value={model.last_max_model_len.toLocaleString()}
                />
              ) : null}
              {model && (model.available_on_nodes?.length ?? 0) > 1 ? (
                <DetailStat
                  label="Nodes"
                  value={String(model.available_on_nodes.length)}
                />
              ) : null}
            </div>
          ) : null}

          {/* Serve options — tucked behind Advanced so the default path is one click. */}
          {!running && entry.recipeId ? (
            <div className="space-y-3">
              <button
                type="button"
                onClick={onToggleAdvanced}
                className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {showAdvanced ? "Hide options" : "Advanced options"}
              </button>
              {showAdvanced ? (
                <div className="grid gap-3 rounded-lg border border-border bg-background/60 p-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor={`serve-maxlen-${entry.key}`} className="text-xs">
                      Max model length
                    </Label>
                    <Input
                      id={`serve-maxlen-${entry.key}`}
                      inputMode="numeric"
                      placeholder="recipe default"
                      value={maxLen}
                      onChange={(e) => onMaxLen(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`serve-name-${entry.key}`} className="text-xs">
                      Served name
                    </Label>
                    <Input
                      id={`serve-name-${entry.key}`}
                      placeholder="defaults to recipe id"
                      value={servedName}
                      onChange={(e) => onServedName(e.target.value)}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Actions. */}
          <div className="flex flex-wrap items-center gap-2">
            {running ? (
              <Button variant="destructive" size="sm" onClick={onStop}>
                <Square className="h-4 w-4" />
                Stop model
              </Button>
            ) : entry.recipeId ? (
              <Button size="sm" onClick={onServe} disabled={!fit.canServe}>
                <Lightning className="h-4 w-4" />
                {installed ? "Serve" : "Download & serve"}
                {targetLabel ? ` on ${targetLabel}` : ""}
              </Button>
            ) : null}
            {installed && !running ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onDelete}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash className="h-4 w-4" />
                Delete weights
              </Button>
            ) : null}
            {installed && running ? (
              <span className="text-xs text-muted-foreground">
                Stop the model to delete its weights.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function OrphanRow({
  orphan,
  onDelete,
}: {
  orphan: LaiosOrphanedModel
  onDelete: () => void
}) {
  return (
    <div className="flex items-center gap-2 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-foreground">
          {orphan.dir_name}
        </div>
        <div className="text-xs text-muted-foreground">
          {fmtBytes(orphan.bytes_on_disk)}
          {orphan.looks_complete ? " · looks complete" : " · incomplete"}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onDelete}
        aria-label={`Remove ${orphan.dir_name}`}
      >
        <Trash className="h-4 w-4" />
      </Button>
    </div>
  )
}
