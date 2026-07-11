import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { useLaiosBudget, useLaiosCatalog, useServeModel } from "@/api/laios"
import type { LaiosBudget, LaiosRecipeSummary, LaiosServeInput } from "@/api/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
}

const MIB_PER_GB = 1024

function gb(mib: number): string {
  return `${(mib / MIB_PER_GB).toFixed(1)} GB`
}

type Fit = "ok" | "tight" | "cluster" | "too-big" | "no-fit" | "unknown"

interface Compat {
  sizeLabel: string // "≈2.9 GB" or "size unknown"
  fit: Fit
  /** Hard, permanent incompatibility — disable in the dropdown. */
  unavailable: boolean
  /** Whether the model can be served right now. */
  canServe: boolean
  reason: string // human-readable verdict
}

// Classify a recipe against the machine's VRAM budget. `usable` is the most a
// single model could ever get (total minus the OS/engine reserve); `available`
// also subtracts what running models already hold.
function classify(recipe: LaiosRecipeSummary, budget: LaiosBudget | undefined): Compat {
  const est = recipe.vram_estimate_mb
  const sizeLabel = est == null ? "size unknown" : `≈${gb(est)}`

  if (recipe.cluster_only) {
    return {
      sizeLabel,
      fit: "cluster",
      unavailable: true,
      canServe: false,
      reason: "Requires a multi-node cluster — can't serve solo here.",
    }
  }
  if (est == null || !budget) {
    // Nothing to compare against — let the daemon's admission be the backstop.
    return { sizeLabel, fit: "unknown", unavailable: false, canServe: true, reason: "" }
  }

  const usable = Math.max(0, budget.total_mb - budget.reserved_mb)
  const available = Math.max(0, usable - budget.allocated_mb)

  if (est > usable) {
    return {
      sizeLabel,
      fit: "too-big",
      unavailable: true,
      canServe: false,
      reason: `Too large for this machine — needs ${gb(est)}, only ${gb(usable)} usable.`,
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
 * Spin up a model. Shows each recipe's estimated VRAM footprint and whether it
 * fits the machine laios runs on, so users don't launch models that are too big
 * (the daemon would reject them anyway — this surfaces it before the attempt).
 */
export function ServeModelDialog({
  open,
  onOpenChange,
  connectionId,
}: ServeModelDialogProps) {
  const { data: catalog, isLoading } = useLaiosCatalog(open ? connectionId : undefined)
  const { data: budget } = useLaiosBudget(open ? connectionId : undefined)
  const serve = useServeModel(connectionId)

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

  // Precompute compatibility for every recipe so the dropdown + verdict agree.
  const compatById = useMemo(() => {
    const m = new Map<string, Compat>()
    for (const r of catalog ?? []) m.set(r.id, classify(r, budget))
    return m
  }, [catalog, budget])

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

  const usable = budget ? Math.max(0, budget.total_mb - budget.reserved_mb) : undefined
  const available =
    budget && usable !== undefined ? Math.max(0, usable - budget.allocated_mb) : undefined

  async function handleServe() {
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

    try {
      const inst = await serve.mutateAsync(input)
      toast.success(`Serving ${inst.served_name} (${inst.status})`)
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to serve model")
    }
  }

  const serveDisabled = serve.isPending || !recipe || (compat ? !compat.canServe : false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Serve a model</DialogTitle>
          <DialogDescription>
            Launch a curated recipe on this daemon. Models that don't fit the
            machine's VRAM are disabled.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="serve-recipe">Recipe</Label>
              {available !== undefined && usable !== undefined ? (
                <span className="text-xs text-muted-foreground">
                  {gb(available)} free of {gb(usable)} usable
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
                          {c?.fit === "cluster"
                            ? " · cluster"
                            : c?.fit === "too-big"
                              ? " · too large"
                              : ""}
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
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
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

          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div>
              <Label htmlFor="serve-solo">Solo</Label>
              <p className="text-xs text-muted-foreground">
                Single-node serve (leave on unless running a cluster recipe).
              </p>
            </div>
            <Switch id="serve-solo" checked={solo} onCheckedChange={setSolo} />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={serve.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleServe} disabled={serveDisabled}>
            {serve.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Starting…
              </>
            ) : (
              "Serve model"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
