import { CheckCircle2, KeyRound, Loader2, Trash2, XCircle } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import {
  settingsApi,
  useClearOpenRouterKey,
  useOpenRouterSettings,
  useSaveOpenRouterKey,
} from "@/api/settings"
import type { OpenRouterTestResult } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function OpenRouterSection() {
  const { data: settings, isLoading } = useOpenRouterSettings()
  const save = useSaveOpenRouterKey()
  const clear = useClearOpenRouterKey()

  const [key, setKey] = useState("")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<OpenRouterTestResult | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const configured = Boolean(settings?.configured)
  const fromEnv = settings?.source === "env"

  async function handleSave() {
    if (!key.trim()) {
      toast.error("Enter a key first")
      return
    }
    try {
      await save.mutateAsync({ api_key: key.trim() })
      toast.success("OpenRouter key saved")
      setKey("")
      setTestResult(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save key")
    }
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      // Test the typed key if present, otherwise the currently-saved one.
      const result = await settingsApi.testOpenRouter(
        key.trim() ? { api_key: key.trim() } : {}
      )
      setTestResult(result)
    } catch (err) {
      setTestResult({
        status: "error",
        label: null,
        error: err instanceof Error ? err.message : "Test failed",
      })
    } finally {
      setTesting(false)
    }
  }

  async function handleClear() {
    try {
      await clear.mutateAsync(undefined)
      toast.success("OpenRouter key removed")
      setConfirmClear(false)
      setTestResult(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove key")
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              OpenRouter API key
            </CardTitle>
            <CardDescription>
              Powers the cloud model catalogue and agent runs. Get one at{" "}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                openrouter.ai/keys
              </a>
              .
            </CardDescription>
          </div>
          {isLoading ? null : configured ? (
            <Badge variant="secondary">
              {fromEnv ? "Set via .env" : `Set ${settings?.key_hint ?? ""}`}
            </Badge>
          ) : (
            <Badge variant="outline">Not set</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {fromEnv ? (
          <p className="text-sm text-muted-foreground">
            A key is currently provided by the environment (
            <code className="font-mono">.env</code>). Saving one here overrides it.
          </p>
        ) : null}

        <div className="grid gap-2">
          <Label htmlFor="openrouter-key">
            {configured && !fromEnv ? "Replace key" : "API key"}
          </Label>
          <Input
            id="openrouter-key"
            type="password"
            autoComplete="off"
            placeholder="sk-or-…"
            value={key}
            onChange={(e) => {
              setKey(e.target.value)
              setTestResult(null)
            }}
          />
        </div>

        {testResult ? (
          <div
            className={
              testResult.status === "ok"
                ? "flex items-center gap-2 text-sm text-foreground"
                : "flex items-center gap-2 text-sm text-destructive"
            }
          >
            {testResult.status === "ok" ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            {testResult.status === "ok"
              ? `Key is valid${testResult.label ? ` (${testResult.label})` : ""}.`
              : testResult.error}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {configured && !fromEnv ? (
            <Button
              variant="outline"
              className="mr-auto text-destructive hover:text-destructive"
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 className="h-4 w-4" />
              Remove key
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={handleTest}
            disabled={testing || (!key.trim() && !configured)}
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Test
          </Button>
          <Button onClick={handleSave} disabled={save.isPending || !key.trim()}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save key
          </Button>
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Remove OpenRouter key"
        description="Cloud models will stop loading and agent runs will fail until a new key is set (or one is provided via .env)."
        confirmLabel="Remove"
        destructive
        loading={clear.isPending}
        onConfirm={handleClear}
      />
    </Card>
  )
}
