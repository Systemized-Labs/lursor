import { WarningCircle, CheckCircle } from "@phosphor-icons/react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { useLaiosBudget, useLaiosCatalog, useLaiosCluster } from "@/api/laios"
import type { LaiosRecipeSummary, LaiosServeInput } from "@/api/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/responsive-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

interface ServeModelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  // Kicks off the download → start flow; a pending card appears under Models.
  onServe: (input: LaiosServeInput, name: string) => void
}

const MIB_PER_GB = 1024

function gb(mib: number): string {
  return `${(mib / MIB_PER_GB).toFixed(1)} GB`
}

type Fit = "ok" | "tight" | "cluster" | "too-big" | "no-fit" | "unknown"

interface Compat {
  sizeLabel: string // "≈2.9 GB" or "size unknown"
  fit: Fit
  /** Hard, permanent incompatibility for the current mode — disable in the dropdown. */
  unavailable: boolean
  /** Whether the model can be served right now. */
  canServe: boolean
  reason: string // human-readable verdict
}

// Normalized VRAM pool the serve targets: `usable` is the most a single model
// could ever get; `available` is what's free right now. In solo mode this is
// one machine's budget; in cluster mode it's the aggregate across live nodes.
interface VramPool {
  usable: number
  available: number
  scope: "machine" | "cluster"
}

// Classify a recipe against the VRAM pool for the chosen mode. Cluster-only
// recipes can't run solo; everything else is compared against the pool.
function classify(recipe: LaiosRecipeSummary, solo: boolean, pool: VramPool | undefined): Compat {
  const est = recipe.vram_estimate_mb
  const sizeLabel = est == null ? "size unknown" : `≈${gb(est)}`

  if (solo && recipe.cluster_only) {
    return {
      sizeLabel,
      fit: "cluster",
      unavailable: true,
      canServe: false,
      reason: "Requires a multi-node cluster — turn off Solo to serve it.",
    }
  }
  if (est == null || !pool) {
    // Nothing to compare against — let the daemon's admission be the backstop.
    return { sizeLabel, fit: "unknown", unavailable: false, canServe: true, reason: "" }
  }

  const { usable, available, scope } = pool
  const where = scope === "cluster" ? "the cluster" : "this machine"

  if (est > usable) {
    return {
      sizeLabel,
      fit: "too-big",
      unavailable: true,
      canServe: false,
      reason: `Too large for ${where} — needs ${gb(est)}, only ${gb(usable)} usable.`,
    }
  }
  if (est > available) {
    return {
      sizeLabel,
      fit: "no-fit",
      unavailable: false,
      canServe: false,
      reason: `Not enough free VRAM — needs ${gb(est)}, ${gb(available)} free. Stop a running model first.`,
    }
  }
  return {
    sizeLabel,
    fit: est > available * 0.85 ? "tight" : "ok",
    unavailable: false,
    canServe: true,
    reason: `Fits — ${gb(est)} of ${gb(available)} free.`,
  }
}

/**
 * Pick a recipe and kick off a serve. The actual download → start lifecycle is
 * owned by the serve manager and shown as a live card under Models, so this
 * dialog just validates the choice and closes.
 */
export function ServeModelDialog({
  open,
  onOpenChange,
  connectionId,
  onServe,
}: ServeModelDialogProps) {
  const { data: catalog, isLoading } = useLaiosCatalog(open ? connectionId : undefined)
  const { data: budget } = useLaiosBudget(open ? connectionId : undefined)
  const { data: cluster } = useLaiosCluster(open ? connectionId : undefined)

  const [recipe, setRecipe] = useState<string>("")
  const [maxLen, setMaxLen] = useState<string>("")
  const [servedName, setServedName] = useState<string>("")
  const [solo, setSolo] = useState<boolean>(true)

  useEffect(() => {
    if (open) {
      setRecipe("")
      setMaxLen("")
      setServedName("")
      setSolo(true)
    }
  }, [open])

  // The single-machine pool: total minus the OS/engine reserve, then minus what
  // running models already hold.
  const soloPool = useMemo<VramPool | undefined>(() => {
    if (!budget) return undefined
    const usable = Math.max(0, budget.total_mb - budget.reserved_mb)
    return { usable, available: Math.max(0, usable - budget.allocated_mb), scope: "machine" }
  }, [budget])

  // The cluster-wide pool: aggregate VRAM across online nodes.
  const clusterPool = useMemo<VramPool | undefined>(() => {
    const res = cluster?.resources
    if (!res) return undefined
    return { usable: res.total_vram_mb, available: res.free_vram_mb, scope: "cluster" }
  }, [cluster])

  // Solo serves into one machine; cluster mode serves into the whole cluster.
  const activePool = solo ? soloPool : clusterPool

  // Precompute compatibility for every recipe so the dropdown + verdict agree.
  const compatById = useMemo(() => {
    const m = new Map<string, Compat>()
    for (const r of catalog ?? []) m.set(r.id, classify(r, solo, activePool))
    return m
  }, [catalog, solo, activePool])

  // Runnable recipes first (then those needing freed VRAM, then unavailable),
  // and smallest first within each group so the easiest pick is at the top.
  const sortedCatalog = useMemo(() => {
    const rank = (c: Compat | undefined): number =>
      !c ? 0 : c.canServe ? 0 : c.unavailable ? 2 : 1
    return [...(catalog ?? [])].sort((a, b) => {
      const byRank = rank(compatById.get(a.id)) - rank(compatById.get(b.id))
      if (byRank !== 0) return byRank
      const sa = a.vram_estimate_mb ?? Number.POSITIVE_INFINITY
      const sb = b.vram_estimate_mb ?? Number.POSITIVE_INFINITY
      return sa - sb
    })
  }, [catalog, compatById])

  const selected = catalog?.find((r) => r.id === recipe)
  const compat = recipe ? compatById.get(recipe) : undefined

  const usable = activePool?.usable
  const available = activePool?.available

  function handleServe() {
    if (!recipe) {
      toast.error("Pick a recipe to serve")
      return
    }
    if (compat && !compat.canServe) {
      toast.error(compat.reason)
      return
    }
    const input: LaiosServeInput = { recipe, solo }
    if (maxLen.trim()) {
      const n = Number(maxLen.trim())
      if (!Number.isFinite(n) || n <= 0) {
        toast.error("Max model length must be a positive number")
        return
      }
      input.max_model_len = n
    }
    if (servedName.trim()) input.served_name = servedName.trim()

    onServe(input, servedName.trim() || selected?.name || recipe)
    onOpenChange(false)
  }

  const serveDisabled = !recipe || (compat ? !compat.canServe : false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Serve a model</DialogTitle>
          <DialogDescription>
            Launch a curated recipe on this daemon. It downloads (if needed) then
            starts — you'll see its progress under Models. Recipes that don't fit
            the available VRAM (solo machine or whole cluster) are disabled.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div>
              <Label htmlFor="serve-solo">Solo</Label>
              <p className="text-xs text-muted-foreground">
                Single-node serve. Turn off to serve across the cluster and run
                larger, multi-node recipes.
              </p>
            </div>
            <Switch id="serve-solo" checked={solo} onCheckedChange={setSolo} />
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="serve-recipe">Recipe</Label>
              {available !== undefined && usable !== undefined ? (
                <span className="text-xs text-muted-foreground">
                  {gb(available)} free of {gb(usable)} usable
                  {solo ? "" : " · cluster"}
                </span>
              ) : null}
            </div>
            <Select value={recipe} onValueChange={setRecipe}>
              <SelectTrigger id="serve-recipe">
                <SelectValue
                  placeholder={isLoading ? "Loading catalog…" : "Select a recipe"}
                />
              </SelectTrigger>
              <SelectContent>
                {sortedCatalog.map((r) => {
                  const c = compatById.get(r.id)
                  return (
                    <SelectItem key={r.id} value={r.id} disabled={c?.unavailable}>
                      <span className="flex w-full items-center justify-between gap-3">
                        <span className="truncate">
                          {r.name} · {r.engine}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {c?.sizeLabel}
                          {r.cluster_only ? " · cluster" : ""}
                          {c?.fit === "too-big" ? " · too large" : ""}
                        </span>
                      </span>
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>

          {compat && compat.reason ? (
            <div
              className={
                compat.canServe
                  ? "flex items-start gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-foreground"
                  : "flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground"
              }
            >
              {compat.canServe ? (
                <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              ) : (
                <WarningCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              )}
              <span>{compat.reason}</span>
            </div>
          ) : selected && compat?.fit === "unknown" ? (
            <p className="text-xs text-muted-foreground">
              Size unknown for this recipe — the daemon will check VRAM on launch.
            </p>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="serve-maxlen">Max model length (optional)</Label>
              <Input
                id="serve-maxlen"
                inputMode="numeric"
                placeholder="e.g. 8192"
                value={maxLen}
                onChange={(e) => setMaxLen(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="serve-name">Served name (optional)</Label>
              <Input
                id="serve-name"
                placeholder="defaults to recipe id"
                value={servedName}
                onChange={(e) => setServedName(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleServe} disabled={serveDisabled}>
            Serve model
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
