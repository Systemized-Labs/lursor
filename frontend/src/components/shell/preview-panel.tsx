import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowSquareOut,
  Globe,
  ArrowClockwise,
  X,
} from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import { consumePendingPreview, subscribeOpenPreview } from "@/lib/open-preview"
import {
  usePreviewServersFor,
  type DetectedServer,
} from "@/lib/processes"

/** Common local dev-server ports, offered as one-tap shortcuts in the empty state. */
const COMMON_PORTS = [3000, 5173, 8000, 8080] as const

/** Loopback hosts a dev server reports itself on — none of which resolve to the
 *  machine running it when the UI is opened from another device. */
const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
])

/**
 * The browser's hostname, but only when it's a real network host worth
 * preferring over a loopback address — i.e. the UI is being viewed from another
 * device (a phone hitting the Mac's LAN IP). Returns `null` on the Electron /
 * `file:` desktop shell or when already on localhost, so those keep loopback
 * URLs untouched.
 */
function originHost(): string | null {
  if (typeof window === "undefined") return null
  const host = window.location.hostname
  if (!host || LOOPBACK_HOSTS.has(host)) return null
  return host
}

/**
 * Rewrite a loopback dev-server URL's host to the browser's origin host, so a
 * preview opened from another device (a phone on the LAN) hits the machine
 * actually running the server instead of the phone's own `localhost`. Scheme,
 * port, and path are preserved; non-loopback hosts and unparseable input pass
 * through unchanged. A no-op on the desktop shell (see {@link originHost}).
 */
function toBrowserHost(raw: string): string {
  const host = originHost()
  if (!host) return raw
  try {
    const u = new URL(raw)
    if (LOOPBACK_HOSTS.has(u.hostname)) {
      u.hostname = host
      return u.toString()
    }
    return raw
  } catch {
    return raw
  }
}

/**
 * True when two addresses point at the same server. Compared after rewriting
 * loopback hosts to the origin host, so a detected `http://localhost:3000` and
 * the `http://<lan-ip>:3000` actually loaded in the iframe count as one — which
 * keeps the "already loaded" dedup and the starting→ready auto-reload working.
 */
function sameUrl(a: string, b: string): boolean {
  const na = normalizeUrl(a)
  const nb = normalizeUrl(b)
  if (na === null || nb === null) return false
  return toBrowserHost(na) === toBrowserHost(nb)
}

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
 * the dev server an agent has started in the workspace. The last URL is
 * persisted per workspace so the preview reopens where it left off.
 *
 * Dev servers the agent starts are auto-detected by the backend and offered as
 * one-tap chips (with a live starting/ready state) — no port guessing. When the
 * server the user is previewing flips from starting to ready, the iframe reloads
 * itself so a first-load connection error is replaced by the running app.
 *
 * Cross-origin pages that send `X-Frame-Options`/`frame-ancestors` can't be
 * framed; the "open externally" affordance is always available as a fallback.
 */
export function PreviewPanel({ workspaceId }: PreviewPanelProps) {
  // Dev servers the backend detected for this workspace (stream-derived).
  const detected = usePreviewServersFor(workspaceId)
  // The committed URL currently loaded in the iframe. A URL saved on the desktop
  // shell (loopback) is rewritten to this browser's host on restore, so opening
  // the same workspace from a phone loads the right machine.
  const [url, setUrl] = useState<string>(() =>
    toBrowserHost(readSavedUrl(workspaceId))
  )
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
    const saved = toBrowserHost(readSavedUrl(workspaceId))
    setUrl(saved)
    setDraft(saved)
  }, [workspaceId])

  const navigate = useCallback(
    (raw: string) => {
      const normalized = normalizeUrl(raw)
      if (!normalized) return
      // Prefer the machine actually running the server over a loopback address,
      // so a preview opened from a phone on the LAN loads correctly.
      const target = toBrowserHost(normalized)
      setUrl(target)
      setDraft(target)
      writeSavedUrl(workspaceId, target)
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

  // Navigate to URLs requested from elsewhere (e.g. the right-click "Open in
  // Lursor Browser" on a chat link). Consume a pending request on mount and
  // whenever a new one is parked, so a freshly-opened preview tab or an
  // already-open panel both react.
  useEffect(() => {
    const tryOpen = () => {
      const request = consumePendingPreview(workspaceId)
      if (request) navigate(request.url)
    }
    tryOpen()
    return subscribeOpenPreview(tryOpen)
  }, [workspaceId, navigate])

  // When the server currently in the iframe transitions starting -> ready,
  // reload it so a first-load "connection refused" gives way to the live app.
  const prevStatuses = useRef<Record<string, DetectedServer["status"]>>({})
  useEffect(() => {
    for (const server of detected) {
      const prev = prevStatuses.current[server.url]
      if (
        prev === "starting" &&
        server.status === "ready" &&
        url &&
        sameUrl(url, server.url)
      ) {
        setLoading(true)
        setReloadKey((k) => k + 1)
      }
    }
    prevStatuses.current = Object.fromEntries(
      detected.map((s) => [s.url, s.status])
    )
  }, [detected, url])

  const hasUrl = url !== ""
  // Detected servers not already loaded — offered as one-tap chips.
  const otherServers = detected.filter((s) => !sameUrl(url, s.url))

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Address bar */}
      <div className="flex items-center gap-1 border-b border-border/40 px-1.5 h-9 shrink-0">
        <button
          type="button"
          onClick={reload}
          disabled={!hasUrl}
          title="Reload"
          aria-label="Reload"
          className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent shrink-0"
        >
          <ArrowClockwise className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
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
            placeholder="Search or enter URL"
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
          <ArrowSquareOut className="h-3.5 w-3.5" />
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

      {/* Detected dev servers not currently loaded — one-tap to preview. */}
      {hasUrl && otherServers.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border/40 px-2 py-1.5 shrink-0">
          <span className="text-[11px] text-muted-foreground shrink-0">
            Detected
          </span>
          {otherServers.map((server) => (
            <DetectedServerChip
              key={server.shellId}
              server={server}
              onPick={() => navigate(server.url)}
            />
          ))}
        </div>
      )}

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
        <PreviewEmptyState servers={detected} onPick={navigate} />
      )}
    </div>
  )
}

/** A one-tap chip for a detected dev server, showing its live starting/ready state. */
function DetectedServerChip({
  server,
  onPick,
}: {
  server: DetectedServer
  onPick: () => void
}) {
  const ready = server.status === "ready"
  return (
    <button
      type="button"
      onClick={onPick}
      title={server.command || server.url}
      className="flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted shrink-0"
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full shrink-0",
          ready ? "bg-emerald-500" : "bg-amber-500 animate-pulse"
        )}
        aria-hidden
      />
      <span>:{server.port}</span>
      <span className="text-muted-foreground">
        {ready ? "ready" : "starting"}
      </span>
    </button>
  )
}

/**
 * Shown when no URL is loaded. Prefers the dev servers the backend detected;
 * falls back to common dev-server ports when nothing has been detected yet.
 */
function PreviewEmptyState({
  servers,
  onPick,
}: {
  servers: DetectedServer[]
  onPick: (url: string) => void
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
      <Globe className="h-8 w-8 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Web preview</p>
        <p className="text-xs text-muted-foreground">
          {servers.length > 0
            ? "Open a detected dev server, or enter a URL above."
            : "Enter a URL above, or open a running dev server."}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {servers.length > 0
          ? servers.map((server) => (
              <DetectedServerChip
                key={server.shellId}
                server={server}
                onPick={() => onPick(server.url)}
              />
            ))
          : COMMON_PORTS.map((port) => (
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
