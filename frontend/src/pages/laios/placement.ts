/**
 * Where a model lands when you serve it.
 *
 * The daemon accepts exactly one of three placement shapes on `/v1/serve`, and
 * they are genuinely different operations — this module is the single place
 * that maps a UI choice onto the right one and knows which choices are legal:
 *
 * | Placement | Payload | What the daemon does |
 * |---|---|---|
 * | head | `{solo: true}` | one engine on the head |
 * | auto | `{worker: "auto"}` | one engine on the Ready worker with the most free VRAM |
 * | worker | `{worker: <node id>}` | one engine on that peer; head's gateway fronts it |
 * | shard | `{nodes: [...]}` | ONE model split across ranks (Ray / mp) |
 *
 * Two models on two nodes are *replicas* (serve twice, once per node) — the
 * gateway pools same-named instances automatically. That is not the same thing
 * as `shard`, which is one model too big for any single node.
 *
 * A shard's `nodes[]` is rank-ordered and the daemon roots it on the first
 * entry. That entry may be a worker: a shard of all-worker members runs
 * entirely off-head, which is how a cluster-only recipe gets a second replica
 * while the head is still busy serving the first.
 */

import type {
  LaiosClusterStatus,
  LaiosRecipeSummary,
  LaiosServeInput,
} from "@/api/types"

/**
 * Fabric host with no scheme or port — the form `nodes[]` entries must take.
 * Mirrors the daemon's `host_of_advertise`.
 */
export function hostOfAdvertise(advertise: string): string {
  const bare = advertise.replace(/^https?:\/\//, "")
  return bare.split(":")[0] ?? bare
}

/** A node a model can be placed on: the head, or one worker. */
export interface NodeTarget {
  nodeId: string
  name: string
  role: "head" | "worker"
  /** Fabric address for `nodes[]`; empty when the head advertises nothing usable. */
  host: string
  online: boolean
  status: string
  gpus: number
  totalVramMb: number
  freeVramMb: number
  /**
   * Accepts work now — the daemon takes Ready *or* Busy workers, for a solo
   * engine and for a shard rank alike. Whether there's *room* is a separate
   * question, answered by the VRAM numbers below.
   */
  placeable: boolean
  /**
   * Can be the daemon's `worker: "auto"` pick, which is stricter than
   * `placeable`: that path considers Ready workers only, so a Busy one must not
   * be shown as the destination auto would choose.
   */
  autoEligible: boolean
}

/**
 * Merge the cluster rollup's per-node resources with the worker roster, which
 * is the only place addresses live. Head first, then workers in roster order.
 */
export function nodeTargets(
  cluster: LaiosClusterStatus | undefined
): NodeTarget[] {
  const nodes = cluster?.resources?.nodes
  if (!cluster || !nodes) return []
  const advertiseById = new Map(
    (cluster.workers ?? []).map((w) => [w.id, w.advertise])
  )
  return nodes.map((n) => {
    const head = n.role === "head"
    const advertise = head ? cluster.advertise : advertiseById.get(n.node_id)
    const ready = n.status === "ready"
    return {
      nodeId: n.node_id,
      name: n.name,
      role: head ? "head" : "worker",
      host: advertise ? hostOfAdvertise(advertise) : "",
      online: n.online,
      status: n.status,
      gpus: n.gpus,
      totalVramMb: n.total_vram_mb,
      freeVramMb: n.free_vram_mb,
      placeable: head || (n.online && (ready || n.status === "busy")),
      autoEligible: !head && n.online && ready,
    }
  })
}

/**
 * A chosen placement. `shard` lists every member in rank order — `nodeIds[0]`
 * is rank 0, the node that binds the HTTP API and hosts the rendezvous.
 *
 * The head is one candidate among them, not a fixture: a shard whose members
 * are all workers runs entirely off-head, which is the only way to place a
 * second replica of a cluster-only recipe once the head's own VRAM is spent.
 */
export type Placement =
  | { kind: "head" }
  | { kind: "auto" }
  | { kind: "worker"; nodeId: string }
  | { kind: "shard"; nodeIds: string[] }

/**
 * Drop a placement that no longer refers to something servable — a worker that
 * went offline, or a shard whose peers all dropped out — back to the head.
 */
export function resolvePlacement(
  placement: Placement,
  targets: NodeTarget[]
): Placement {
  switch (placement.kind) {
    case "auto":
      return targets.some((t) => t.autoEligible)
        ? placement
        : { kind: "head" }
    case "worker": {
      const t = targets.find((n) => n.nodeId === placement.nodeId)
      return t?.placeable ? placement : { kind: "head" }
    }
    case "shard": {
      const live = placement.nodeIds.filter((id) =>
        targets.some((t) => t.nodeId === id && t.placeable)
      )
      // Below two members it is no longer a shard; the daemon would reject it.
      return live.length >= 2 ? { kind: "shard", nodeIds: live } : { kind: "head" }
    }
    default:
      return placement
  }
}

/** Nodes a placement actually spans, in rank order for a shard. */
export function placementNodes(
  placement: Placement,
  targets: NodeTarget[]
): NodeTarget[] {
  const byId = (id: string) => targets.find((t) => t.nodeId === id)
  switch (placement.kind) {
    case "head": {
      const head = targets.find((t) => t.role === "head")
      return head ? [head] : []
    }
    case "auto": {
      // Same rule the daemon applies: the Ready worker with the most free VRAM.
      const best = targets
        .filter((t) => t.autoEligible)
        .sort((a, b) => b.freeVramMb - a.freeVramMb)[0]
      return best ? [best] : []
    }
    case "worker": {
      const t = byId(placement.nodeId)
      return t ? [t] : []
    }
    case "shard":
      // Rank order as chosen — no implicit head.
      return placement.nodeIds
        .map(byId)
        .filter((t): t is NodeTarget => Boolean(t))
  }
}

/** Short human name for the destination, for buttons and fit verdicts. */
export function placementLabel(
  placement: Placement,
  targets: NodeTarget[]
): string {
  const nodes = placementNodes(placement, targets)
  switch (placement.kind) {
    case "head":
      return nodes[0]?.name ?? "this node"
    case "auto":
      return nodes[0] ? `${nodes[0].name} (auto)` : "the best worker"
    case "worker":
      return nodes[0]?.name ?? "the selected worker"
    case "shard":
      return `${nodes.length} nodes`
  }
}

/**
 * The `/v1/serve` placement fields for a choice. A shard sends member fabric
 * IPs in rank order — `resolve_cluster_nodes` roots it on the first — while
 * everything else sends an id the daemon resolves itself.
 */
export function placementInput(
  placement: Placement,
  targets: NodeTarget[]
): Pick<LaiosServeInput, "solo" | "worker" | "nodes"> {
  switch (placement.kind) {
    case "auto":
      return { worker: "auto" }
    case "worker":
      return { worker: placement.nodeId }
    case "shard":
      return {
        nodes: placementNodes(placement, targets)
          .map((t) => t.host)
          .filter(Boolean),
      }
    case "head":
    default:
      return { solo: true }
  }
}

/** What a recipe will and won't accept, normalized over older daemon shapes. */
export interface RecipeConstraints {
  clusterOnly: boolean
  soloOnly: boolean
  /** Lower bound for a multi-node serve; the daemon defaults cluster_only to 2. */
  minNodes: number
  maxNodes?: number
  /** Ranks the model splits into. Undefined on daemons that don't report it. */
  tensorParallel?: number
}

export function recipeConstraints(r: LaiosRecipeSummary): RecipeConstraints {
  // `cluster` is absent on daemons predating the cluster summary; the top-level
  // `cluster_only` flag has always been there, so fall back to it alone.
  const clusterOnly = r.cluster?.cluster_only ?? r.cluster_only
  return {
    clusterOnly,
    soloOnly: r.cluster?.solo_only ?? false,
    minNodes: r.cluster?.min_nodes ?? (clusterOnly ? 2 : 1),
    maxNodes: r.cluster?.max_nodes,
    tensorParallel: r.cluster?.tensor_parallel,
  }
}

/**
 * How many ways a model is split for a given placement.
 *
 * Only a shard divides a model across machines, and it divides by the recipe's
 * tensor-parallel width — not by however many nodes were picked, which the
 * daemon truncates to that same width. Falls back to the node count for daemons
 * that don't report `tensor_parallel`, which is what the two agree on anyway
 * for every shipped multi-node recipe.
 */
export function placementSplit(
  placement: Placement,
  constraints: RecipeConstraints,
  nodeCount: number
): number {
  if (placement.kind !== "shard") return 1
  return Math.max(1, constraints.tensorParallel ?? nodeCount)
}
