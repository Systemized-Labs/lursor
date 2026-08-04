import { useEffect, useState } from "react"
import { toast } from "sonner"

import {
  useCreateLaiosConnection,
  useUpdateLaiosConnection,
} from "@/api/laios"
import type { LaiosConnection, LaiosConnectionInput } from "@/api/types"
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

interface FormState {
  name: string
  baseUrl: string
  gatewayUrl: string
  masterKey: string
}

const EMPTY: FormState = {
  name: "",
  baseUrl: "",
  gatewayUrl: "",
  masterKey: "",
}

interface LaiosConnectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connection?: LaiosConnection
}

export function LaiosConnectionDialog({
  open,
  onOpenChange,
  connection,
}: LaiosConnectionDialogProps) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const createConnection = useCreateLaiosConnection()
  const updateConnection = useUpdateLaiosConnection()
  const isEdit = Boolean(connection)
  const isSaving = createConnection.isPending || updateConnection.isPending

  useEffect(() => {
    if (open) {
      setForm(
        connection
          ? {
              name: connection.name,
              baseUrl: connection.base_url,
              gatewayUrl: connection.gateway_url ?? "",
              masterKey: "",
            }
          : EMPTY
      )
    }
  }, [open, connection])

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("Name is required")
      return
    }
    if (!form.baseUrl.trim()) {
      toast.error("Daemon URL is required")
      return
    }

    // On edit, an empty master key means "leave the stored key unchanged".
    const trimmedKey = form.masterKey.trim()
    const input: Partial<LaiosConnectionInput> = {
      name: form.name.trim(),
      base_url: form.baseUrl.trim(),
      // Empty means "derive it from the daemon URL", which is the null the
      // backend expects rather than an empty string.
      gateway_url: form.gatewayUrl.trim() || null,
    }
    if (!isEdit || trimmedKey) {
      input.master_key = trimmedKey || null
    }

    try {
      if (connection) {
        await updateConnection.mutateAsync({ id: connection.id, input })
        toast.success("Connection updated")
      } else {
        await createConnection.mutateAsync(input as LaiosConnectionInput)
        toast.success("Connection added")
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save connection"
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit LAIOS connection" : "Add LAIOS connection"}
          </DialogTitle>
          <DialogDescription>
            Point at a laios daemon control plane (usually port 7420). The
            master key is stored on the server and used to authenticate control
            requests — it is never sent to the browser.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="laios-name">Name</Label>
            <Input
              id="laios-name"
              placeholder="local"
              value={form.name}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, name: e.target.value }))
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="laios-url">Daemon URL</Label>
            <Input
              id="laios-url"
              placeholder="http://127.0.0.1:7420"
              value={form.baseUrl}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, baseUrl: e.target.value }))
              }
              className="font-mono text-sm"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              The control-plane base URL — the <code>laios daemon</code> address,
              not the OpenAI gateway on <code>:4000</code>. Used for managing the
              box: inventory, serve and stop.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="laios-gateway">Gateway URL (optional)</Label>
            <Input
              id="laios-gateway"
              placeholder="derived from the daemon URL on :4000"
              value={form.gatewayUrl}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, gatewayUrl: e.target.value }))
              }
              className="font-mono text-sm"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Where this box's <em>models</em> are reached — chat and video both.
              Set this to send model traffic somewhere other than the daemon's
              host, e.g. a lastway tunnel at{" "}
              <code>https://your-box.lastway.lursor.com</code>, while management
              above stays on the LAN. Leave empty to derive it.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="laios-key">
              Master key{isEdit ? " (leave blank to keep current)" : ""}
            </Label>
            <Input
              id="laios-key"
              type="password"
              placeholder="sk-laios-…"
              value={form.masterKey}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, masterKey: e.target.value }))
              }
              autoComplete="off"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              From <code>~/.laios/config/laios.toml</code> under{" "}
              <code>[gateway] master_key</code>.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving}>
            {isEdit ? "Save changes" : "Add connection"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
