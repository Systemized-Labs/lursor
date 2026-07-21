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

  const isMobile = viewport !== "desktop"
  const dims = isMobile ? VIEWPORT_DIMS[viewport] : null
  const landscape = viewport === "mobile-landscape"

  // The framed page — slotted full-bleed (desktop) or into a phone chassis
  // (mobile). Same element in both, so switching device reloads once.
  const stackEl = (
    <iframe
      key={reloadKey}
      src={url}
      title="Preview"
      onLoad={() => setLoading(false)}
      className="absolute inset-0 h-full w-full border-0 bg-white"
    />
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
