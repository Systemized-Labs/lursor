import { CaretDown, Cpu, Stack } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { NodeTarget, Placement } from "./placement"
import { placementNodes } from "./placement"

const MIB_PER_GB = 1024

function gb(mib: number): string {
  return `${(mib / MIB_PER_GB).toFixed(1)} GB`
}

const SHARD = "shard:"

/**
 * Picks where a serve lands. Every option is one click in one list: a node to
 * run the whole model on, or a node count to split one model across.
 *
 * The two halves are shaped differently on purpose, because the questions
 * differ. *Which* node matters when you place a whole engine — you're choosing
 * headroom, or co-location with something else. *How many* is the question for
 * a shard, which exists because the model fits nowhere on its own; the members
 * are then just the roomiest Ready ones, which is the same order the daemon
 * would pick for `worker: "auto"`.
 *
 * Members are chosen by free VRAM, head included but not privileged. A shard
 * needs the same slice on every rank, so the roomiest N is the set most likely
 * to admit — and when the head is busy serving something else, that set is the
 * idle workers, which the daemon now roots the shard on directly.
 */
export function PlacementPicker({
  placement,
  targets,
  onChange,
}: {
  placement: Placement
  targets: NodeTarget[]
  onChange: (next: Placement) => void
}) {
  const head = targets.find((t) => t.role === "head")
  const workers = targets.filter((t) => t.role === "worker")

  // Roomiest usable nodes first, so "3 nodes" is the best three, not the
  // first three to have joined. The head sorts in on its free VRAM like any
  // other node — a busy head simply drops out of the small sizes.
  const members = targets
    .filter((t) => t.placeable)
    .sort((a, b) => b.freeVramMb - a.freeVramMb || (a.role === "head" ? -1 : 1))

  // One option per reachable size: 2 nodes is the roomiest pair, 3 adds the
  // next, and so on. Sizes below two aren't a shard.
  const shardOptions = members.slice(1).map((_, i) => {
    const chosen = members.slice(0, i + 2)
    return {
      count: chosen.length,
      nodeIds: chosen.map((m) => m.nodeId),
      // Naming every member stops fitting past a pair, so summarize beyond it —
      // but always say whether the head is carrying a rank, since that is what
      // changes when it's busy.
      names:
        chosen.length === 2
          ? `${chosen[0].name} + ${chosen[1].name}`
          : chosen.some((m) => m.role === "head")
            ? `${chosen[0].name} + ${chosen.length - 1} more`
            : `${chosen.length} workers, head free`,
      freeVramMb: chosen.reduce((sum, m) => sum + m.freeVramMb, 0),
    }
  })

  // `worker: "auto"` only means something when there is a Ready worker to pick.
  const autoAvailable = workers.some((w) => w.autoEligible)

  const sharding = placement.kind === "shard"
  const value = sharding
    ? `${SHARD}${placement.nodeIds.length}`
    : placement.kind === "auto"
      ? "auto"
      : placement.kind === "worker"
        ? placement.nodeId
        : "head"

  function select(v: string) {
    if (v === "head") return onChange({ kind: "head" })
    if (v === "auto") return onChange({ kind: "auto" })
    if (v.startsWith(SHARD)) {
      const count = Number(v.slice(SHARD.length))
      const opt = shardOptions.find((o) => o.count === count)
      if (opt) onChange({ kind: "shard", nodeIds: opt.nodeIds })
      return
    }
    onChange({ kind: "worker", nodeId: v })
  }

  const triggerLabel = sharding
    ? `${placement.nodeIds.length} nodes`
    : placement.kind === "auto"
      ? "Best worker"
      : (placementNodes(placement, targets)[0]?.name ?? head?.name ?? "This node")

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5">
          {sharding ? (
            <Stack className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="max-w-[12rem] truncate">{triggerLabel}</span>
          <CaretDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuRadioGroup value={value} onValueChange={select}>
          <GroupLabel>Run the whole model on</GroupLabel>
          {head ? (
            <DropdownMenuRadioItem value="head">
              <Line
                label={head.name}
                note="head"
                detail={`${gb(head.freeVramMb)} free`}
              />
            </DropdownMenuRadioItem>
          ) : null}
          {workers.map((w) => (
            <DropdownMenuRadioItem
              key={w.nodeId}
              value={w.nodeId}
              disabled={!w.placeable}
            >
              <Line
                label={w.name}
                note={w.placeable ? undefined : w.status}
                detail={`${gb(w.freeVramMb)} free`}
              />
            </DropdownMenuRadioItem>
          ))}
          {autoAvailable ? (
            <DropdownMenuRadioItem value="auto">
              <Line label="Best worker" detail="most free VRAM" />
            </DropdownMenuRadioItem>
          ) : null}

          {shardOptions.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <GroupLabel>Or split one model across</GroupLabel>
              {shardOptions.map((opt) => (
                <DropdownMenuRadioItem
                  key={opt.count}
                  value={`${SHARD}${opt.count}`}
                >
                  <Line
                    label={`${opt.count} nodes`}
                    note={opt.names}
                    detail={`${gb(opt.freeVramMb)} free`}
                  />
                </DropdownMenuRadioItem>
              ))}
            </>
          ) : null}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function GroupLabel({ children }: { children: string }) {
  return (
    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
      {children}
    </DropdownMenuLabel>
  )
}

function Line({
  label,
  note,
  detail,
}: {
  label: string
  note?: string
  detail: string
}) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3 text-sm">
      <span className="min-w-0 truncate text-foreground">
        {label}
        {note ? (
          <span className="ml-1.5 text-xs text-muted-foreground">{note}</span>
        ) : null}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>
    </span>
  )
}
