import { WarningCircle, CheckCircle } from "@phosphor-icons/react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import {
  providersApi,
  useCreateProvider,
  useUpdateProvider,
} from "@/api/providers"
import type {
  CustomProvider,
  CustomProviderInput,
  ProviderHealth,
} from "@/api/types"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
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
  apiKey: string
}

const EMPTY: FormState = {
  name: "",
  baseUrl: "",
  apiKey: "",
}

interface ProviderFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider?: CustomProvider
}

export function ProviderFormDialog({
  open,
  onOpenChange,
  provider,
}: ProviderFormDialogProps) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProviderHealth | null>(null)
  const createProvider = useCreateProvider()
  const updateProvider = useUpdateProvider()
  const isEdit = Boolean(provider)
  const isSaving = createProvider.isPending || updateProvider.isPending

  useEffect(() => {
    if (open) {
      setTestResult(null)
      setForm(
        provider
          ? {
              name: provider.name,
              baseUrl: provider.base_url,
              apiKey: provider.api_key ?? "",
            }
          : EMPTY
      )
    }
  }, [open, provider])

  async function handleTest() {
    if (!form.baseUrl.trim()) {
      toast.error("Base URL is required to test")
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const result = await providersApi.test({
        name: form.name.trim() || "test",
        base_url: form.baseUrl.trim(),
        api_key: form.apiKey.trim() || null,
      })
      setTestResult(result)
    } catch (err) {
      setTestResult({
        status: "error",
        model_count: null,
        error: err instanceof Error ? err.message : "Test failed",
      })
    } finally {
      setTesting(false)
    }
  }

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("Name is required")
      return
    }
    if (!form.baseUrl.trim()) {
      toast.error("Base URL is required")
      return
    }

    const input: CustomProviderInput = {
      name: form.name.trim(),
      base_url: form.baseUrl.trim(),
      api_key: form.apiKey.trim() || null,
    }

    try {
      if (provider) {
        await updateProvider.mutateAsync({ id: provider.id, input })
        toast.success("Provider updated")
      } else {
        await createProvider.mutateAsync(input)
        toast.success("Provider added")
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save provider")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit provider" : "Add provider"}</DialogTitle>
          <DialogDescription>
            Point at any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM,
            llama.cpp). Its models appear in the picker automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="provider-name">Name</Label>
            <Input
              id="provider-name"
              placeholder="Local Ollama"
              value={form.name}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, name: e.target.value }))
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="provider-url">Base URL</Label>
            <Input
              id="provider-url"
              placeholder="http://localhost:11434/v1"
              value={form.baseUrl}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, baseUrl: e.target.value }))
              }
              className="font-mono text-sm"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              The OpenAI-compatible base URL, usually ending in <code>/v1</code>.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="provider-key">API key (optional)</Label>
            <Input
              id="provider-key"
              type="password"
              placeholder="Leave blank for local servers"
              value={form.apiKey}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, apiKey: e.target.value }))
              }
              autoComplete="off"
            />
          </div>

          {testResult ? (
            testResult.status === "ok" ? (
              <div className="flex items-center gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-foreground">
                <CheckCircle className="h-4 w-4 shrink-0 text-success" />
                <span>
                  Connected
                  {typeof testResult.model_count === "number"
                    ? ` — ${testResult.model_count} model${
                        testResult.model_count === 1 ? "" : "s"
                      } available.`
                    : "."}
                </span>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
                <WarningCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <span>{testResult.error ?? "Could not reach the provider."}</span>
              </div>
            )
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleTest}
            disabled={isSaving || testing}
            className="sm:mr-auto"
          >
            {testing ? (
              <>
                <DotGridLoader size="xs" />
                Testing…
              </>
            ) : (
              "Test connection"
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving}>
            {isEdit ? "Save changes" : "Add provider"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
