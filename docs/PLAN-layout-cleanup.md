# Plan — layout code cleanup

Follow-up to the seven-phase shell rewrite on `refactor/top-level-ux`. That branch
replaced the nav rail and right dock with a dockview pane layer, one sidebar
column, and settings as a dialog. This plan is the cleanup pass over what it left:
no new behaviour, no new surfaces, and no change to the pane layer's contract.

Per the convention in `AGENTS.md`, this doc is folded into `AGENTS.md` and deleted
once shipped.

## What this is not

The rewrite is not in trouble. Before writing anything, the branch was audited:

- `tsc -b` passes clean.
- `oxlint` reports only pre-existing `only-export-components` warnings, none in
  the new code's logic.
- **Zero unused exports** across `components/layout`, `components/panes` and
  `components/settings` — every symbol has a live consumer.
- No `any`, no `@ts-ignore`, no `TODO`/`FIXME` anywhere in the layout code.
- The migration is finished, not half-done: `nav-rail.tsx`, `right-dock.tsx`,
  `sidebar-panel.tsx`, `use-dock-state.ts`, `workspace-tile.tsx`, `rail-folder.tsx`
  and `rail-items.ts` are deleted rather than orphaned.

So this is not remediation. It is the duplication that accumulated because seven
phases each added a channel, a hook or a tree walk while the phase before it was
still the reference to copy from.

Unrelated find, recorded here so it is not lost: `components/chat/ChatReasoning.tsx`
has no importers. It predates this branch and is out of scope; delete it separately.

## What deliberately stays duplicated

These read as copy-paste and are not. Each pair is load-bearing, and each already
carries the comment explaining why. **Do not unify them** — the comments name the
bugs that merging would reintroduce.

| Looks duplicated | Actually |
| --- | --- |
| `fillsFor` / `restoreFills` | A template rosters kinds by hand; a saved arrangement's own panel map records what was open. Different information, so different fills. |
| `needsDeckShell` / `savedNeedsDeckShell` | Live deck vs `serializedDeckSize` over a saved layout whose roster ids belong to another workspace. |
| `gridZones` / `countZones` / `describedZones` | Three different questions: what a schematic advertises, how many grid cells a tree has, and how many regions a user sees (which counts the deck). `describedZones`' own comment names the bug of collapsing it into `countZones`. |

## Phases

Small and independently landable. Phases 3 → 4 are the only hard dependency.

---

### Phase 1 — Mechanical sweep

Zero behaviour change; nothing here can fail at runtime that `tsc` would not catch.

**`(panel.params as PaneParams | undefined)?.kind` appears 9 times in 5 files.**
`use-pane-layout.ts` and `layout-templates.ts` each define a local `kindOf` for it;
`layouts-dialog.tsx`, `terminal-deck.ts` and `pane-tab.tsx` inline it. Add to
`pane-kinds.ts`:

```ts
/** A pane's kind, off its live panel. The cast is here so it is nowhere else. */
export function paneKindOf(panel: IDockviewPanel): PaneKind | undefined
export function paneParamsOf(panel: IDockviewPanel): PaneParams | undefined
```

`pane-kinds.ts` currently has no dockview import at all — this needs
`import type { IDockviewPanel }`, type-only, which is safe (see the bundle note
under Phase 6).

**`newId()` in `use-custom-layouts.ts:56` duplicates `newPaneId()` in
`pane-kinds.ts:151`** — same `crypto.randomUUID` probe, same `Math.random`
fallback, different prefix. Extract `newId(prefix: string)` and have both call it.

**Doc bug, `terminal-deck.ts:244–251`.** The docblock describing `withDeckOpen`
("A serialized deck, opened — for a layout whose schematic promises it is showing")
is stranded above `serializedDeckSize`'s own docblock, so that function carries two
doc comments and `withDeckOpen` carries none. Move it to line 267.

**`projects-section.tsx`** repeats `{ kind: "folder", folderId: folder.id, index:
children.length }` four times inside one `FolderRow` (lines 318, 348, 353, 362).
Hoist to a `const folderEnd = …` in the map body.

Verify: `tsc -b`, `oxlint`, and the sidebar still files a project into a folder by
drag and drops one onto the group floor.

---

### Phase 2 — One storage helper for the preference hooks

Four hooks hand-roll the same `try`/`catch` localStorage read plus write-on-change:
`use-pins.ts`, `use-collapsed-projects.ts`, `use-sidebar-side.ts`,
`use-custom-layouts.ts`. The first two have **byte-identical** `load()` functions
(parse a JSON array, keep the strings, return a `Set`) and near-identical `toggle`.

Add `hooks/use-stored.ts`:

```ts
/** A `Set<string>` in localStorage. Absence means empty; writes are best-effort. */
export function useStoredSet(key: string): [Set<string>, (id: string) => void, ...]
/** A JSON value in localStorage, validated on read. */
export function useStoredJson<T>(key: string, parse: (raw: unknown) => T | null, fallback: T)
```

**One behaviour difference to resolve, not paper over.** `use-collapsed-projects`
skips the first write with a `hydrated` ref; `use-pins` does not, so it writes back
on mount exactly what it just read. Harmless — but the helper should carry the
guard, which means pins stops doing a redundant mount write. That is the intended
outcome, not a regression.

`use-pins`' `prune` and `use-custom-layouts`' `save`/`remove`/`rename` stay where
they are; only the storage plumbing moves.

Verify: pin a conversation, collapse two projects, swap the sidebar side, save an
arrangement — reload, all four survive. Then check that a first-ever launch (clear
the four keys) writes nothing until something is actually toggled.

---

### Phase 3 — One request-channel factory

`lib/open-file.ts` (61 lines), `lib/open-preview.ts` (51) and `lib/open-thread.ts`
(56) are the same module three times. 168 lines differing only in the request type
and the four function names; even the doc comments are parallel, and `open-thread`'s
opens with "Modelled on `requestOpenFile`, and needed for the same reason".

Add `lib/request-channel.ts`:

```ts
export interface RequestChannel<T extends { workspaceId: string }> {
  request: (r: T) => void
  peek: () => T | null
  /** Take it if it targets `workspaceId`, so it opens exactly once. */
  consume: (workspaceId: string | undefined) => T | null
  subscribe: (listener: () => void) => () => void
}
export function createRequestChannel<T extends { workspaceId: string }>(): RequestChannel<T>
```

Each `open-*.ts` keeps its request interface, its doc comment (the *why* differs per
channel and is worth keeping), and **re-exports the four names it exports today**:

```ts
const channel = createRequestChannel<OpenFileRequest>()
export const requestOpenFile = channel.request
export const peekPendingFile = channel.peek
export const consumePendingFile = channel.consume
export const subscribeOpenFile = channel.subscribe
```

That is what makes this low risk: **11 files outside `lib/` call these and none of
them change.** Call sites span the command palette, the chat markdown renderer, the
running-processes bar, the file explorer, the artifacts pane, `skill-location.ts`,
`use-preview-watch.ts`, `conversation-row.tsx`, `file-viewer.tsx`,
`preview-panel.tsx` and `workspace-chat-page.tsx`.

`lib/request-channel.ts` is reached from the shell on every route. It must stay
dependency-free — no React, no dockview. It is a module-scope `let` and a `Set` of
listeners, so this is free.

Verify: ⌘K → open a file; right-click a chat link → open in preview; click a sidebar
conversation row; click an artifact. All four still land in the right pane, and each
opens exactly once (the consume-on-match semantics are what stop a second).

---

### Phase 4 — One hook for the shell's pending-request effects

Depends on Phase 3.

`app-shell.tsx` runs the same effect shape three times (lines 207–224, 265–287,
292–305): a `tick` state, a `subscribe` that bumps it, a `peek`, a workspace-id
match, and a `handled` ref keyed on request identity. Roughly 55 lines of
plumbing wrapped around three genuinely different handlers.

```ts
/** Route a parked request to the pane layer, once, when this shell can answer it. */
function usePendingRequest<T extends { workspaceId: string }>(
  channel: RequestChannel<T>,
  workspaceId: string | undefined,
  ready: boolean,
  handle: (request: T) => void
): void
```

The handlers stay in the shell and stay distinct — the thread one branches to
`setMobileView("chat")`, the file one routes plan docs to `MobilePlanView` and drops
anything else on a phone, the preview one calls `showMobilePaneKind`. Only the
plumbing moves.

**This phase carries the one intentional behaviour change in the plan, and it needs
verifying before it is claimed as a fix.** The thread effect gates on
`if (!layout.api) return`; the file and preview effects do not. Both set
`handledPendingRef.current = pending` *before* calling `layout.ensurePane(...)`,
which begins `if (!api) return`. So a file or preview request arriving before
dockview is ready is marked handled, opens nothing, and is never consumed — it sits
pending until something else nudges it.

Reachability looks low: `PaneHost` is lazy but every one of these requests is
user-initiated, so dockview is normally mounted by the time one fires. Treat it as
an asymmetry to remove rather than a bug to headline. The `ready` parameter is where
it goes — pass `layout.api !== null` for all three.

To check reachability honestly, throttle the network to `Slow 3G` in devtools, hard
reload straight onto `/workspaces/:id/chat`, and fire ⌘K → open a file while the
dockview chunk is still in flight. If the file never opens on `main` and does open
after this phase, the fix is real; if it opens either way, say so and keep the
change as consistency.

Verify: all four open paths from Phase 3, plus a plan doc opened on a 390px viewport
still lands in `MobilePlanView`.

---

### Phase 5 — Stop rebuilding the objects effects depend on

`usePaneLayout` returns a fresh object literal on every render
(`use-pane-layout.ts:480`). Six effects in `app-shell.tsx` list `layout` in their
deps (202, 224, 242, 257, 287, 305), so all six re-run on every shell render. There
is no bug today — each is guarded by a ref (`seededRef`, `handledThreadRef`,
`seededThreadFor`, `addressedRoute`, `handledPendingRef`, `handledPreviewRef`) — but
those guards are currently load-bearing for something a `useMemo` makes impossible.

```ts
return useMemo(
  () => ({ api, onReady, openPane, ensurePane, openThread }),
  [api, onReady, openPane, ensurePane, openThread]
)
```

Every member is already `useState`-stable or `useCallback`-stable, so this is a
one-line change with a real effect on how much work a shell render triggers.

Same shape in `app-sidebar.tsx:181`: `handlers` is a fresh object each render and is
spread into `WorkspaceConversations` → every `ConversationRow`. Wrap in `useMemo`.
`dialogs` and `status` are worth checking for the same pattern while in there.

Keep the ref guards. They are correct independent of the deps, and removing them
would make this phase a behaviour change instead of a cleanup.

Verify: open a workspace with a saved layout, confirm the Skill Studio still seeds a
Files pane on first visit only, `?c=` still positions a chat pane once per workspace
load, and `/artifacts` still ensures its pane exactly once. These are precisely the
guards this phase leans on.

---

### Phase 6 — Type the serialized layout tree once

Three copies of the same traversal, and 18 `as` casts to make them compile:

| File | Walkers | Casts |
| --- | --- | --- |
| `layouts-dialog.tsx` | `countZones`, `zoneViews`, `shapeKey`'s `walk`, `reshape`'s `walk` | 10 |
| `terminal-deck.ts` | `leafIds`, `withCarried`'s `walk` | 6 |
| `layout-templates.ts` | `findGroupFor` | 2 |

The casts exist for one reason: `SerializedGridObject<T>` types `data` as
`T | SerializedGridObject<T>[]` without discriminating on `type`, so every reader
re-asserts the shape by hand. `layout-shapes.ts` already exists to be the one
definition of what a serialized layout looks like — this belongs there:

```ts
export interface LeafData { id: string; views: string[]; activeView?: string }
/** Narrow on `type`, once, so no caller has to cast. */
export function asLeaf(node: SerializedNode): LeafData | null
export function children(node: SerializedNode): SerializedNode[]
export function countLeaves(node: SerializedNode): number
export function leafViews(node: SerializedNode): string[][]
export function mapLeaves(node: SerializedNode, f: (d: LeafData) => LeafData): SerializedNode
```

`countZones`, `zoneViews` and `leafIds` become one-liners over these. `withCarried`'s
walk and `reshape`'s walk both become `mapLeaves`. `findGroupFor` becomes a
`leafViews` search. Casts drop from 18 to the two inside `asLeaf`/`children`.

**The bundle trap, restated because this is where it would bite.**
`layout-shapes.ts` is reached from the shell on every route and imports dockview
**type-only** on purpose — `Orientation` is a runtime string enum, and importing it
as a value pulls all of dockview into the entry chunk past the lazy pane host. That
is why `HORIZONTAL` is a double-cast string literal rather than `Orientation.HORIZONTAL`.
Everything added in this phase must stay `import type`. Check the entry chunk before
and after: `bun run build` and compare the gzipped entry size (668KB at the end of
the rewrite). If it moves, build the previous commit in a worktree and diff the chunk
lists rather than reasoning about the bundler.

**This is the riskiest phase.** `reshape` and `withCarried` are the code that keeps a
live PTY alive across a layout switch — §3.7 of the rewrite. Do it while attention
is fresh, not as a tail-end tidy, and verify with the rewrite's own harness:

1. Open four panes in a workspace, including a terminal in the deck.
2. `echo LAYOUT-MARKER-1` into the live PTY.
3. Cycle Workbench → Terminal deck → Focus → Two panes.
4. At every step: all four panes present, **exactly one** `.xterm` in the DOM, and
   `LAYOUT-MARKER-1` still in the scrollback.
5. Save an arrangement, flatten to Focus, re-apply it — zone count restored,
   terminal still alive, and the pane that held the chat still holds the chat.
6. Apply that arrangement in a *different* workspace: it restores as a shape, opens
   what it is short of, and does not resurrect the other workspace's pane ids.

---

### Phase 7 — Split the mobile shell out (optional)

`app-shell.tsx` is 524 lines holding two complete render trees: the mobile branch
returns at 313–444, desktop from 446. The mobile tree is self-contained — a
`WindowBar`, the stacked-and-hidden surfaces, `MobilePlanView`, `MobileDockBar` —
and its only inputs are `workspaceId`, `mobileView`, `visitedKinds`, `mobilePlan`
and the two callbacks.

Extracting `components/layout/mobile-shell.tsx` leaves the shell as the routing,
the pane-layout wiring and the desktop tree. Genuinely optional: the file is long
but it is not confusing, and every phase above shrinks it. Skip it if the diff is
getting large — it buys readability, not correctness.

Note if extracting: the stacked surfaces exist so a terminal or editor buffer
survives a bottom-bar switch (layering, not conditional mount — the mobile
equivalent of `renderer: 'always'`). The `paneId` is scoped by workspace on purpose,
because per-pane storage is global and a shared id would carry the previous repo's
preview URL over. Both are load-bearing and both are already commented; carry the
comments across.

---

## Ordering and stopping points

1 → 2 → 3 → 4 → 5 → 6 → (7). Each phase is a commit that stands alone; stopping
after any of them leaves the tree better and complete. If only three land, land
1, 3 and 5 — the mechanical sweep, the channel factory, and the memoization are
the ones that remove the most duplication per unit of risk.

## Verification harness

Every phase: `bun run build` (which runs `tsc -b`) and `bunx oxlint`, both clean.
Install and run with **bun, not pnpm** — pnpm deadlocks in this environment.

Phases 3–6 touch the pane layer, so each also runs the two invariants `AGENTS.md`
states for it:

- **A pane's DOM node is never reparented.** The four-pane / live-PTY / marker check
  under Phase 6 is how this is measured; exactly one `.xterm` in the DOM is the
  tell.
- **Nothing outside the pane layer addresses a pane through the URL.** `?c=` is
  written *from* the focused chat pane and read only once per workspace load. No
  phase here should add a second reader; Phase 5 is the one that could, by making
  `seededThreadFor` look redundant. It is not.

Final pass at both ends of the range: 390px (WindowBar with hamburger, title and ⚙;
the bottom bar reflecting a desktop-arranged layout) and 1700px (all six routes, no
overflow, every legacy redirect resolving in one hop).

## On completion

Fold into `AGENTS.md`: `paneKindOf` as the way to read a pane's kind, `createRequestChannel`
as the way to add a cross-component open request, and `layout-shapes.ts` as the only
module that narrows a serialized dockview tree. Then delete this file — the design
record is `AGENTS.md`, and `git log --diff-filter=A -- docs/` finds this if anyone
needs the reasoning.
