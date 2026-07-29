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
  placementSplit,
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

// One machine's VRAM: `usable` is the most a model could ever get there,
// `available` is what's free right now.
interface NodeVram {
  name: string
  usable: number
  available: number
}

// The VRAM a placement can draw on, kept per node rather than summed.
//
// A shard does not pool memory: every rank holds its own slice on its own GPU,
// so a total is the wrong number to compare against — head 2 GB + peer 200 GB
// looks like plenty in aggregate and fits nowhere. `label` names the
// destination so every verdict says where it applies.
interface VramPool {
  nodes: NodeVram[]
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
  pool: VramPool | undefined,
  /** Ranks the model splits into — 1 for anything but a shard. */
  split: number
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

  if (est == null || !pool || pool.nodes.length === 0) {
    return { fit: "unknown", unavailable: false, canServe: true, reason: "" }
  }
  // What one rank has to hold. The whole model on a single-node placement; its
  // slice on a shard — the same `estimate / tensor_parallel` the daemon admits
  // against, node by node.
  const perNode = Math.ceil(est / Math.max(1, split))
  // The daemon trims a shard's members to the tensor-parallel width, so judge
  // the nodes it would actually use — picking three for a tp=2 recipe must not
  // be failed by the third, which never gets a rank.
  const nodes = split > 1 ? pool.nodes.slice(0, split) : pool.nodes
  const { label } = pool
  // A shard's verdict has to name the node it turns on, since the others may
  // have room to spare.
  const each = split > 1 ? `${gb(perNode)} on each of ${nodes.length} nodes` : gb(perNode)

  const tooSmall = nodes.find((n) => perNode > n.usable)
  if (tooSmall) {
    return {
      fit: "too-big",
      unavailable: true,
      canServe: false,
      reason: `Too large for ${split > 1 ? tooSmall.name : label} — needs ${each}, only ${gb(
        tooSmall.usable
      )} usable${split > 1 ? ` on ${tooSmall.name}` : ""}.`,
    }
  }
  const full = nodes.find((n) => perNode > n.available)
  if (full) {
    return {
      fit: "no-fit",
      unavailable: false,
      canServe: false,
      reason: `Not enough free VRAM on ${full.name} — needs ${each}, ${gb(
        full.available
      )} free there. Stop a running model or pick another node.`,
    }
  }
  const tightest = Math.min(...nodes.map((n) => n.available))
  return {
    fit: perNode > tightest * 0.85 ? "tight" : "ok",
    unavailable: false,
    canServe: true,
    reason: `Fits on ${label} — ${each}, ${gb(tightest)} free on the tightest.`,
  }
}

// A single unified list entry: a catalog recipe, optionally backed by installed
// weights and/or live instances — plus anything live or on disk whose recipe has
// since left the catalog. This is the merge: everything the daemon knows about a
// model, servable or not, is one row here.
interface ModelEntry {
  key: string
  /** Identity, shown and searchable. Known for anything on disk or running. */
  recipeId: string | null
  name: string
  engine: string
  description: string | null
  vramEstimateMb: number | null
  constraints: RecipeConstraints
  installed: boolean
  /**
   * Whether a catalog recipe still backs this row — the servability gate. A
   * known `recipeId` is not enough: weights and live instances both outlive the
   * recipe file they came from, and `/v1/serve` can only start what the daemon's
   * catalog still holds.
   */
  recipePresent: boolean
  model?: LaiosModel
  /**
   * Every live instance of this recipe, across all nodes. A list rather than a
   * single instance because the same model on N nodes is N replicas, which the
   * gateway pools — so already running somewhere must never stop you from
   * serving it somewhere else.
   */
  instances: LaiosInstance[]
  fit: Compat
}

type FilterKey = "all" | "ready" | "installed" | "running"

const FILTERS: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "ready", label: "Ready" },
  { key: "installed", label: "Installed" },
  { key: "running", label: "Running" },
]

// A short fit pill for the collapsed row: label + tone by fit outcome. Shown
// even for live models — it describes the *next* serve, which is a replica on
// whatever node is currently selected.
function fitPill(entry: ModelEntry): { label: string; className: string } | null {
  if (!entry.recipePresent) {
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
  // A specific replica, not a model: stopping is per instance now that one
  // recipe can be live on several nodes at once.
  const [toStop, setToStop] = useState<LaiosInstance | undefined>()

  // Every node this daemon can place on, head first. Empty when the daemon has
  // no cluster, which is what hides the picker.
  const targets = useMemo(() => nodeTargets(cluster), [cluster])
  const isCluster = (cluster?.resources?.total_nodes_known ?? 0) > 1
  // Names the node a replica sits on. Falls back to a short id for a node that
  // has since left the roster but still has an instance attributed to it.
  const nodeName = useMemo(() => {
    const byId = new Map(targets.map((t) => [t.nodeId, t.name]))
    return (id: string) => byId.get(id) ?? id.slice(0, 8)
  }, [targets])
  const shardAvailable =
    isCluster && targets.some((t) => t.role === "worker" && t.placeable)

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
        nodes: [
          {
            name: "this machine",
            usable,
            available: Math.max(0, usable - budget.allocated_mb),
          },
        ],
        label: "this machine",
      }
    }
    if (activeNodes.length === 0) return undefined
    return {
      nodes: activeNodes.map((n) => ({
        name: n.name,
        usable: n.totalVramMb,
        available: n.freeVramMb,
      })),
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
    //
    // Every live instance is kept, not just the first: replicas of one recipe on
    // different nodes are all real, each stoppable on its own.
    const runningByRecipe = new Map<string, LaiosInstance[]>()
    for (const inst of instances ?? []) {
      if (inst.status === "stopped" || inst.status === "failed") continue
      const list = runningByRecipe.get(inst.recipe_id)
      if (list) list.push(inst)
      else runningByRecipe.set(inst.recipe_id, [inst])
    }
    // Live ones first, then by node, so the list order is stable across polls.
    for (const list of runningByRecipe.values()) {
      list.sort(
        (a, b) =>
          (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1) ||
          a.node_id.localeCompare(b.node_id)
      )
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
        instances: runningByRecipe.get(r.id) ?? [],
        fit: classify(
          r.vram_estimate_mb,
          constraints,
          active,
          activeNodes.length,
          shardAvailable,
          activePool,
          placementSplit(active, constraints, activeNodes.length)
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
        recipeId: m.recipe_id,
        name: m.name,
        engine: m.engine,
        description: null,
        vramEstimateMb: null,
        constraints: { clusterOnly: false, soloOnly: false, minNodes: 1 },
        installed: true,
        recipePresent: false,
        model: m,
        instances: runningByRecipe.get(m.recipe_id) ?? [],
        fit: {
          fit: "unknown",
          unavailable: true,
          canServe: false,
          reason: "No recipe for these weights — delete or re-add a recipe.",
        },
      }))

    // Anything still running whose recipe id matches no row above. Attribution
    // is by recipe id, so an instance started from a recipe that has since left
    // the catalog had nowhere to attach and vanished from this list entirely —
    // indistinguishable from nothing running, and impossible to stop from here.
    const covered = new Set<string>([
      ...catalogIds,
      ...orphanModels.map((e) => e.recipeId).filter((id): id is string => !!id),
    ])
    const fromInstances: ModelEntry[] = [...runningByRecipe.entries()]
      .filter(([recipeId]) => !covered.has(recipeId))
      .map(([recipeId, list]) => {
        const model = modelByRecipe.get(recipeId)
        // These weights may still be servable under another recipe — worth
        // naming, since it's the actual route to another copy.
        const alt = (model?.usable_recipes ?? []).find((rid) =>
          catalogIds.has(rid)
        )
        return {
          key: `instance:${recipeId}`,
          recipeId,
          name: list[0].served_name || recipeId,
          engine: list[0].engine,
          description: null,
          vramEstimateMb: null,
          constraints: { clusterOnly: false, soloOnly: false, minNodes: 1 },
          installed: Boolean(model?.installed),
          recipePresent: false,
          model,
          instances: list,
          fit: {
            fit: "unknown",
            unavailable: true,
            canServe: false,
            reason: alt
              ? `Running, but its recipe "${recipeId}" is no longer in the catalog — serve "${alt}" for another copy of these weights.`
              : `Running, but its recipe "${recipeId}" is no longer in the catalog — restore the recipe file to serve another copy.`,
          },
        }
      })

    return [...fromCatalog, ...orphanModels, ...fromInstances]
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
      e.instances.length > 0
        ? 0
        : e.fit.canServe
          ? 1
          : e.installed
            ? 2
            : e.fit.unavailable
              ? 4
              : 3
    return entries
      .filter((e) => {
        if (q && !`${e.name} ${e.recipeId ?? ""} ${e.engine}`.toLowerCase().includes(q))
          return false
        // "Ready" means servable right now — including another replica of
        // something already live elsewhere.
        if (filter === "ready") return e.fit.canServe
        if (filter === "installed") return e.installed
        if (filter === "running") return e.instances.length > 0
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
  const runningCount = entries.filter((e) => e.instances.length > 0).length

  function toggleExpanded(key: string) {
    setExpandedKey((cur) => (cur === key ? undefined : key))
    // Reset the per-model serve overrides whenever the open row changes.
    setShowAdvanced(false)
    setMaxLen("")
    setServedName("")
  }

  function handleServe(entry: ModelEntry) {
    if (!entry.recipePresent || !entry.recipeId || !entry.fit.canServe) return
    const target = placementInput(active, targets)
    // A shard is addressed by fabric IP, so every member needs a routable
    // advertise — a node still on loopback would silently drop out of the
    // member list. Compare against the members actually chosen rather than a
    // floor of two, or a 3-node shard quietly serves as a 2-node one.
    if (active.kind === "shard") {
      const addressed = target.nodes?.length ?? 0
      if (addressed < activeNodes.length || addressed < 2) {
        const missing = activeNodes.filter((n) => !n.host).map((n) => n.name)
        toast.error(
          `Multi-node serve needs every node's fabric address — set node.advertise to the CX-7 IP on ${
            missing.join(", ") || "every member"
          }.`
        )
        return
      }
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
    if (!target) return
    try {
      await stopInstance.mutateAsync(target.id)
      toast.success(`Stopping ${target.served_name}`)
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
              nodeName={nodeName}
              targetNodeIds={isCluster ? activeNodes.map((n) => n.nodeId) : []}
              onServe={() => handleServe(e)}
              onDelete={() => setToDelete(e)}
              onStop={setToStop}
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
          toStop
            ? `Stop "${toStop.served_name}" on ${nodeName(
                toStop.node_id
              )}? This tears down that engine and frees its VRAM. Replicas on other nodes keep serving.`
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
  const tone = entry.instances.length > 0
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
  nodeName,
  targetNodeIds,
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
  nodeName: (nodeId: string) => string
  /** Nodes the current placement spans; empty on a standalone daemon. */
  targetNodeIds: string[]
  onServe: () => void
  onDelete: () => void
  onStop: (instance: LaiosInstance) => void
}) {
  const { instances, installed, model, fit } = entry
  const live = instances.length > 0
  const lastServed = fmtAgo(model?.last_served_at)
  const pill = fitPill(entry)
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
            {live ? (
              <Badge variant="success" className="h-4 shrink-0 gap-1 px-1.5 font-normal">
                <span className="h-1.5 w-1.5 rounded-full bg-success-foreground" />
                {instances.length > 1 ? `live on ${instances.length}` : "live"}
              </Badge>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{entry.engine}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0 font-mono">{size}</span>
            {installed && !live ? (
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

          {/* Where it's live right now — one line per replica, each stoppable
              on its own. Serving again below adds to this list rather than
              replacing it. */}
          {live ? (
            <div className="space-y-1.5">
              <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                {instances.length > 1 ? "Running replicas" : "Running"}
              </div>
              <div className="divide-y divide-border/60 rounded-lg border border-border bg-background/60">
                {instances.map((inst) => (
                  <div key={inst.id} className="flex items-center gap-2 px-3 py-2">
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        inst.status === "running" ? "bg-success" : "bg-warning"
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-foreground">
                        {nodeName(inst.node_id)}
                        {targetNodeIds.includes(inst.node_id) ? (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            selected node
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {inst.served_name}
                        {inst.status === "running" ? "" : ` · ${inst.status}`}
                        {inst.vram_allocated_mb > 0
                          ? ` · ${gb(inst.vram_allocated_mb)}`
                          : ""}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onStop(inst)}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                    >
                      <Square className="h-4 w-4" />
                      Stop
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Fit verdict for the next serve — for a live model this is about a
              replica on the currently selected node, not the one already up. */}
          {entry.recipePresent && fit.reason ? (
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
          ) : !entry.recipePresent ? (
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
          {entry.recipePresent ? (
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
            {entry.recipePresent ? (
              <Button size="sm" onClick={onServe} disabled={!fit.canServe}>
                <Lightning className="h-4 w-4" />
                {!installed
                  ? "Download & serve"
                  : live
                    ? "Serve another"
                    : "Serve"}
                {targetLabel ? ` on ${targetLabel}` : ""}
              </Button>
            ) : null}
            {installed && !live ? (
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
            {installed && live ? (
              <span className="text-xs text-muted-foreground">
                {instances.length > 1
                  ? "Stop every replica to delete its weights."
                  : "Stop the model to delete its weights."}
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
