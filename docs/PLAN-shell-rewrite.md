# Plan: top-level shell rewrite

Status: **approved; Phase 0 and Phase 1 done.** Open questions resolved in §10.
Scope: navigation, window frame, layout system, settings surface. Individual page
bodies are kept as-is and re-hosted.

---

## 1. Why

The pages are fine. The frame around them is not.

Concrete failures in today's shell:

- **Destinations are buried.** Schedules, Usage, LAIOS, Video, Image and
  Customization all live behind one `⋯` dropdown in the rail footer
  (`rail-items.ts`). Seven whole-page routes share a single unlabelled tile.
- **Two competing tab systems.** The center is a router `Outlet` that owns
  exactly one surface; the right dock (`right-dock.tsx`) has its own tab strip
  with its own four panel kinds. A chat and a terminal are the same kind of
  thing to a user, and the app models them as different kinds of thing.
- **Layout is one hardcoded split.** `app-shell.tsx` offers center + right dock,
  a maximize toggle that collapses the center to zero, and nothing else. No
  bottom zone, no quad, no way to save an arrangement.
- **Settings is a page you navigate away from.** Losing your chat to change a
  model is the wrong trade. It is also two pages (`/settings` and
  `/customization`) with two `?tab=` strips and overlapping content.
- ~~**Window chrome is negotiated per surface.** `useMacTitlebar` exists so that
  `app-sidebar`, `workspace-chat-page`, `right-dock` and `dock-rail` can each
  independently reconstruct the same 44px band and each decide whether to inset
  past the traffic lights. Four surfaces solving one problem.~~ **Fixed in
  Phase 1** — `WindowBar` reserves the band once and `use-mac-titlebar.ts` is
  gone.
- **The rail spends its width on the wrong axis.** It is 68px of workspace
  tiles, which is good, but it forced every destination into the footer and left
  no room for the global actions (new session, search, settings) that a user
  reaches for constantly.

Reference UX: Hermes Agent. Screenshots supplied cover the sidebar, project
drill-down, the settings dialog, the layouts dialog, and sidebar-side swapping.

---

## 2. Target shape

```
┌─────────────────────────────────────────────────────────────────┐
│ ⬤⬤⬤                                    ▤  🔊  ⌨  ⚙  ▥          │  WindowBar (44px)
├──────────────┬──────────────────────────────┬───────────────────┤
│ ⊕ New session│ CHAT · FILES              +  │ TERMINAL       +  │  zone tab strips
│ ◇ Capabilities├──────────────────────────────┼───────────────────┤
│ ▣ Artifacts  │                              │                   │
│ 🔍 Search    │        zone: main            │   zone: side      │
│              │                              │                   │
│ ▨ PINNED     ├──────────────────────────────┴───────────────────┤
│ ▨ PROJECTS ☰ │  PREVIEW                                      +  │
│  ▪ lursor    ├──────────────────────────────────────────────────┤
│    · session │           zone: bottom                           │
│  ▪ bbq-buddy │                                                  │
├──────────────┴──────────────────────────────────────────────────┤
│ ⌂  +                                                        ⋯   │
└─────────────────────────────────────────────────────────────────┘
```

Four new top-level concepts:

1. **`WindowBar`** — one frame-owned strip. Owns the macOS traffic-light
   reservation and the right-hand cluster: Layouts, Keyboard shortcuts, Settings,
   Sidebar toggle. (Notifications is cut — see §10. Of the rest, only Settings and
   the sidebar toggle exist after Phase 1; the other two arrive with the phases
   that give them something to open.)
2. **Panes** — every surface is a pane. Chat, Files, Terminal, Preview, Review,
   Artifacts, Usage, Video, Image. Panes are tabs within a zone.
3. **Zones + layouts** — a grid of zones, arranged by a template or by dragging
   panes between them. Templates and custom layouts are saved and named.
4. **Settings dialog** — one modal with a category rail, absorbing `/settings`,
   `/customization`, `/laios` and `/schedules`.

---

## 3. The pane layer (the load-bearing decision)

**Revised after research. Do not hand-roll this — use `dockview-react`.**

### 3.1 Constraint

Panes cannot be remounted by a layout change. `app-shell.tsx` already documents
why for the maximize case:

> Monaco view state, terminal sessions and preview iframes all die if a panel's
> position in the React tree changes.

Add to that list an in-flight AG-UI chat stream. A layout system that reparents
panes on every drag is a layout system that kills your terminal every time you
rearrange the window.

The underlying rule is a browser one, and dockview's docs state it plainly:

> Re-parenting an iFrame will reload the contents of the iFrame […] moving an
> iFrame within the DOM will cause a reload of its contents.

### 3.2 Options considered

| Approach | Lossless | Verdict |
|---|---|---|
| Nested `ResizablePanelGroup`, panes as children | No — every tree change remounts | Rejected |
| React portals into zone containers | No — a changed portal container remounts | Rejected |
| Flat CSS Grid, named areas (this doc's first draft) | Yes | Viable, but we'd be rebuilding dockview |
| Absolute overlay tracking measured zone rects | Yes | **This is what dockview already is** |

### 3.3 Recommendation: `dockview-react`

`dockview-react@7.0.4` — MIT, published 2026-07-22, actively maintained
(experimental builds as recent as 2026-08-01), peer-deps `react ^19.0.0`
explicitly, zero runtime dependencies beyond its own core.

The decisive finding: **dockview has already built the lossless mechanism, and
the follow-on problems it creates.** `OverlayRenderContainer` in `dockview-core`
renders any panel marked `renderer: 'always'` into one shared overlay container,
absolutely positioned to track its group's bounding box. A panel moved to a
different group re-tracks a different rect — its DOM node is never reparented.
On top of that, already shipped:

- a `PositionCache` with frame-based invalidation, to avoid re-querying
  `getBoundingClientRect` per frame;
- `requestAnimationFrame` batching to stop layout thrashing — this is the fix
  for issue #988, "windows shaking", a bug we would have found the hard way;
- clipping and z-index management across popout windows, tracked by
  `MutationObserver`;
- a regression test named `addGroup + moveTo with always renderer`, present
  since v6.3.0 — so cross-group moves under the lossless renderer are a
  maintained guarantee, not an accident of the current implementation.

Honest correction to this doc's first draft: the CSS Grid design was sound, but
I costed it as "medium". The position caching, rAF batching and clipping work
above is the part that estimate missed. It is not medium.

**What we get for free that maps directly onto later phases:**

| Need | dockview |
|---|---|
| Zone grid, nested splits, drag panes between zones | Core |
| Per-zone tab strips with `+` | Core |
| Layout templates + saved custom layouts (Phase 5) | `toJSON()` / `fromJSON()` |
| Sidebar as a draggable pane, left or right (screenshot 4/5) | Sidebar becomes a panel; side swap is native drag |
| Pop a terminal into its own OS window | Popout windows / floating groups — a genuine Electron win we were not planning |

**What we still own:** per-workspace persistence, pane kinds and their params,
the `lursor:dock:*` migration, the Hermes tab look, and the layouts dialog UI.

### 3.4 Costs and caveats — stated, not buried

- **Bundle.** Measured, not estimated — see §3.8. The pre-gzip figures this
  section originally quoted (468KB min JS, 124KB CSS) are what ships in the
  package; what reaches the app after tree-shaking and gzip is **79.5KB JS +
  8.3KB CSS**. Code-split behind a lazy route it costs the entry chunk
  **+213 bytes**; imported eagerly it costs the entry chunk +78KB. So: still
  code-split it, but the number was never the problem.
- **v7 is young.** v7 renamed the packages (`dockview` is now the vanilla entry;
  React bindings moved to `dockview-react`) as part of what the release notes
  call a complete architectural refactor, and dropped the deprecated
  `rootOverlayModel`. 7.0.4 is ~2 weeks old. Pin exactly and expect churn —
  installed as `"dockview-react": "7.0.4"`, no caret.
  Correction to this doc's first draft: the peer range is
  `^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0`, not React 19 only.
- **`always` keeps components live.** Effects, subscriptions and timers in a
  hidden panel keep running. That is what we want for a streaming chat and a
  terminal; it is *not* what we want for a hidden preview playing video. Gate
  expensive work on `onDidVisibilityChange` per pane kind.
- **We inherit a bug class, not just its fixes.** Absolute-overlay positioning
  has intrinsic edge cases around focus, clipping and sub-pixel jitter. Better
  to inherit a maintained solution than to author an unmaintained one, but this
  is not a zero-risk choice.
- **Dockview owns the tab strip and drag overlay UI.** The Hermes look —
  uppercase tab labels, blue active underline, dashed zone outlines while
  dragging — needs custom `tabComponents` plus a theme class, not just variable
  overrides. Theming is ~23 CSS custom properties on a class we define, so it
  reads Lursor's existing `--sidebar-*` / `--accent` tokens and costs nothing
  across the 87 theme blocks in `index.css`.

### 3.5 Alternatives assessed and rejected

| Library | Version / state | Why not |
|---|---|---|
| `flexlayout-react` | 0.10.2, MIT, React 19, updated 2026-07-29 | Closest runner-up. Promises "preservation of component state when tabs are moved" and applies geometry imperatively so resize does not re-render. But that guarantee is stated at the *React* level; the docs never promise DOM-node stability, and `enableWindowReMount` exists precisely because cross-window moves are fragile. A third-party fork added an `OptimizedLayout`/`TabContainer` that renders content outside FlexLayout's DOM — which implies upstream does not. Weaker guarantee for iframes and xterm. |
| `rc-dock` | 4.0.0-alpha.2, last touched 2025-12-10 | Still alpha, and drags in lodash plus five `@rc-component` packages. |
| `golden-layout` | 2.6.0, last published 2023-02-21 | Unmaintained. |
| `react-mosaic-component` | 7.0.0, Apache-2.0 | Binary tiling with no tabs, and pulls the entire `react-dnd` stack (11 deps). Wrong shape. |
| `@lumino/widgets` | 2.9.0, powers JupyterLab | Battle-tested, but imperative vanilla widgets across 11 `@lumino/*` packages. Hosting React inside Lumino widgets is the reparenting fight we are trying to avoid. Wrong integration model. |
| `allotment` | 1.20.5 | Splitters only, no tabs or docking. Sideways move from `react-resizable-panels`. |
| `dnd-kit`, `react-grid-layout` | current | Primitives. We would still be authoring the dock. |

`react-resizable-panels@3.0.6` stays for anything already wired to it outside
the pane layer.

### 3.6 Data model

Dockview owns the grid geometry and the zone/tab structure. We own the pane
identity and addressing layered over it.

```ts
type PaneKind =
  | "chat" | "files" | "terminal" | "preview" | "review"
  | "artifacts" | "usage" | "video" | "image" | "sessions"

/** Our params, carried in dockview's per-panel `params`. */
interface PaneParams {
  kind: PaneKind
  /** Kind-specific address: which thread, which file, which URL. */
  threadId?: string
  path?: string
  url?: string
}
```

- **Pane id = dockview panel id**, a UUID we generate and persist, because panes
  key their own state off it via `lib/tab-storage.ts`. Same rule as today.
- **Every pane kind registers `renderer: 'always'`** except the trivially cheap
  ones. This is the single most important line of configuration in the rewrite.
- **Persistence is per workspace**: `dockviewApi.toJSON()` stored at
  `lursor:layout:<workspaceId>`, plus one global layout for non-workspace panes.
  Same scoping `use-dock-state.ts` proved.
- **`ensurePane(kind)`** keeps today's targeting rule from `use-dock-state.ts`:
  the active panel of that kind, else the MRU one, else the leftmost, else open
  one. Ported, not redesigned — it is the logic behind "open this file here"
  landing in the panel the user is actually looking at.

**Migration:** a one-time read of `lursor:dock:<workspaceId>` builds a dockview
JSON layout with the same panels in a right-hand group, carrying the **same pane
ids** so `tab-storage` entries survive. Old keys are left in place for one
release rather than deleted.

### 3.7 Templates

Built-ins, matching screenshot 4: **Default** (main + narrow side),
**Focus** (main only), **Terminal deck** (main over a wide bottom),
**Quad** (2×2). Each is a serialized dockview layout shipped as a constant.
"Save current arrangement as a template" is `toJSON()` under
`lursor:layouts:custom`; applying one is `fromJSON()`.

**Correction after Phase 0 — issue #718 is fixed in v7.** `fromJSON` takes a
second argument, `{ reuseExistingPanels: true }`, added in the v7 refactor. It
parks every panel that appears in *both* the live layout and the incoming one in
a temporary group (deliberately removed from the group map so the internal
`clear()` cannot reach it), then re-inserts those same panel instances into the
new grid. No survivor diff to hand-roll. Measured both ways in §3.8: with the
flag, nothing remounts; without it, everything does.

What is still ours to get right: **a template cannot be a frozen constant.**
`fromJSON` destroys any panel the incoming layout does not mention, flag or no
flag — the flag only preserves panels the new layout *also* lists. So a template
is a function of the live pane set, `(openPanes) => SerializedDockview`, that
places every open pane somewhere. A constant would silently close whatever it
forgot to name. The spike implements this as `buildLayout(shape, ids)`.

One small friction for authoring those templates: v7 does not re-export
`GroupPanelViewState` from its public entry, so the per-group shape has to be
recovered from `SerializedDockview` with a conditional type. Two lines, and it
avoids an `any` in exactly the wrong place.

Layouts dialog: `⇧⌘\`.

### 3.8 Phase 0 results — measured, 2026-08-04

`dockview-react@7.0.4` pinned exactly. Spike at `src/pages/spike/dock-spike.tsx`,
route `/spike/dock`, driven headless against a real backend. Three hostile panes:
a live PTY (`TerminalPanel`, the shipped component), an iframe running its own
uptime clock, and Monaco loaded through the app's own `monaco-setup`.

Liveness is measured on **intrinsic** state, not React counters — a counter would
lie under StrictMode's double mount. The signals: the PTY's scrollback (a shell
variable echoed before the move), the iframe document's own `setInterval` clock
and `scrollY`, and Monaco's model text, line count, `getAlternativeVersionId()`,
`canUndo()` and cursor position.

Sequence: cross-group move → `fromJSON` Quad → sidebar side swap → `fromJSON`
Terminal deck → `fromJSON` Focus (all four panes tabbed into one group) →
`fromJSON` Default. Every step compared against the *original* baseline, so the
claim is survival of the whole sequence rather than of one hop.

| Signal | Through all six steps | Control: `fromJSON` without the flag |
|---|---|---|
| Terminal React instance | #1 throughout | #1 → #5 |
| Terminal PTY scrollback | `marker-42` present | gone — new shell |
| Iframe React instance | #2 throughout | #2 → #6 |
| Iframe uptime clock | 17s → 33s, never reset | reset to 3s |
| Iframe `scrollY` | 900 preserved | 0 |
| Monaco React instance / mounts | #3, `mounts` 1 | #3 → #7, `mounts` 2 |
| Monaco buffer | 8 lines, edits intact | back to the 6-line seed |
| Monaco `alternativeVersionId` | 3 | 1 |
| Monaco `canUndo()` | `true` | `false` |
| Monaco cursor | line 4 col 3 preserved | line 1 col 1 |

**Verdict: dockview holds all three. Proceed.** The control column is the same
code path with the flag removed, so the difference is attributable and not a
happy accident of timing.

Three things worth carrying forward:

- **`renderer: 'always'` and `'onlyWhenVisible'` coexist per panel.** The spike's
  deliberately cheap fourth pane is left on the default and is unmounted whenever
  it is not the active tab — exactly the behaviour we want for the cheap kinds,
  proven alongside the expensive ones rather than instead of them.
- **`api.onDidVisibilityChange` fires reliably**, including for a pane parked
  behind another tab in the same group. That is the §3.4 gate, and it works.
- **Scroll offset is preserved but not pinned.** Moving the iframe into a group
  of a different height shifted `scrollY` (900 → 2046) while the clock kept
  running. The document is not reloaded — which is the load-bearing property —
  but "the preview keeps its exact scroll position" is only true at constant
  height. Worth stating plainly rather than discovering in review.

### 3.9 Fallback — not taken

If Phase 0 had shown dockview could not hold our three hostile panes, the plan
was to fall back to the flat CSS Grid design from this doc's first draft — one
grid container, every pane a direct child, position expressed as a `grid-area`
string, resize handles as grid children on gutter tracks. Same data model,
hand-rolled positioning. It is preserved in git history on this file.

§3.8 settles it: not needed.

---

## 4. Chat stops being a route

Today `/workspaces/:id/chat` renders `WorkspaceChatPage` into the router
`Outlet`. Target: `ChatPane` is a pane like any other, one instance per open
thread, hosted in whichever zone it was dragged to.

Routing degrades from *owner* to *address*:

- `/w/:workspaceId?c=:threadId` — focuses (or opens) a chat pane for that
  thread. Deep links, reloads and the command palette keep working.
- The URL is written **from** the focused pane, not read to build the layout.
- All current redirects in `App.tsx` are preserved, plus new ones for the routes
  that become dialog categories (`/settings` → `?settings=`, `/customization` →
  `?settings=capabilities`, `/laios`, `/schedules`).

`WorkspaceChatPage`'s body is kept nearly intact. What is removed from it: its
own header row and the `useMacTitlebar` handling (the WindowBar owns that band
now), and the `h-svh` pinning (the grid gives it a definite height).

---

## 5. Sidebar

`SessionsPane` replaces `nav-rail` + `sidebar-panel`. One column, no icon rail.

```
⊕ New session                    ⌘N
◇ Capabilities
▣ Activity
▣ Artifacts
🔍 Search sessions…              ⌘K
─────────────────────────────────────
▨ PINNED
   Shift-click a chat to pin
▨ PROJECTS                        ☰
   ⌂ Home
   ▪ lursor
       · Lursor Codebase Dis…
       · Lursor Capabilities O…
   ▪ bbq-buddy
─────────────────────────────────────
⌂  +                              ⋯
```

**Drill-down** (screenshot 2): clicking a project scopes the section — the
heading becomes the project name, an `← All projects` row goes back, and that
project's sessions fill the column. Held in sidebar state, not the route, for the
same reason `use-panel-mode.ts` gives today: opening a session from the list
navigates, and a route-derived mode would flip out from under the cursor.

**Nav row mapping.** Hermes's rows do not all have a Lursor equivalent, so:

| Hermes | Lursor |
|---|---|
| New session | `/` — the New Agent launcher |
| Capabilities | opens the settings dialog at Capabilities |
| Messaging | **Activity** — today's cross-workspace unread list, with its unread count badge |
| Artifacts | new pane: generated video + image output, browsable |

**Pinned.** No `Thread.pinned` field exists. v1 pins client-side under
`lursor:pins`, keyed by thread id, shift-click to toggle. A backend column can
follow if pins need to survive a machine change.

### 5.1 What is deleted

`nav-rail.tsx`, `rail-folder.tsx`, `rail-items.ts`, `workspace-tile.tsx`,
`use-workspace-icons.ts`, `use-panel-mode.ts`, `sidebar-panel.tsx`,
`panel/chats-panel.tsx`, `panel/activity-panel.tsx`, `panel/panel-header.tsx`,
`dock-rail.tsx`, `mobile-header.tsx`, `use-mac-titlebar.ts`.

### 5.2 Two things the reference UI has no room for — flagging, not deciding

- **Workspace folders.** Backend-backed (`WorkspaceFolder`, `folder_id`,
  `position`, the `SidebarLayout` endpoint) with drag-to-file already working.
  Hermes's PROJECTS list is flat. **Recommendation: keep them** as collapsible
  groups inside PROJECTS. The backend and the drag logic in `use-workspace-tree`
  already exist, and silently dropping them would discard user data.
- **`⌘1`–`⌘9`.** Bound to rail tile order today. **Recommendation: keep**, bound
  to PROJECTS list order. Cheap, and it is the fastest path between workspaces.
- **The branch level.** Screenshot 2 shows `main` / `pibble-runner` grouping
  rows between project and session. Lursor has no per-workspace branch or
  worktree concept and `Thread` carries no branch. v1 goes project → sessions
  directly. Grouping by branch-at-creation would need a `Thread.branch` column;
  out of scope here.

---

## 6. Settings dialog

One modal, ~1100×760, left category rail and scrolling right pane
(screenshot 3). Opened by `⚙` in the WindowBar, `⌘,`, or the Capabilities nav
row. Mirrored to `?settings=<category>` so it deep-links and survives reload,
and route-independent so it opens over any layout.

| Category | Built from |
|---|---|
| Model | `agent-defaults-section`, `default-agents-section` |
| Chat | `compaction-section`, composer prefs |
| Appearance | `appearance-section`, `theme-picker` |
| Capabilities | `agents`, `prompts`, `skills`, `subagents`, `tools` pages |
| Environment | `env-page` |
| Memory & Context | `memory-section` |
| Providers | `providers-section`, `openrouter-section` |
| Web search | `web-search-section` |
| LAIOS | `laios-page` |
| Schedules | `schedules-page` |
| Integrations | `integrations-section` |
| GitHub | `github-page` |
| Keyboard shortcuts | new — a table over the keybind registry |
| Notifications | new |
| About | `VersionFooter`, walkthrough re-entry |

**Concern, flagged as agreed.** Skills and Environment are two-pane browsers
that today's shell deliberately widens to `max-w-[100rem]`, with a comment
explaining that the default column left the detail pane narrower than its own
rail. A modal will be tighter than that. Mitigations, in order of preference:

1. A `wide` dialog variant (`95vw`, max 1400px) used by Capabilities and
   Environment only.
2. Skill *authoring* stays where it already is — the Skill Studio workspace,
   with its Files pane. The dialog category is the catalog and its metadata.

If both prove insufficient in review, Capabilities becomes a pane instead of a
category, which is closer to the reference anyway (Hermes has Capabilities as a
sidebar destination *and* a separate Tools & Keys settings category).

The screenshot's bottom-left export / import / reset trio has no backend
support today. **Recommendation: omit from v1** rather than ship three buttons
that need new endpoints.

---

## 7. Mobile

The grid collapses to a single zone. Concretely:

- Sidebar is the off-canvas sheet it already is.
- The WindowBar keeps `⚙` and the sidebar toggle; Layouts is hidden — there is
  no grid to arrange.
- A bottom bar switches which pane fills the screen, driven by the open pane
  list rather than today's fixed `DockKind` set. Same
  mount-once-and-hide behaviour as `mobile-dock-bar.tsx`.
- `mobile-plan-view.tsx` survives as-is (Monaco is desktop-only, so plan docs
  still need a read-only Markdown route).

---

## 8. Phase order

Single branch, ordered commits, per the agreed rollout. Each phase ends
building and usable.

**Phase 0 — spike. DONE**, results in §3.8. `dockview-react@7.0.4` pinned; all
three hostile panes survive cross-group moves, five `fromJSON` template switches
and a sidebar side swap. Issue #718 turned out to be fixed upstream in v7
(§3.7), so no workaround needed — but templates must be built from the live pane
set, which is the part that stays ours. Bundle delta measured at 79.5KB JS +
8.3KB CSS gzipped, +213 bytes to the entry chunk once code-split.

The spike lives at `src/pages/spike/dock-spike.tsx` behind `/spike/dock`, lazily
routed. Deliberately kept rather than deleted until Phase 4 lands: it is the
regression harness for every claim in §3.8, and re-running it is cheaper than
re-deriving them. Delete it with the Phase 4 commit.

**Phase 1 — WindowBar. DONE.** `components/layout/window-bar.tsx` is the frame's
44px strip: full width, above the sidebar and the content both, owning the
traffic-light reservation and the drag region. `hooks/use-mac-titlebar.ts` is
deleted, and all four surfaces that negotiated the band are back to one height on
every platform — `app-sidebar` (which also drops the `border-r-0` +
`after:top-11` workaround that kept the window's boundary off the green button),
`workspace-chat-page`, `right-dock` (including its maximized `pl-[26px]` inset)
and `dock-rail`. `sidebar-panel` now renders `PanelHeader` unconditionally
instead of having it hoisted into the sidebar's chrome strip on macOS only.

Two decisions worth recording:

- **The offset is one CSS variable, not a prop threaded through the tree.** The
  sidebar's box is `position: fixed`, so no sibling can push it down. The
  primitive now reads `--sidebar-top` (default `0px`) and derives
  `--shell-height: calc(100svh - var(--sidebar-top))`; the shell sets
  `--sidebar-top` once on `SidebarProvider` and every `h-svh` that meant "the
  whole viewport" became `h-(--shell-height)`. One definition, and the primitive
  still works standalone with no bar above it.
- **The bar ships two controls, not the five in §2's sketch.** Layouts and
  Keyboard shortcuts have nothing behind them until Phases 5 and 2; Notifications
  was cut in §10. Settings (`⚙`, `⌘,`) and the sidebar toggle are the two that
  do something today.

**Deferred to Phase 7:** the bar is desktop-only. Mobile is never Electron, so
there is no chrome to reserve, and stacking it over the existing `MobileHeader`
would cost a phone 88px for nothing. `--sidebar-top` stays `0px` there.

Verified: `bun run build` and `bun run lint` clean, plus a headless pass over
`/`, `/settings`, `/customization` and a workspace chat, in the browser and with
`window.electron.platform = 'darwin'` stubbed to exercise the frameless path.
Measured: bar at y=0 exactly 44px, 88px left reservation and
`-webkit-app-region: drag` under macOS, sidebar and inset both starting at y=44,
one 44px band on screen where there used to be up to three, zero document
overflow on every route, and dock maximize/restore (including the sidebar
snapshot-and-restore) still correct. Entry chunk cost: +130 bytes gzipped.

**Phase 2 — settings dialog.** Build `SettingsDialog` and its categories over
the existing sections. Point `/settings`, `/customization`, `/laios`,
`/schedules` at it. Highest ratio of felt improvement to risk, and it shrinks
the surface the layout work has to carry.

**Phase 3 — sidebar.** `SessionsPane` with nav rows, search, Pinned, Projects,
drill-down, folders-as-groups, `⌘1`–`⌘9`. Delete the rail and the panel.

**Phase 4 — pane layer.** Dockview mounted as the pane host, pane-kind registry,
custom `tabComponents` for the Hermes tab look, a theme class over Lursor's
tokens, per-workspace `toJSON`/`fromJSON` persistence, `ensurePane` ported from
`use-dock-state.ts`, and the `lursor:dock:*` migration. Chat becomes a pane; the
right dock's four kinds become pane kinds. Still the big one, but materially
smaller than the hand-rolled version — no grid template authoring, no resize
handles, no overlay positioning.

**Phase 5 — layouts dialog.** Four built-in templates as serialized layouts,
custom save/apply, the template-switch survivor diff from §3.7, sidebar side
swap, `⇧⌘\`. Optional, if Phase 0 liked it: popout a pane into its own Electron
window.

**Phase 6 — new panes.** Artifacts; Usage / Video / Image re-hosted as panes.

**Phase 7 — mobile parity, cleanup, deletions.**

---

## 9. Verification

There is no frontend test suite. Per phase:

- `bun run build` (`tsc -b && vite build`) — clean.
- `bun run lint` (`oxlint`) — clean.
- Manual pass on the phase's surface, in Electron on macOS and in the browser.

Standing manual checklist for every phase from 4 onward, since these are the
things a layout system breaks silently:

- Terminal session survives a zone move, a layout switch and a sidebar swap.
- Preview iframe keeps its URL and scroll position through the same.
- Monaco keeps buffer, undo history and cursor through the same.
- A streaming chat run keeps streaming through the same.
- A hidden preview is **not** still running expensive work — the
  `onDidVisibilityChange` gate from §3.4 actually fires.
- Reload restores the layout, the open panes and the active pane per workspace.
- Switching workspaces loads that workspace's layout, and does not write over
  the previous one's key.
- Every theme: no absolute colors, every text element on `text-foreground` or
  `text-muted-foreground`. `index.css` carries 87 theme blocks — no new theme
  tokens, derive from `--sidebar-*` and `--accent` as `nav-rail` does today.

---

## 10. Open questions — resolved 2026-08-04

1. **Capabilities**: settings category, as §6 commits, with the `wide` dialog
   variant and Skill Studio mitigations. Fallback to a pane if review says the
   width is not enough.
2. **Folders**: **keep**, as collapsible groups inside PROJECTS. The backend and
   the drag logic exist and dropping them would discard user data.
3. **Artifacts**: **the wide reading** — generated video and image output *and*
   plan docs and agent-written files. Video and image are the easy half (the API
   is already there); plan docs have `lib/plan-doc.ts` to build on; agent-written
   files need a notion of provenance that does not exist yet, so that is the part
   of Phase 6 to scope first rather than assume.
4. **Notifications**: **omitted.** Nothing sits behind it today, and an empty
   category is a dead surface. The WindowBar cluster in §2 loses its `🔊` slot
   with it.
5. **`Thread.pinned`**: client-side under `lursor:pins` for v1.
6. **Sidebar**: **outside dockview**, with a `flex-direction` swap for the side.
   The reference UI makes the sidebar a draggable pane; we are deliberately not
   copying that. Primary navigation should not be closeable or droppable into a
   tab strip by accident. It also decouples Phases 1 and 3 from Phase 4 — the
   sidebar and the WindowBar do not have to wait on the pane layer. Proven in
   §3.8: a side swap outside dockview costs the panes nothing.
7. **Popout windows**: deferred past Phase 5. Real value in Electron, but it is
   an addition rather than a replacement, and §3.4's inherited-bug-class caveat
   applies most sharply to panes in a second window.

---

## 11. Research provenance

Library survey done 2026-08-04. Versions and dates from the npm registry API;
mechanism claims from dockview's own docs and source.

- [Dockview docs — Rendering Panels](https://dockview.dev/docs/core/panels/rendering/) — `onlyWhenVisible` vs `always`
- [Dockview docs — iframes](https://dockview.dev/docs/advanced/iframe/) — the reparent-reloads-iframe rule and the `always` recommendation
- [Dockview docs — Theming](https://dockview.dev/docs/core/theming/) — `DockviewTheme`, ~23 CSS custom properties
- [`overlayRenderContainer.ts`](https://github.com/mathuo/dockview/blob/master/packages/dockview-core/src/overlay/overlayRenderContainer.ts) — the shared absolutely-positioned overlay, `PositionCache`
- [dockview PR #992](https://github.com/mathuo/dockview/pull/992) — position caching + rAF batching, the "windows shaking" fix
- [dockview issue #718](https://github.com/mathuo/dockview/issues/718) — `fromJSON` destroys absent panels; still open, drives §3.7
- [mathuo/dockview](https://github.com/mathuo/dockview) · [releases](https://github.com/mathuo/dockview/releases) — v7 package rename, architectural refactor
- [caplin/FlexLayout](https://github.com/caplin/FlexLayout) — the runner-up's state-preservation claims
- [aperturerobotics/flex-layout](https://github.com/aperturerobotics/flex-layout) — the fork that added out-of-tree tab rendering
- [ticlo/rc-dock](https://github.com/ticlo/rc-dock) · [npm trends](https://npmtrends.com/dockview-vs-flexlayout-react-vs-golden-layout-vs-rc-dock) · [Golden Layout alternatives, 2026](https://portalzine.de/docker-layouts-with-goldenlayout/)
