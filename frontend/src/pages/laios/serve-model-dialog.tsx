import { Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { useLaiosCatalog, useServeModel } from "@/api/laios"
import type { LaiosServeInput } from "@/api/types"
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

/**
 * Spin up a model: pick a recipe from the daemon's catalog and optionally
 * override serve knobs. The daemon admits against the VRAM budget and promotes
 * the instance to ready in the background; the page polls instances to reflect
 * the transition.
 */
export function ServeModelDialog({
  open,
  onOpenChange,
  connectionId,
}: ServeModelDialogProps) {
  const { data: catalog, isLoading } = useLaiosCatalog(
    open ? connectionId : undefined
  )
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

  async function handleServe() {
    if (!recipe) {
      toast.error("Pick a recipe to serve")
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Serve a model</DialogTitle>
          <DialogDescription>
            Launch a curated recipe on this daemon. It is admitted against the
            VRAM budget and registered in the gateway once ready.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="serve-recipe">Recipe</Label>
            <Select value={recipe} onValueChange={setRecipe}>
              <SelectTrigger id="serve-recipe">
                <SelectValue
                  placeholder={isLoading ? "Loading catalog…" : "Select a recipe"}
                />
              </SelectTrigger>
              <SelectContent>
                {(catalog ?? []).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name} · {r.engine}
                    {r.cluster_only ? " · cluster" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Recipes come from the daemon's <code>catalog</code>.
            </p>
          </div>

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
          <Button onClick={handleServe} disabled={serve.isPending}>
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
