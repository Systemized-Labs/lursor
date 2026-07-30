import { CheckCircle, WarningCircle } from "@phosphor-icons/react"
import { useState } from "react"
import { toast } from "sonner"

import { providersApi, useCreateProvider } from "@/api/providers"
import { settingsApi, useSaveOpenRouterKey } from "@/api/settings"
import type { OpenRouterTestResult, ProviderHealth } from "@/api/types"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

interface ModelStepProps {
  /** True once a key or endpoint is in place (from this step or from before). */
  ready: boolean
  /** Where the current OpenRouter key comes from, for the "already set" note. */
  keySource: "database" | "env" | "none" | undefined
  onDone: () => void
}

/**
 * Step one: give Lursor a model to run on. The only step that gates the rest —
 * every other surface in the app assumes a model source exists.
 *
 * Two routes, both of which satisfy the step: an OpenRouter key (the cloud
 * catalogue) or any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM,
 * llama.cpp) saved as a custom provider. LAIOS — the daemon that also pulls and
 * serves models and watches VRAM — is deliberately not here: it needs its own
 * install first, so it stays a post-setup destination in the sidebar.
 */
export function ModelStep({ ready, keySource, onDone }: ModelStepProps) {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          Bring a model
        </h2>
        <p className="text-sm text-muted-foreground">
          Lursor runs on your keys, from your machine. Pick one source now — you
          can add more later.
        </p>
      </div>

      <Tabs defaultValue="cloud">
        <TabsList>
          <TabsTrigger value="cloud">Cloud</TabsTrigger>
          <TabsTrigger value="local">Local</TabsTrigger>
        </TabsList>
        <TabsContent value="cloud" className="mt-4">
          <CloudForm ready={ready} keySource={keySource} onDone={onDone} />
        </TabsContent>
        <TabsContent value="local" className="mt-4">
          <LocalForm onDone={onDone} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** OpenRouter: paste, optionally probe, save. */
function CloudForm({ ready, keySource, onDone }: ModelStepProps) {
  const save = useSaveOpenRouterKey()
  const [key, setKey] = useState("")
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<OpenRouterTestResult | null>(null)

  async function handleTest() {
    setTesting(true)
    setResult(null)
    try {
      // Probe the typed key when there is one, otherwise whatever is already set.
      setResult(
        await settingsApi.testOpenRouter(key.trim() ? { api_key: key.trim() } : {})
      )
    } catch (err) {
      setResult({
        status: "error",
        label: null,
        error: err instanceof Error ? err.message : "Test failed",
      })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    if (!key.trim()) return
    try {
      await save.mutateAsync({ api_key: key.trim() })
      setKey("")
      setResult(null)
      toast.success("OpenRouter key saved")
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save key")
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <Label htmlFor="onboarding-openrouter-key">API key</Label>
        <Input
          id="onboarding-openrouter-key"
          type="password"
          autoComplete="off"
          placeholder="sk-or-…"
          value={key}
          onChange={(e) => {
            setKey(e.target.value)
            setResult(null)
          }}
        />
        <p className="text-xs text-muted-foreground">
          Get one at{" "}
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            openrouter.ai/keys
          </a>
          . Stored locally, on this machine.
        </p>
      </div>

      {/* A key from .env already satisfies the step, so say so rather than
          letting the empty field imply nothing is set. */}
      {ready && !key.trim() ? (
        <Note tone="ok">
          {keySource === "env"
            ? "A key is already provided by your environment (.env). Saving one here overrides it."
            : "A model source is already set up. Continue, or replace it above."}
        </Note>
      ) : null}

      {result ? (
        result.status === "ok" ? (
          <Note tone="ok">
            Key is valid{result.label ? ` (${result.label})` : ""}.
          </Note>
        ) : (
          <Note tone="error">{result.error ?? "Test failed."}</Note>
        )
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          onClick={handleTest}
          disabled={testing || (!key.trim() && !ready)}
        >
          {testing ? <DotGridLoader size="xs" /> : null}
          Test
        </Button>
        <Button onClick={handleSave} disabled={save.isPending || !key.trim()}>
          {save.isPending ? <DotGridLoader size="xs" /> : null}
          Save key
        </Button>
      </div>
    </div>
  )
}

/** Any OpenAI-compatible server, saved as a custom provider. */
function LocalForm({ onDone }: { onDone: () => void }) {
  const create = useCreateProvider()
  const [name, setName] = useState("Local")
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ProviderHealth | null>(null)

  function input() {
    return {
      name: name.trim() || "Local",
      base_url: baseUrl.trim(),
      api_key: apiKey.trim() || null,
    }
  }

  async function handleTest() {
    if (!baseUrl.trim()) return
    setTesting(true)
    setResult(null)
    try {
      setResult(await providersApi.test(input()))
    } catch (err) {
      setResult({
        status: "error",
        model_count: null,
        error: err instanceof Error ? err.message : "Test failed",
      })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    if (!baseUrl.trim()) return
    try {
      await create.mutateAsync(input())
      toast.success("Local endpoint added")
      onDone()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to add the endpoint"
      )
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
        <div className="grid gap-2">
          <Label htmlFor="onboarding-local-name">Name</Label>
          <Input
            id="onboarding-local-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="onboarding-local-url">Endpoint</Label>
          <Input
            id="onboarding-local-url"
            className="font-mono text-sm"
            spellCheck={false}
            placeholder="http://localhost:11434/v1"
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value)
              setResult(null)
            }}
          />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="onboarding-local-key">API key (optional)</Label>
        <Input
          id="onboarding-local-key"
          type="password"
          autoComplete="off"
          placeholder="Leave blank for local servers"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Any OpenAI-compatible server — Ollama, LM Studio, vLLM, llama.cpp. Its
        models show up in the picker automatically. To pull, serve, and watch
        VRAM from Lursor, connect a LAIOS daemon later from the sidebar.
      </p>

      {result ? (
        result.status === "ok" ? (
          <Note tone="ok">
            Connected
            {typeof result.model_count === "number"
              ? ` — ${result.model_count} model${
                  result.model_count === 1 ? "" : "s"
                } available.`
              : "."}
            {result.note ? ` ${result.note}` : ""}
          </Note>
        ) : (
          <Note tone="error">
            {result.error ?? "Could not reach the endpoint."}
          </Note>
        )
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          onClick={handleTest}
          disabled={testing || !baseUrl.trim()}
        >
          {testing ? <DotGridLoader size="xs" /> : null}
          Test
        </Button>
        <Button
          onClick={handleSave}
          disabled={create.isPending || !baseUrl.trim()}
        >
          {create.isPending ? <DotGridLoader size="xs" /> : null}
          Save endpoint
        </Button>
      </div>
    </div>
  )
}

/** Inline result banner, matching the provider dialog's success/error styling. */
function Note({
  tone,
  children,
}: {
  tone: "ok" | "error"
  children: React.ReactNode
}) {
  const ok = tone === "ok"
  return (
    <div
      className={
        ok
          ? "flex items-start gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-foreground"
          : "flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground"
      }
    >
      {ok ? (
        <CheckCircle className="mt-0.5 size-4 shrink-0 text-success" />
      ) : (
        <WarningCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
      )}
      <span>{children}</span>
    </div>
  )
}
