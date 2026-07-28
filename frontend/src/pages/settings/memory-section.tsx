import { Brain, Key, WarningCircle } from "@phosphor-icons/react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import {
  useMemorySettings,
  useSaveMemorySettings,
  useTestMemorySettings,
} from "@/api/settings"
import type {
  MemoryIsolation,
  MemoryProvider,
  MemorySettingsInput,
  MemoryTestResult,
  RecallBudget,
} from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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

const PROVIDERS: {
  value: MemoryProvider
  label: string
  description: string
}[] = [
  {
    value: "file",
    label: "Workspace file",
    description:
      "A MEMORY.md file inside each workspace, read and written by three built-in tools. Free, needs no setup, and never leaves this machine — but it has no search, does not follow you between workspaces, and nothing else can read it. This is the default.",
  },
  {
    value: "hindsight",
    label: "Hindsight",
    description:
      "Bring your own memory layer: retain, recall and reflect against a Hindsight memory bank you run (or the hosted API). Real retrieval, shared with your other tools, and it can follow you across workspaces. Replaces MEMORY.md for every agent with memory enabled.",
  },
]

const ISOLATIONS: { value: MemoryIsolation; label: string; description: string }[] = [
  {
    value: "workspace",
    label: "Per workspace",
    description:
      "Agents only recall memories tagged for the workspace they are working in. Memories are still written to the one shared bank, so switching this later needs no migration.",
  },
  {
    value: "shared",
    label: "Whole bank",
    description:
      "Every workspace can recall everything in the bank. Use this when the bank is already filled by your other tools and you want agents to read all of it.",
  },
]

const BUDGETS: { value: RecallBudget; label: string }[] = [
  { value: "low", label: "Low — fastest, fewest results" },
  { value: "mid", label: "Mid — balanced (default)" },
  { value: "high", label: "High — most thorough, slowest" },
]

const HOSTED_URL = "https://api.hindsight.vectorize.io"

/** Whether `url` points at this machine — used only to decide whether to warn. */
function isLocal(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "[::1]" ||
      host.endsWith(".local")
    )
  } catch {
    return false
  }
}

/**
 * App-wide memory backend. Every agent with memory enabled uses this provider;
 * the per-agent toggle only decides whether an agent has memory at all. The
 * provider and each knob save independently and take effect on the next message.
 */
export function MemorySection() {
  const { data: settings, isLoading } = useMemorySettings()
  const save = useSaveMemorySettings()
  const test = useTestMemorySettings()

  const provider = settings?.provider ?? "file"
  const installed = settings?.hindsight_installed ?? true

  // Connection fields are drafts until saved, so a half-typed URL isn't written
  // to the DB on every keystroke; everything else saves on change.
  const [urlInput, setUrlInput] = useState("")
  const [keyInput, setKeyInput] = useState("")
  const [result, setResult] = useState<MemoryTestResult | null>(null)

  useEffect(() => {
    setUrlInput(settings?.hindsight_base_url ?? "")
  }, [settings?.hindsight_base_url])

  async function apply(input: MemorySettingsInput, message: string) {
    try {
      await save.mutateAsync(input)
      toast.success(message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save")
    }
  }

  async function handleSaveConnection() {
    const url = urlInput.trim()
    if (!url) {
      toast.error("Enter a Hindsight URL first")
      return
    }
    const input: MemorySettingsInput = { hindsight_base_url: url }
    // A blank key field means "leave the stored key alone", not "clear it" —
    // clearing is the explicit button below.
    if (keyInput.trim()) input.hindsight_api_key = keyInput.trim()
    await apply(input, "Hindsight connection saved")
    setKeyInput("")
    setResult(null)
  }

  async function handleTest() {
    setResult(null)
    try {
      const input: MemorySettingsInput = {}
      if (urlInput.trim()) input.hindsight_base_url = urlInput.trim()
      if (keyInput.trim()) input.hindsight_api_key = keyInput.trim()
      setResult(await test.mutateAsync(input))
    } catch (err) {
      setResult({
        status: "error",
        version: null,
        bank_exists: null,
        memory_count: null,
        error: err instanceof Error ? err.message : "Test failed",
      })
    }
  }

  const fromEnv = settings?.hindsight_source === "env"
  const remote = provider === "hindsight" && !isLocal(settings?.hindsight_base_url)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Brain className="h-5 w-5" />
          Agent memory
        </CardTitle>
        <CardDescription>
          Where long-term memory lives for every agent that has memory enabled. The
          per-agent toggle decides <em>whether</em> an agent remembers; this decides{" "}
          <em>where</em>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="memory-provider">Provider</Label>
          <Select
            value={provider}
            onValueChange={(value) =>
              apply({ provider: value as MemoryProvider }, "Memory provider saved")
            }
            disabled={isLoading || save.isPending}
          >
            <SelectTrigger id="memory-provider" className="max-w-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            {PROVIDERS.find((p) => p.value === provider)?.description}
          </p>
        </div>

        {provider === "hindsight" ? (
          <>
            {!installed ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
                <WarningCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-sm text-foreground">
                  The <code className="font-mono">hindsight</code> package is not
                  installed in the backend, so agents are still using{" "}
                  <code className="font-mono">MEMORY.md</code>. Install it with{" "}
                  <code className="font-mono">uv sync --extra hindsight</code> and
                  restart the backend.
                </p>
              </div>
            ) : null}

            <div className="grid gap-3 rounded-md border p-4">
              <div className="grid gap-2">
                <Label htmlFor="hindsight-url">Hindsight URL</Label>
                <Input
                  id="hindsight-url"
                  autoComplete="off"
                  placeholder={HOSTED_URL}
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                />
                <p className="text-sm text-muted-foreground">
                  Your own instance (the Docker image serves the API on port 8888), or{" "}
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={() => setUrlInput(HOSTED_URL)}
                  >
                    use the hosted API
                  </button>
                  .
                </p>
              </div>

              <div className="grid gap-2">
                <div className="flex items-start justify-between gap-4">
                  <Label htmlFor="hindsight-key" className="flex items-center gap-2">
                    <Key className="h-4 w-4" />
                    API key
                    <span className="text-xs font-normal text-muted-foreground">
                      optional
                    </span>
                  </Label>
                  {isLoading ? null : settings?.hindsight_configured ? (
                    <Badge variant="secondary">
                      {fromEnv
                        ? "Set via .env"
                        : `Set ${settings?.hindsight_key_hint ?? ""}`}
                    </Badge>
                  ) : (
                    <Badge variant="outline">Not set</Badge>
                  )}
                </div>
                <Input
                  id="hindsight-key"
                  type="password"
                  autoComplete="off"
                  placeholder="Leave blank if your instance needs no key"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                />
                {fromEnv ? (
                  <p className="text-sm text-muted-foreground">
                    A key is currently provided by the environment (
                    <code className="font-mono">.env</code>). Saving one here
                    overrides it.
                  </p>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                {settings?.hindsight_configured && !fromEnv ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      apply({ hindsight_api_key: "" }, "Hindsight key cleared")
                    }
                    disabled={save.isPending}
                  >
                    Clear key
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={test.isPending || !urlInput.trim()}
                >
                  {test.isPending ? "Testing…" : "Test connection"}
                </Button>
                <Button onClick={handleSaveConnection} disabled={save.isPending}>
                  Save connection
                </Button>
              </div>

              {result ? (
                <p
                  className={
                    result.status === "ok"
                      ? "text-sm text-foreground"
                      : "text-sm text-destructive"
                  }
                >
                  {result.status === "ok"
                    ? `Connected to Hindsight ${result.version ?? ""}. ` +
                      (result.bank_exists === null
                        ? "Could not read the bank list."
                        : result.bank_exists
                          ? `Bank “${settings?.bank_id}” exists${
                              result.memory_count !== null
                                ? ` with ${result.memory_count} memories`
                                : ""
                            }.`
                          : `Bank “${settings?.bank_id}” does not exist yet — it will be created on first use.`)
                    : result.error}
                </p>
              ) : null}
            </div>

            {remote ? (
              <div className="flex items-start gap-2 rounded-md border p-3">
                <WarningCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Memory is sent to{" "}
                  <span className="text-foreground">
                    {settings?.hindsight_base_url}
                  </span>
                  , which is not on this machine. Whatever an agent chooses to
                  remember, and every recall query, leaves your computer. With the
                  workspace-file provider, memory never does.
                </p>
              </div>
            ) : null}

            <div className="grid gap-4 rounded-md border p-4">
              <div className="grid gap-2">
                <Label htmlFor="hindsight-bank">Memory bank</Label>
                <Input
                  id="hindsight-bank"
                  autoComplete="off"
                  defaultValue={settings?.bank_id ?? ""}
                  key={settings?.bank_id}
                  onBlur={(e) => {
                    const value = e.target.value.trim()
                    if (value !== settings?.bank_id) {
                      apply({ bank_id: value }, "Memory bank saved")
                    }
                  }}
                  className="max-w-sm"
                />
                <p className="text-sm text-muted-foreground">
                  One bank for the whole app. Point it at a bank your other tools
                  already fill and agents read it as-is. Blank resets to the default.
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="hindsight-isolation">Scope</Label>
                <Select
                  value={settings?.isolation ?? "workspace"}
                  onValueChange={(value) =>
                    apply({ isolation: value as MemoryIsolation }, "Memory scope saved")
                  }
                  disabled={save.isPending}
                >
                  <SelectTrigger id="hindsight-isolation" className="max-w-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ISOLATIONS.map((i) => (
                      <SelectItem key={i.value} value={i.value}>
                        {i.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  {
                    ISOLATIONS.find((i) => i.value === settings?.isolation)
                      ?.description
                  }
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="hindsight-budget">Recall depth</Label>
                <Select
                  value={settings?.budget ?? "mid"}
                  onValueChange={(value) =>
                    apply({ budget: value as RecallBudget }, "Recall depth saved")
                  }
                  disabled={save.isPending}
                >
                  <SelectTrigger id="hindsight-budget" className="max-w-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BUDGETS.map((b) => (
                      <SelectItem key={b.value} value={b.value}>
                        {b.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  How hard Hindsight works on each retrieval. Auto-recall runs once
                  per turn before the agent's first reply, so a deeper setting makes
                  every turn start a little slower.
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="hindsight-max-tokens">Recall size limit</Label>
                <Input
                  id="hindsight-max-tokens"
                  type="number"
                  min={256}
                  step={256}
                  defaultValue={settings?.max_tokens ?? 4096}
                  key={settings?.max_tokens}
                  onBlur={(e) => {
                    const value = Number(e.target.value)
                    if (!Number.isFinite(value) || value <= 0) return
                    if (value !== settings?.max_tokens) {
                      apply({ max_tokens: value }, "Recall size limit saved")
                    }
                  }}
                  className="max-w-[12rem]"
                />
                <p className="text-sm text-muted-foreground">
                  Maximum tokens of recalled memory added to an agent's context.
                </p>
              </div>

              <div className="flex items-start justify-between gap-4">
                <div className="grid gap-1">
                  <Label htmlFor="hindsight-inject">Recall into every turn</Label>
                  <p className="text-sm text-muted-foreground">
                    Put relevant memories in the agent's context automatically at the
                    start of each turn. Off, agents still have the recall tool but
                    must ask for memories — and no query leaves this machine unless
                    they do.
                  </p>
                </div>
                <Switch
                  id="hindsight-inject"
                  checked={settings?.inject_memories ?? true}
                  onCheckedChange={(checked) =>
                    apply({ inject_memories: checked }, "Auto-recall saved")
                  }
                  disabled={save.isPending}
                />
              </div>

              <div className="flex items-start justify-between gap-4">
                <div className="grid gap-1">
                  <Label htmlFor="hindsight-reflect">Enable reflect</Label>
                  <p className="text-sm text-muted-foreground">
                    Offer the <code className="font-mono">hindsight_reflect</code>{" "}
                    tool, which asks the bank a question and gets a synthesized
                    answer. It runs a model on the Hindsight side, so turn it off if
                    your instance has no good model configured.
                  </p>
                </div>
                <Switch
                  id="hindsight-reflect"
                  checked={settings?.include_reflect ?? true}
                  onCheckedChange={(checked) =>
                    apply({ include_reflect: checked }, "Reflect setting saved")
                  }
                  disabled={save.isPending}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="hindsight-extra-tags">
                  Also recall these tags
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    optional
                  </span>
                </Label>
                <Input
                  id="hindsight-extra-tags"
                  autoComplete="off"
                  placeholder="shared, team"
                  defaultValue={(settings?.extra_recall_tags ?? []).join(", ")}
                  key={(settings?.extra_recall_tags ?? []).join(",")}
                  onBlur={(e) => {
                    const tags = e.target.value
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean)
                    const current = settings?.extra_recall_tags ?? []
                    if (tags.join(",") !== current.join(",")) {
                      apply({ extra_recall_tags: tags }, "Recall tags saved")
                    }
                  }}
                  className="max-w-sm"
                  disabled={settings?.isolation === "shared"}
                />
                <p className="text-sm text-muted-foreground">
                  {settings?.isolation === "shared"
                    ? "Not used — the whole bank is already in scope."
                    : "Memories carrying any of these tags are recalled in every workspace. Tag something in Hindsight's own UI (or from another tool) and add the tag here to share it across workspaces."}
                </p>
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
