import { useCallback, useEffect, useRef, useState } from "react"
import {
  ExternalLink,
  Globe,
  RotateCw,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"

/** Common local dev-server ports, offered as one-tap shortcuts in the empty state. */
const COMMON_PORTS = [3000, 5173, 8000, 8080] as const

const STORAGE_PREFIX = "lursor:preview:"
const keyFor = (workspaceId?: string) => `${STORAGE_PREFIX}${workspaceId ?? "_global"}`

function readSavedUrl(workspaceId?: string): string {
  try {
    return localStorage.getItem(keyFor(workspaceId)) ?? ""
  } catch {
    return ""
  }
}

function writeSavedUrl(workspaceId: string | undefined, url: string) {
  try {
    if (url) localStorage.setItem(keyFor(workspaceId), url)
    else localStorage.removeItem(keyFor(workspaceId))
  } catch {
    // Best-effort: ignore quota / disabled-storage errors.
  }
}

/**
 * Normalize a user-typed address into a loadable URL, or `null` if it can't be
 * made into one. A bare host/port (`localhost:3000`) gets an `http://` scheme so
 * the common "paste the port the dev server printed" case just works.
 */
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`
  try {
    return new URL(withScheme).toString()
  } catch {
    return null
  }
}

interface PreviewPanelProps {
  /** Keys the persisted URL, so each workspace remembers its own preview target. */
  workspaceId?: string
}

/**
 * A web preview pane: an address bar plus an iframe rendering a URL — typically
 * the dev server an agent has started in the workspace terminal. The last URL is
 * persisted per workspace so the preview reopens where it left off.
 *
 * Cross-origin pages that send `X-Frame-Options`/`frame-ancestors` can't be
 * framed; the "open externally" affordance is always available as a fallback.
 */
export function PreviewPanel({ workspaceId }: PreviewPanelProps) {
  // The committed URL currently loaded in the iframe.
  const [url, setUrl] = useState<string>(() => readSavedUrl(workspaceId))
  // The editable address-bar value (may differ from `url` while typing).
  const [draft, setDraft] = useState<string>(url)
  // Bumping this key forces the iframe to remount, which reloads the page even
  // when the URL is unchanged (iframes give us no reliable programmatic reload).
  const [reloadKey, setReloadKey] = useState(0)
  const [loading, setLoading] = useState(false)

  // Reload the saved target when the active workspace changes.
  const wsRef = useRef(workspaceId)
  useEffect(() => {
    if (wsRef.current === workspaceId) return
    wsRef.current = workspaceId
    const saved = readSavedUrl(workspaceId)
    setUrl(saved)
    setDraft(saved)
  }, [workspaceId])

  const navigate = useCallback(
    (raw: string) => {
      const normalized = normalizeUrl(raw)
      if (!normalized) return
      setUrl(normalized)
      setDraft(normalized)
      writeSavedUrl(workspaceId, normalized)
      setLoading(true)
      setReloadKey((k) => k + 1)
    },
    [workspaceId]
  )

  const reload = useCallback(() => {
    if (!url) return
    setLoading(true)
    setReloadKey((k) => k + 1)
  }, [url])

  const clear = useCallback(() => {
    setUrl("")
    setDraft("")
    setLoading(false)
    writeSavedUrl(workspaceId, "")
  }, [workspaceId])

  const hasUrl = url !== ""

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Address bar */}
      <div className="flex items-center gap-1 border-b border-border/60 px-1.5 h-9 shrink-0">
        <button
          type="button"
          onClick={reload}
          disabled={!hasUrl}
          title="Reload"
          aria-label="Reload"
          className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent shrink-0"
        >
          <RotateCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>

        <form
          className="flex-1 min-w-0"
          onSubmit={(e) => {
            e.preventDefault()
            navigate(draft)
          }}
        >
          <input
            type="text"
            inputMode="url"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="localhost:3000"
            aria-label="Preview URL"
            className="h-7 w-full rounded-md border border-transparent bg-muted/60 px-2.5 text-xs text-foreground transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-ring/40 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/15"
          />
        </form>

        <a
          href={hasUrl ? url : undefined}
          target="_blank"
          rel="noreferrer"
          title="Open in new tab"
          aria-label="Open in new tab"
          aria-disabled={!hasUrl}
          className={cn(
            "rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent shrink-0",
            !hasUrl && "pointer-events-none opacity-40"
          )}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>

        {hasUrl && (
          <button
            type="button"
            onClick={clear}
            title="Close preview"
            aria-label="Close preview"
            className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Body */}
      {hasUrl ? (
        <div className="relative flex-1 min-h-0 bg-background">
          <iframe
            key={reloadKey}
            src={url}
            title="Preview"
            onLoad={() => setLoading(false)}
            className="absolute inset-0 h-full w-full border-0 bg-white"
          />
        </div>
      ) : (
        <PreviewEmptyState onPick={navigate} />
      )}
    </div>
  )
}

/** Shown when no URL is loaded: prompt plus one-tap common dev-server ports. */
function PreviewEmptyState({ onPick }: { onPick: (url: string) => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
      <Globe className="h-8 w-8 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Web preview</p>
        <p className="text-xs text-muted-foreground">
          Enter a URL above, or open a running dev server.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {COMMON_PORTS.map((port) => (
          <button
            key={port}
            type="button"
            onClick={() => onPick(`localhost:${port}`)}
            className="rounded-md bg-muted/60 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted"
          >
            localhost:{port}
          </button>
        ))}
      </div>
    </div>
  )
}
