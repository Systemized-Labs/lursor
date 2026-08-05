import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  ArrowSquareOut,
  Globe,
  ArrowClockwise,
  DeviceMobile,
  Monitor,
  X,
} from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import { consumePendingPreview, subscribeOpenPreview } from "@/lib/open-preview"
import {
  ensureForward,
  normalizeUrl,
  reachableIfKnown,
  sameUrl,
  toReachableUrl,
} from "@/lib/preview-reach"
import { tabStorageKey } from "@/lib/tab-storage"
import {
  usePreviewServersFor,
  type DetectedServer,
} from "@/lib/processes"

/** Common local dev-server ports, offered as one-tap shortcuts in the empty state. */
const COMMON_PORTS = [3000, 5173, 8000, 8080] as const

const STORAGE_PREFIX = "lursor:preview:"
const keyFor = (workspaceId?: string) => `${STORAGE_PREFIX}${workspaceId ?? "_global"}`

/**
 * The URL is remembered twice over, because a workspace can have several preview
 * tabs open at once:
 *
 * - per tab, so each one reopens on the address *it* was showing rather than all
 *   of them snapping to whichever navigated last;
 * - per workspace, as the default a *newly opened* preview starts on — the last
 *   address used here is a far better guess than a blank pane, and it keeps a
 *   layout saved before per-tab state existed working.
 */
function readSavedUrl(workspaceId?: string, tabId?: string): string {
  try {
    // A tab that was explicitly cleared holds `""` — distinct from "never set",
    // so closing a preview and reloading doesn't resurrect it from the default.
    const own = tabId ? localStorage.getItem(tabStorageKey(tabId, "preview")) : null
    if (own !== null) return own
    return localStorage.getItem(keyFor(workspaceId)) ?? ""
  } catch {
    return ""
  }
}

function writeSavedUrl(
  workspaceId: string | undefined,
  tabId: string | undefined,
  url: string
) {
  try {
    if (tabId) localStorage.setItem(tabStorageKey(tabId, "preview"), url)
    // Only real addresses update the workspace-wide default: clearing one tab
    // shouldn't rob a preview opened later of a sensible starting point.
    if (url) localStorage.setItem(keyFor(workspaceId), url)
    else if (!tabId) localStorage.removeItem(keyFor(workspaceId))
  } catch {
    // Best-effort: ignore quota / disabled-storage errors.
  }
}

/**
 * A short label for the dock tab strip: the port for a local dev server (the
 * thing that actually tells two previews apart), else the hostname.
 */
function urlLabel(raw: string): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.port ? `:${u.port}` : u.hostname
  } catch {
    return null
  }
}

/** The device the preview is framed as. `desktop` fills the pane; the mobile
 *  modes wrap the iframe in a scaled-to-fit {@link PhoneFrame}. */
type Viewport = "desktop" | "mobile-portrait" | "mobile-landscape"
/** An optional notch/camera overlay drawn over the mobile screen. */
type DeviceOverlay = "none" | "ios" | "android"

/** Bezel thickness (px) around the phone screen. */
const PHONE_BEZEL = 14
/** Extra px reserved around the chassis for the outline ring and side buttons. */
const PHONE_OUTSET = 8

/** Device viewport sizes (CSS px) for the mobile preview frames — an
 *  iPhone-class logical viewport, with landscape being the same numbers swapped. */
const VIEWPORT_DIMS: Record<
  Exclude<Viewport, "desktop">,
  { width: number; height: number }
> = {
  "mobile-portrait": { width: 390, height: 844 },
  "mobile-landscape": { width: 844, height: 390 },
}

const VIEWPORT_OPTIONS: Array<{ mode: Viewport; label: string; icon: ReactNode }> = [
  { mode: "desktop", label: "Desktop", icon: <Monitor className="h-3.5 w-3.5" /> },
  {
    mode: "mobile-portrait",
    label: "Mobile portrait",
    icon: <DeviceMobile className="h-3.5 w-3.5" />,
  },
  {
    mode: "mobile-landscape",
    label: "Mobile landscape",
    icon: <DeviceMobile className="h-3.5 w-3.5 rotate-90" />,
  },
]

const OVERLAY_OPTIONS: Array<{ mode: DeviceOverlay; label: string }> = [
  { mode: "none", label: "Off" },
  { mode: "ios", label: "iOS" },
  { mode: "android", label: "Android" },
]

const VIEWPORT_STORAGE_KEY = "lursor:preview:viewport"
const OVERLAY_STORAGE_KEY = "lursor:preview:overlay"

/** Read a persisted display preference, falling back when absent or invalid. */
function readPref<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[]
): T {
  try {
    const v = localStorage.getItem(key)
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
  } catch {
    return fallback
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Best-effort: ignore quota / disabled-storage errors.
  }
}

interface PreviewPanelProps {
  /** Keys the persisted URL, so each workspace remembers its own preview target. */
  workspaceId?: string
  /** Hosting dock tab — keys this preview's own remembered URL. */
  tabId?: string
  /** Whether this panel is the one on screen; only it takes pending requests. */
  active?: boolean
  /** Report the loaded port/host for the tab strip. */
  onDetail?: (tabId: string, detail: string | null) => void
}

/**
 * A web preview pane: an address bar plus an iframe rendering a URL — typically
 * the dev server an agent has started in the workspace. The last URL is
 * persisted per tab (and per workspace, as the default for new previews) so the
 * preview reopens where it left off. Several previews can be open side by side —
 * one per port, say — each navigating independently.
 *
 * Dev servers the agent starts are auto-detected by the backend and offered as
 * one-tap chips (with a live starting/ready state) — no port guessing. When the
 * server the user is previewing flips from starting to ready, the iframe reloads
 * itself so a first-load connection error is replaced by the running app.
 *
 * Cross-origin pages that send `X-Frame-Options`/`frame-ancestors` can't be
 * framed; the "open externally" affordance is always available as a fallback.
 */
export function PreviewPanel({
  workspaceId,
  tabId,
  active = true,
  onDetail,
}: PreviewPanelProps) {
  // Dev servers the backend detected for this workspace (stream-derived).
  const detected = usePreviewServersFor(workspaceId)
  // The committed address, as the dev server reports it or the user typed it. This
  // is what gets persisted, compared and shown in the address bar.
  const [canonical, setCanonical] = useState<string>(() =>
    readSavedUrl(workspaceId, tabId)
  )
  // The same address, made reachable from here: the origin host on a LAN device, a
  // forwarded local port against a remote backend, unchanged otherwise. Only this
  // one is ever loaded. Seeded synchronously so a same-machine preview paints on
  // the first frame; the effect below settles the cases that need to await.
  const [url, setUrl] = useState<string>(() =>
    reachableIfKnown(readSavedUrl(workspaceId, tabId))
  )
  // The editable address-bar value (may differ from `canonical` while typing).
  const [draft, setDraft] = useState<string>(canonical)
  // Bumping this key forces the iframe to remount, which reloads the page even
  // when the URL is unchanged (iframes give us no reliable programmatic reload).
  const [reloadKey, setReloadKey] = useState(0)
  const [loading, setLoading] = useState(false)
  // Device framing — a global display preference, not per-workspace.
  const [viewport, setViewport] = useState<Viewport>(() =>
    readPref(VIEWPORT_STORAGE_KEY, "desktop", [
      "desktop",
      "mobile-portrait",
      "mobile-landscape",
    ])
  )
  const [overlay, setOverlay] = useState<DeviceOverlay>(() =>
    readPref(OVERLAY_STORAGE_KEY, "none", ["none", "ios", "android"])
  )

  const changeViewport = useCallback((mode: Viewport) => {
    setViewport(mode)
    writePref(VIEWPORT_STORAGE_KEY, mode)
  }, [])

  const changeOverlay = useCallback((mode: DeviceOverlay) => {
    setOverlay(mode)
    writePref(OVERLAY_STORAGE_KEY, mode)
  }, [])

  // Reload the saved target when the active workspace changes.
  const wsRef = useRef(workspaceId)
  useEffect(() => {
    if (wsRef.current === workspaceId) return
    wsRef.current = workspaceId
    const saved = readSavedUrl(workspaceId, tabId)
    setCanonical(saved)
    setDraft(saved)
  }, [workspaceId, tabId])

  // Resolve the committed address to one reachable from here. Separate from
  // `navigate` because the address can also change on mount, on a workspace switch,
  // and — when a forward has to be opened first — a moment after either.
  useEffect(() => {
    let cancelled = false
    if (!canonical) {
      setUrl("")
      return
    }
    void toReachableUrl(canonical).then((reachable) => {
      if (!cancelled) setUrl(reachable)
    })
    return () => {
      cancelled = true
    }
  }, [canonical])

  // Keep the dock tab labelled with what this preview is showing, so duplicate
  // Preview tabs read as ":3000" and ":5173" rather than two identical chips.
  // Labelled from the canonical address: the port the dev server announced is the
  // one that means something, not the local port a forward happened to land on.
  useEffect(() => {
    if (!tabId) return
    onDetail?.(tabId, urlLabel(canonical))
  }, [tabId, onDetail, canonical])

  const navigate = useCallback(
    (raw: string) => {
      const normalized = normalizeUrl(raw)
      if (!normalized) return
      setCanonical(normalized)
      setDraft(normalized)
      // Persist the canonical form, never the reachable one: a forwarded port is
      // chosen per session, and a remembered one would point at nothing next launch.
      writeSavedUrl(workspaceId, tabId, normalized)
      setLoading(true)
      setReloadKey((k) => k + 1)
    },
    [workspaceId, tabId]
  )

  const reload = useCallback(() => {
    if (!url) return
    setLoading(true)
    setReloadKey((k) => k + 1)
  }, [url])

  const clear = useCallback(() => {
    setCanonical("")
    setDraft("")
    setLoading(false)
    writeSavedUrl(workspaceId, tabId, "")
  }, [workspaceId, tabId])

  // Navigate to URLs requested from elsewhere (e.g. the right-click "Open in
  // Lursor Browser" on a chat link). Consume a pending request on mount and
  // whenever a new one is parked, so a freshly-opened preview tab or an
  // already-open panel both react.
  //
  // Only the visible panel consumes: with several previews mounted at once (the
  // dock keeps hidden tabs alive) a free-for-all would hand the request to
  // whichever mounted first and navigate a tab the user can't see. A parked
  // request makes the shell focus a preview tab, and that panel — now active —
  // picks it up.
  useEffect(() => {
    if (!active) return
    const tryOpen = () => {
      const request = consumePendingPreview(workspaceId)
      if (request) navigate(request.url)
    }
    tryOpen()
    return subscribeOpenPreview(tryOpen)
  }, [workspaceId, navigate, active])

  // Against a remote backend a detected port is unreachable until it is forwarded,
  // which is an IPC round trip. Open them as soon as they are detected so a chip or
  // an auto-navigate loads immediately rather than after a visible stall. A no-op
  // for a local backend.
  useEffect(() => {
    for (const server of detected) void ensureForward(server.port)
  }, [detected])

  // When the server currently in the iframe transitions starting -> ready,
  // reload it so a first-load "connection refused" gives way to the live app.
  const prevStatuses = useRef<Record<string, DetectedServer["status"]>>({})
  useEffect(() => {
    for (const server of detected) {
      const prev = prevStatuses.current[server.url]
      if (
        prev === "starting" &&
        server.status === "ready" &&
        canonical &&
        sameUrl(canonical, server.url)
      ) {
        setLoading(true)
        setReloadKey((k) => k + 1)
      }
    }
    prevStatuses.current = Object.fromEntries(
      detected.map((s) => [s.url, s.status])
    )
  }, [detected, canonical])

  const hasUrl = canonical !== ""
  // Detected servers not already loaded — offered as one-tap chips.
  const otherServers = detected.filter((s) => !sameUrl(canonical, s.url))

  const isMobile = viewport !== "desktop"
  const dims = isMobile ? VIEWPORT_DIMS[viewport] : null
  const landscape = viewport === "mobile-landscape"

  // The framed page — slotted full-bleed (desktop) or into a phone chassis
  // (mobile). Same element in both, so switching device reloads once.
  //
  // Nothing is framed until the address is actually reachable. Against a remote
  // backend that takes a moment — the port has to be forwarded first — and loading
  // the un-forwarded address meanwhile would flash a "connection refused" page
  // before correcting itself.
  const stackEl = url ? (
    <iframe
      key={reloadKey}
      src={url}
      title="Preview"
      onLoad={() => setLoading(false)}
      className="absolute inset-0 h-full w-full border-0 bg-white"
    />
  ) : (
    <div className="absolute inset-0 flex items-center justify-center">
      <p className="text-sm text-muted-foreground">Connecting to {canonical}…</p>
    </div>
  )

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

        {isMobile && (
          <div className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5 shrink-0">
            {OVERLAY_OPTIONS.map((opt) => (
              <button
                key={opt.mode}
                type="button"
                onClick={() => changeOverlay(opt.mode)}
                aria-pressed={overlay === opt.mode}
                title={
                  opt.mode === "none"
                    ? "No notch overlay"
                    : `Overlay ${opt.label} notch`
                }
                className={cn(
                  "flex h-6 items-center justify-center rounded px-1.5 text-[11px] font-medium transition-colors",
                  overlay === opt.mode
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5 shrink-0">
          {VIEWPORT_OPTIONS.map((opt) => (
            <button
              key={opt.mode}
              type="button"
              onClick={() => changeViewport(opt.mode)}
              aria-pressed={viewport === opt.mode}
              aria-label={opt.label}
              title={opt.label}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded transition-colors",
                viewport === opt.mode
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {opt.icon}
            </button>
          ))}
        </div>

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
        dims ? (
          <MobileStage dims={dims} landscape={landscape} overlay={overlay}>
            {stackEl}
          </MobileStage>
        ) : (
          <div className="relative flex-1 min-h-0 bg-background">{stackEl}</div>
        )
      ) : (
        <PreviewEmptyState servers={detected} onPick={navigate} />
      )}
    </div>
  )
}

/**
 * Centers a {@link PhoneFrame} on a dotted "stage", scaling it down (never past
 * 1:1) to fit the measured stage. The scaled footprint is reserved on an outer
 * wrapper so layout accounts for the transformed size.
 */
function MobileStage({
  dims,
  landscape,
  overlay,
  children,
}: {
  dims: { width: number; height: number }
  landscape: boolean
  overlay: DeviceOverlay
  children: ReactNode
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setStageSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const frameW = dims.width + PHONE_BEZEL * 2 + PHONE_OUTSET * 2
  const frameH = dims.height + PHONE_BEZEL * 2 + PHONE_OUTSET * 2
  const scale = stageSize
    ? Math.min(1, stageSize.w / frameW, stageSize.h / frameH)
    : 1

  return (
    <div
      ref={stageRef}
      className="flex-1 min-h-0 overflow-hidden bg-muted/30 flex items-center justify-center p-6"
      style={{
        backgroundImage:
          "radial-gradient(rgba(127,127,127,0.22) 1px, transparent 1px)",
        backgroundSize: "14px 14px",
      }}
    >
      <div
        className="flex shrink-0 items-center justify-center"
        style={{ width: frameW * scale, height: frameH * scale }}
      >
        <div style={{ transform: `scale(${scale})`, transformOrigin: "center" }}>
          <PhoneFrame
            width={dims.width}
            height={dims.height}
            landscape={landscape}
            overlay={overlay}
          >
            {children}
          </PhoneFrame>
        </div>
      </div>
    </div>
  )
}

/**
 * A dark phone chassis around the preview screen: a beveled body with a light
 * outer ring, protruding side buttons, and an optional notch overlay. Colors are
 * hardcoded hex on purpose — physical hardware is dark in both themes.
 */
function PhoneFrame({
  width,
  height,
  landscape,
  overlay,
  children,
}: {
  width: number
  height: number
  landscape: boolean
  overlay: DeviceOverlay
  children: ReactNode
}) {
  return (
    <div className="relative shrink-0">
      {/* Side buttons (protrude slightly from the chassis). */}
      {sideButtons(landscape).map((b) => (
        <div
          key={b.key}
          className="absolute z-20 bg-[#1c1c1e] rounded-[3px]"
          style={b.style}
        />
      ))}

      {/* Chassis. A light outer ring + soft glow give the dark phone a crisp edge. */}
      <div
        className="relative rounded-[3rem] bg-[#3a3a3c] ring-1 ring-white/20"
        style={{
          padding: PHONE_BEZEL,
          boxShadow:
            "0 0 0 1px rgba(0,0,0,0.5), 0 24px 60px -12px rgba(0,0,0,0.7), 0 0 36px -6px rgba(255,255,255,0.06)",
        }}
      >
        {/* Screen. */}
        <div
          className="relative overflow-hidden rounded-[2.1rem] bg-white"
          style={{ width, height }}
        >
          {children}
          <DeviceIsland overlay={overlay} landscape={landscape} />
        </div>
      </div>
    </div>
  )
}

/** Power/volume/silent nubs on the long edges; positions swap by orientation. */
function sideButtons(
  landscape: boolean
): Array<{ key: string; style: React.CSSProperties }> {
  if (!landscape) {
    return [
      { key: "silent", style: { left: -3, top: "15%", width: 4, height: 26 } },
      { key: "vol-up", style: { left: -3, top: "24%", width: 4, height: 50 } },
      { key: "vol-dn", style: { left: -3, top: "36%", width: 4, height: 50 } },
      { key: "power", style: { right: -3, top: "28%", width: 4, height: 70 } },
    ]
  }
  return [
    { key: "silent", style: { top: -3, left: "15%", height: 4, width: 26 } },
    { key: "vol-up", style: { top: -3, left: "24%", height: 4, width: 50 } },
    { key: "vol-dn", style: { top: -3, left: "36%", height: 4, width: 50 } },
    { key: "power", style: { bottom: -3, right: "28%", height: 4, width: 70 } },
  ]
}

/**
 * The notch overlay: an iOS Dynamic Island pill, or an Android hole-punch camera
 * plus a faint status-bar band. `pointer-events-none` keeps the app underneath
 * interactive.
 */
function DeviceIsland({
  overlay,
  landscape,
}: {
  overlay: DeviceOverlay
  landscape: boolean
}) {
  if (overlay === "none") return null

  if (overlay === "ios") {
    return (
      <div
        className="absolute z-10 bg-[#050506] rounded-full pointer-events-none shadow-sm"
        style={
          landscape
            ? { left: 12, top: "50%", transform: "translateY(-50%)", width: 34, height: 122 }
            : { top: 12, left: "50%", transform: "translateX(-50%)", width: 122, height: 34 }
        }
        aria-hidden
      />
    )
  }

  return (
    <div className="pointer-events-none" aria-hidden>
      <div
        className="absolute z-[9] bg-black/15"
        style={
          landscape
            ? { left: 0, top: 0, bottom: 0, width: 28 }
            : { top: 0, left: 0, right: 0, height: 28 }
        }
      />
      <div
        className="absolute z-10 bg-[#050506] rounded-full ring-2 ring-white/10"
        style={
          landscape
            ? { left: 8, top: "50%", transform: "translateY(-50%)", width: 14, height: 14 }
            : { top: 8, left: "50%", transform: "translateX(-50%)", width: 14, height: 14 }
        }
      />
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
