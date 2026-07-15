import { Globe, Key } from "@phosphor-icons/react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { useSaveWebSearchSettings, useWebSearchSettings } from "@/api/settings"
import type { WebSearchProvider } from "@/api/types"
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

const PROVIDERS: {
  value: WebSearchProvider
  label: string
  description: string
}[] = [
  {
    value: "native",
    label: "Native (model built-in)",
    description:
      "Use the model's own web search. Best quality when supported, no API key. Models without native search will error — use a fallback provider if unsure.",
  },
  {
    value: "duckduckgo",
    label: "DuckDuckGo",
    description:
      "Free, no API key. Used as a local fallback when the model has no native web search. This is the default.",
  },
  {
    value: "tavily",
    label: "Tavily",
    description:
      "Search API built for LLMs. Needs a Tavily API key. Falls back to DuckDuckGo if no key is set.",
  },
  {
    value: "exa",
    label: "Exa",
    description:
      "Neural/semantic search API. Needs an Exa API key. Falls back to DuckDuckGo if no key is set.",
  },
]

/** External key providers that need an API key input when selected. */
const KEYED: Record<
  string,
  { label: string; placeholder: string; url: string; urlLabel: string }
> = {
  tavily: {
    label: "Tavily API key",
    placeholder: "tvly-…",
    url: "https://app.tavily.com/home",
    urlLabel: "app.tavily.com",
  },
  exa: {
    label: "Exa API key",
    placeholder: "exa_…",
    url: "https://dashboard.exa.ai/api-keys",
    urlLabel: "dashboard.exa.ai",
  },
}

/**
 * App-wide web-search backend. Every agent with web search enabled uses this
 * provider; the per-agent toggle only decides whether an agent may search. The
 * provider saves immediately on change; Tavily/Exa also take an API key.
 */
export function WebSearchSection() {
  const { data: settings, isLoading } = useWebSearchSettings()
  const save = useSaveWebSearchSettings()

  const provider = settings?.provider ?? "duckduckgo"
  const keyed = KEYED[provider]

  const configured =
    provider === "tavily"
      ? settings?.tavily_configured
      : provider === "exa"
        ? settings?.exa_configured
        : false
  const source =
    provider === "tavily"
      ? settings?.tavily_source
      : provider === "exa"
        ? settings?.exa_source
        : "none"
  const keyHint =
    provider === "tavily" ? settings?.tavily_key_hint : settings?.exa_key_hint
  const fromEnv = source === "env"

  const [keyInput, setKeyInput] = useState("")
  // Clear the pending key field whenever the selected provider changes.
  useEffect(() => {
    setKeyInput("")
  }, [provider])

  async function handleProviderChange(value: string) {
    try {
      await save.mutateAsync({ provider: value as WebSearchProvider })
      toast.success("Web search provider saved")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save provider")
    }
  }

  async function handleSaveKey() {
    if (!keyInput.trim()) {
      toast.error("Enter a key first")
      return
    }
    try {
      await save.mutateAsync(
        provider === "tavily"
          ? { tavily_api_key: keyInput.trim() }
          : { exa_api_key: keyInput.trim() }
      )
      toast.success("API key saved")
      setKeyInput("")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save key")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5" />
          Web search provider
        </CardTitle>
        <CardDescription>
          The backend agents use for the <code className="font-mono">web_search</code>{" "}
          tool. Applies to every agent that has web search enabled.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="web-search-provider">Provider</Label>
          <Select
            value={provider}
            onValueChange={handleProviderChange}
            disabled={isLoading || save.isPending}
          >
            <SelectTrigger id="web-search-provider" className="max-w-sm">
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

        {keyed ? (
          <div className="grid gap-2 rounded-md border p-4">
            <div className="flex items-start justify-between gap-4">
              <Label htmlFor="web-search-key" className="flex items-center gap-2">
                <Key className="h-4 w-4" />
                {keyed.label}
              </Label>
              {isLoading ? null : configured ? (
                <Badge variant="secondary">
                  {fromEnv ? "Set via .env" : `Set ${keyHint ?? ""}`}
                </Badge>
              ) : (
                <Badge variant="outline">Not set</Badge>
              )}
            </div>
            {fromEnv ? (
              <p className="text-sm text-muted-foreground">
                A key is currently provided by the environment (
                <code className="font-mono">.env</code>). Saving one here overrides it.
              </p>
            ) : null}
            <Input
              id="web-search-key"
              type="password"
              autoComplete="off"
              placeholder={keyed.placeholder}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Get one at{" "}
              <a
                href={keyed.url}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                {keyed.urlLabel}
              </a>
              . Without a key, {provider === "tavily" ? "Tavily" : "Exa"} falls back to
              DuckDuckGo.
            </p>
            <div className="flex justify-end">
              <Button
                onClick={handleSaveKey}
                disabled={save.isPending || !keyInput.trim()}
              >
                Save key
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
