import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  Terminal,
  Trash,
} from "@phosphor-icons/react"

import { fetchProcessOutput, killProcess } from "@/api/preview"
import { requestOpenPreview } from "@/lib/open-preview"
import { useWorkspaceProcesses, type BackgroundProcess } from "@/lib/processes"
import { cn } from "@/lib/utils"

interface Props {
  workspaceId?: string
}

const OUTPUT_POLL_MS = 1500

/** Format elapsed seconds as `1h 52m 37s` / `3m 12s` / `45s`. */
function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

/** A short label for a background command (drops the leading `cd … &&`). */
function labelFor(proc: BackgroundProcess): string {
  const cmd = proc.command.trim()
  const afterCd = cmd.replace(/^cd\s+\S+\s*&&\s*/, "")
  return afterCd || cmd || "background process"
}

/** A dot + short word describing a process's live state. */
function StatusDot({ proc }: { proc: BackgroundProcess }) {
  const ready = Boolean(proc.url) && proc.ready
  const starting = Boolean(proc.url) && !proc.ready
  return (
    <span
      className={cn(
        "h-1.5 w-1.5 rounded-full shrink-0",
        ready
          ? "bg-emerald-500"
          : starting
            ? "bg-amber-500 animate-pulse"
            : "bg-muted-foreground/60"
      )}
      aria-hidden
    />
  )
}

/**
 * A Cursor-style "N Terminal(s) Running" card, shown in the chat window just
 * above the composer while the agent has background processes alive (dev
 * servers, watchers). Each row shows the command, its live state, and how long
 * it's been running; clicking one expands its read-only output inline, with Kill
 * and (for ready dev servers) Open-in-Preview.
 */
export function RunningProcessesBar({ workspaceId }: Props) {
  const processes = useWorkspaceProcesses(workspaceId)

  if (!workspaceId || processes.length === 0) return null

  const count = processes.length

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-1 sm:px-6">
      <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/30">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_2px] shadow-emerald-500/20" />
          <span className="text-xs font-medium text-foreground">
            {count} Terminal{count === 1 ? "" : "s"} Running
          </span>
        </div>
        <ProcessRows workspaceId={workspaceId} processes={processes} />
      </div>
    </div>
  )
}

/**
 * The bare, expandable list of background-process rows, without any card chrome.
 * Owns the per-row expand state and the once-a-second elapsed-time tick. Reused
 * standalone by {@link RunningProcessesBar} and embedded in the run deck.
 */
export function ProcessRows({
  workspaceId,
  processes,
}: {
  workspaceId: string
  processes: BackgroundProcess[]
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Re-render once a second so the elapsed times tick.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (processes.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [processes.length])

  return (
    <div className="flex flex-col">
      {processes.map((proc) => {
        const elapsed = formatElapsed(now / 1000 - proc.startedAt)
        const ready = Boolean(proc.url) && proc.ready
        const expanded = expandedId === proc.id
        return (
          <div
            key={proc.id}
            className="border-t border-border/40 first:border-t-0"
          >
            <button
              type="button"
              onClick={() =>
                setExpandedId((id) => (id === proc.id ? null : proc.id))
              }
              title={proc.command}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/60"
            >
              {expanded ? (
                <CaretDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <CaretRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <Terminal
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  ready ? "text-emerald-500" : "text-muted-foreground"
                )}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                {labelFor(proc)}
              </span>
              {proc.port != null && (
                <span className="flex items-center gap-1 shrink-0 text-[11px] text-muted-foreground">
                  <StatusDot proc={proc} />:{proc.port}
                </span>
              )}
              <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {elapsed}
              </span>
            </button>
            {expanded && (
              <ProcessOutput workspaceId={workspaceId} proc={proc} />
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Read-only tail of a background process's output, shown inline when its row is
 * expanded. Polls while mounted; offers Kill and (for ready dev servers)
 * Open-in-Preview. This is the agent's process, not an interactive shell.
 */
function ProcessOutput({
  workspaceId,
  proc,
}: {
  workspaceId: string
  proc: BackgroundProcess
}) {
  const [output, setOutput] = useState<string | null>(null)
  const [killing, setKilling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetchProcessOutput(workspaceId, proc.id)
        if (cancelled) return
        setError(null)
        setOutput(res.output ?? "")
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to read output")
      }
    }
    void tick()
    const t = setInterval(tick, OUTPUT_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [workspaceId, proc.id])

  // Keep the view pinned to the newest output when the user is already near it.
  useEffect(() => {
    const el = preRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [output])

  const kill = useCallback(async () => {
    setKilling(true)
    setError(null)
    try {
      await killProcess(workspaceId, proc.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to kill")
    } finally {
      setKilling(false)
    }
  }, [workspaceId, proc.id])

  const ready = Boolean(proc.url) && proc.ready
  const url = proc.url ?? undefined

  return (
    <div className="border-t border-border/40 bg-background/60">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <StatusDot proc={proc} />
        {ready && url ? (
          <button
            type="button"
            onClick={() => requestOpenPreview({ workspaceId, url })}
            className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-foreground hover:underline"
            title={`Open ${url} in Preview`}
          >
            {url.replace(/^https?:\/\//, "")}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {url
              ? "Waiting for the server to respond…"
              : "Agent process — read-only"}
          </span>
        )}
        {ready && url && (
          <button
            type="button"
            onClick={() => requestOpenPreview({ workspaceId, url })}
            title="Open in Preview"
            aria-label="Open in Preview"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ArrowSquareOut className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={kill}
          disabled={killing}
          title="Kill process"
          aria-label="Kill process"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-40"
        >
          <Trash className="h-3.5 w-3.5" />
        </button>
      </div>
      {error && (
        <div className="px-2.5 pb-1 text-[11px] text-destructive">{error}</div>
      )}
      <pre
        ref={preRef}
        className="max-h-48 overflow-auto border-t border-border/40 px-2.5 py-2 font-mono text-[11px] leading-snug text-muted-foreground whitespace-pre-wrap break-words"
      >
        {output === null ? (
          <span className="text-muted-foreground/70">Loading…</span>
        ) : output.trim() === "" ? (
          <span className="text-muted-foreground/70">Waiting for output…</span>
        ) : (
          <span className="text-foreground">{output}</span>
        )}
      </pre>
    </div>
  )
}
