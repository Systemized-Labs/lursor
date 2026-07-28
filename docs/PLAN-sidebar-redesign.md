# PLAN: Rail + panel navigation sidebar

> Status: **IMPLEMENTED** (2026-07-28) on branch `sidebar-redesign`.
>
> Scope: replace the single 256px column in `app-sidebar.tsx` (1223 lines) with a
> Slack-style two-column sidebar — a 68px destination rail and a contextual panel
> that belongs entirely to conversations. Adds a cross-workspace Activity inbox
> (§4) reusing an existing, currently-unused backend capability. Dissolves the
> Skill Studio "workspace pretending to be a nav item" contortion (§5). One
> backend-adjacent change only: a new `threadsApi.listAll` wrapper over the
> `GET /threads` endpoint that already exists (§4.1). No Python changes.
>
> Decisions taken (jon, 2026-07-28): attention-first hybrid panel; full Activity
> inbox; rail + panel both inside the mobile sheet; big-bang rewrite, built on a
> branch (§9).

## 0. Why

The sidebar is one column carrying five jobs. `app-sidebar.tsx` is 1223 lines
holding: the nav list, the workspace tree, the conversation tree, five dialogs,
and bulk-selection mode. The navigation pain is structural, not cosmetic —
restyling the same tree would not move any of the following.

### 0.1 Two scroll regions compete for one column

`SidebarContent` holds two groups that both want to grow. Platform is pinned at
`max-h-[55vh] overflow-y-auto` (`app-sidebar.tsx:459`); Workspaces takes
`min-h-0 flex-1 overflow-y-auto` (`app-sidebar.tsx:603`). The comment at
`app-sidebar.tsx:456-458` states the reason plainly — the cap exists so "a busy
studio can never push the workspace list out of the viewport."

That is a fixed split of a scarce resource. Expand two or three workspaces and
the conversation list scrolls inside 45vh while the top group holds 55vh of
mostly-static nav rows. Both regions are too short, and neither can borrow from
the other.

### 0.2 The least-used destinations outrank the most-used work

`navItems` (`app-sidebar.tsx:113-118`) puts Usage, Schedules, LAIOS and
Customization — four low-frequency, whole-page dashboards — permanently above
the conversation list, plus New Chat, Search and Skill Studio in the same group.
Seven rows of chrome sit above the thing you touch every minute.

The conversations then land at two levels of indent inside a 256px column
(`SidebarMenuSub className="mx-2 px-1.5"`, `app-sidebar.tsx:1073`), with a
timestamp and up to two badges competing for the same line
(`app-sidebar.tsx:1183-1203`). The title gets whatever is left, so it truncates
to a few words.

### 0.3 Skill Studio is a workspace cosplaying as a nav item

`SKILL_STUDIO_LABEL` needs a 6-line comment explaining why the label is
hardcoded rather than read from the record (`app-sidebar.tsx:120-126`). The row
itself carries a 9-line comment (`:503-509`) and passes six no-op callbacks
(`:518`, `:547-549`). Its click handler needs 6 lines of comment to explain why
clicking sometimes navigates and sometimes toggles (`:521-527`). A separate
effect with an 8-line comment and a `prevActiveWorkspace` ref exists solely to
auto-expand it on entry without fighting a manual collapse (`:394-409`).

That is roughly 40 lines of comment and ~35 lines of code reconciling two
concepts — "destination" and "folder" — that have been jammed into one list.
It is the clearest signal in the file that the list is doing too much.

### 0.4 Collapsed folders change height on their own

`visibleThreads` (`app-sidebar.tsx:1059-1067`) is genuinely clever: a collapsed
workspace still surfaces the active chat, anything running, and unread replies.
But it means a collapsed folder renders 0..N rows, and N changes as runs start
and finish. Rows below shift under the cursor while you are reaching for them.

The mechanism exists because there is nowhere else for cross-workspace attention
to live. Give it a home (§3.2) and collapsed can mean collapsed.

### 0.5 Expand state does not survive a reload

`openWorkspaces` is plain `useState` (`app-sidebar.tsx:196`). Every reload
collapses every workspace. The sidebar width is already persisted
(`ui/sidebar.tsx:35-36`, `:89-102`), so the inconsistency is visible.

### 0.6 There is no cross-workspace view

`useActiveRuns` already returns a global list of running thread ids
(`api/threads.ts:34-35`, backed by `GET /threads/active-runs`), but the only way
to see what is running is to expand folders one at a time and read badges. The
data is global; the UI is per-folder.

### 0.7 Bulk select silently redefines a plain click

Both click handlers branch on `selection.count > 0` and swallow a normal click
into a selection toggle (`app-sidebar.tsx:924-926` and `:1144-1146`). The
comments call this "sticky mode." Once one item is selected, clicking a
conversation stops opening it. There is no visual cue on the rows themselves
that click semantics have changed — only the toolbar above (`:572-602`).

---

## 1. Shape

```
┌────────┬──────────────────────────┐
│  RAIL  │  PANEL                   │   rail:  68px, fixed
│  68px  │  200–480px (resizable)   │   panel: existing --sidebar-width
├────────┼──────────────────────────┤
│  ▣     │  Conversations    ⌕   ⊕  │
│        │──────────────────────────│
│  ✎     │  ▾ ATTENTION             │
│  New   │   ⠿ fix auth flow  lursor│
│        │   ● review PR #42  hyve  │
│  ▤     │──────────────────────────│
│  Chats │  ▾ lursor             ⊕  │
│        │      sidebar redesign 2m │
│  ◉ ²   │      bump deps        1h │
│  Activ │  ▸ hyve-api          (3) │
│        │  ▸ dotfiles              │
│  ✦     │                          │
│  Skills│                          │
│        │                          │
│  ⏱     │                          │
│  Sched │                          │
│        │                          │
│  ▤     │                          │
│  Usage │                          │
│        │                          │
│  ⚙     │                          │
│  Custom│──────────────────────────│
├────────┤  + New workspace         │
│ ◐ ⚙ ◍  │                          │
└────────┴──────────────────────────┘
```

The rail is always visible. Collapsing the sidebar (⌘B / `SidebarRail`) now hides
the **panel** and keeps the rail — a strictly better collapsed state than
today's 3rem icon strip (`ui/sidebar.tsx:31`), because the rail's labels stay
readable at 68px where bare 3rem icons lose theirs.

### 1.1 Why the rail holds destinations, not workspaces

Slack puts the org switcher in the rail because the ratio is ~2 orgs to ~50
channels. Lursor's ratio is inverted: workspaces are switched between constantly
and there may be a dozen, while destinations are visited daily at most.

Workspaces are also repos, so a rail tile would be a letter avatar — three
lursor-ish repos give you "L", "L", "L". Names are the only reliable
discriminator, and names need horizontal space, which is what the panel has.

So: rail = destinations (low frequency, icon+label is enough), panel =
conversations (high frequency, needs the width).

---

## 2. Panel mode is sidebar state, not a route

This is the load-bearing decision, and it is the one that makes the Slack model
actually work.

In Slack, the rail selection and the open document are independent: clicking a
row in the Activity panel opens a conversation in the main area **without** the
panel flipping back to channels. If panel mode were derived from the route, that
is exactly what would happen — clicking an activity row navigates to
`/workspaces/:id/chat?c=:threadId`, the route no longer says "activity", and the
panel resets under the cursor.

Therefore:

- **`panelMode: "chats" | "activity" | "skills"`** lives in
  `use-panel-mode.ts`, persisted to `localStorage` (key `sidebar:panel`) so it
  survives reload, following the precedent already set by `sidebar:width`
  (`ui/sidebar.tsx:35`).
- Activity gets **no route**. It is panel content, not a page. This means no new
  page component, no `App.tsx` entry, and no "select a conversation" empty state
  to design.
- Opening a conversation never changes `panelMode`.

### 2.1 Rail item contract

Each rail item declares up to two effects, which removes all ambiguity about
what a click does and what "active" means:

| Item          | `to`                          | `panel`    |
| ------------- | ----------------------------- | ---------- |
| New Chat      | `/`                           | —          |
| Chats         | —                             | `chats`    |
| Activity      | —                             | `activity` |
| Skills        | `/workspaces/:studioId/chat`  | `skills`   |
| Schedules     | `/schedules`                  | —          |
| Usage         | `/analytics`                  | —          |
| LAIOS         | `/laios`                      | —          |
| Customization | `/customization`              | —          |

Click: navigate if `to`, set panel mode if `panel`.

Items with `panel: —` land on a **whole-page destination**, which collapses the
panel away. That is the four dashboards *and* New Chat: `/` is a starting point,
not somewhere you browse from, so it gets the full window like the rest. New
Chat therefore declares no panel at all — declaring one would open the panel and
let the route rule shut it again a frame later, a flash through the 200ms width
transition for no gain.

> **Revised during implementation (jon, 2026-07-28).** This section originally
> said those items *leave the panel untouched*, arguing that the panel would
> then never empty and the layout never jump. Built and used, it was simply
> confusing: a conversation list sat beside a Usage chart with no relationship
> to it, and the Chats tile stayed lit while owning a panel about nothing.
> Usage and LAIOS have nothing to list, so the honest answer is to show nothing.
> `/` joined them for the same reason a moment later.

Arriving at a panel-less route collapses the panel to rail-only and gives the
page the full width; leaving for a chat or workspace route restores it in
whichever mode you left it. This needs no new state — the sidebar already has an
open/collapsed state, so the route drives that, and ⌘B keeps working everywhere.

Crucially it applies **only on the way in**, the same ref-guard as §3.3. So ⌘B
still wins while you stay put, and clicking Chats or Activity from a dashboard
pulls the panel back out *without* leaving the page — otherwise those two rail
items would be dead on exactly the routes where the panel is hidden.

Active state: matches `to` against the route when it has one, otherwise matches
`panel` against the current mode — **and only while the panel is actually
visible**, so nothing claims to own a panel that isn't there.

Clicking the tile that already owns the panel **puts the panel away** (VS Code's
activity bar, Slack's sidebar). The set that can be toggled off is exactly the
set that can look filled — panel-only items, Chats and Activity — so the fill
reads as a switch rather than a permanent mark, and the tooltip says "Hide
Chats" so the toggle isn't something you only find by accident. New Chat and
Skills carry a `to` and are therefore actions, not view switches: clicking them
twice never collapses anything. Desktop only — on mobile the panel *is* the
drawer, and putting it away would leave a bare rail nobody asked for.

Two rail items can therefore look active at once (e.g. Chats owns the panel while
a workspace route owns the main view). Distinguish them: **panel owner = filled
tile** (Slack's selected treatment); **route owner = left edge accent bar**.
Documented here because it will look like a bug otherwise.

---

## 3. Panel: Chats mode

Header: title, search button (opens the existing command palette — reuse
`useCommandPalette`, `app-sidebar.tsx:476-478`), and new-conversation button.

### 3.1 Sections

1. **ATTENTION** — cross-workspace, §3.2.
2. **One collapsible section per workspace** — name, unread count badge when
   collapsed, `⊕` new-conversation on hover. Open state persisted (§3.3).
3. **`+ New workspace`** pinned at the panel foot, replacing the hover-only
   `FolderPlus` currently hidden in the group label (`app-sidebar.tsx:558-566`).

One scroll region for the whole panel. §0.1's fixed split is gone: nav rows moved
to the rail, so conversations get the full column height.

### 3.2 ATTENTION replaces the collapsed-folder filter

Running and unread conversations from every workspace, newest first, each row
showing its workspace name right-aligned and muted. Hidden entirely when empty —
no permanent dead header.

This is what retires §0.4. Because attention now has a home, `visibleThreads`
(`app-sidebar.tsx:1059-1067`) is deleted and a collapsed section renders
**nothing**. Collapsed height becomes constant; a run finishing no longer
reflows the list. The unread count moves to a badge on the section header, which
changes a number in place instead of inserting a row.

A conversation that is both running and inside an expanded workspace appears
twice — once in ATTENTION, once in its section. That is intentional and matches
Slack's Activity/channel overlap; both instances share the active highlight so
it reads as one thing in two places.

### 3.3 Persisted open state

`openWorkspaces` moves to `localStorage` (key `sidebar:open-workspaces`, a JSON
string array), fixing §0.5. Ids that no longer resolve are dropped on read so a
deleted workspace cannot leak an entry forever.

The active workspace is auto-opened on entry — but via the same "only on the way
*in*" guard the studio effect already uses (`app-sidebar.tsx:394-409`), so
collapsing the workspace you are inside still sticks. That ref-guard pattern is
the one genuinely good idea in the current studio code and it survives the
rewrite; it just applies to every workspace now instead of one special case.

### 3.4 Bulk select loses sticky mode

Keep `use-sidebar-selection.ts` as-is — the range/toggle logic is sound and
independent of layout. Delete only the two `selection.count > 0` branches
(`app-sidebar.tsx:924-926`, `:1144-1146`) that swallow plain clicks.

⌘-click and ⇧-click still select; a plain click always navigates. Fixes §0.7
without losing the capability. The toolbar (`:572-602`) moves into the panel
header when `count > 0`.

---

## 4. Panel: Activity mode

Filter chips **All / Running / Unread / Scheduled**, then a flat two-line list,
newest first:

```
⠿  fix auth flow
   lursor · running · 2m

●  review PR #42
   hyve-api · 1 new reply · 12m

⏱  nightly deps bump
   dotfiles · schedule · 3h
```

Two-line rows are why this belongs in a 256px panel rather than a page — the
`workspace · state · time` metadata gets its own line instead of fighting the
title, which is precisely what goes wrong in today's single-line thread rows
(§0.2). Clicking navigates to the conversation; the panel stays on Activity (§2).

The Scheduled filter is worth having because scheduled threads are the ones you
never go looking for — `Thread.schedule_id` currently surfaces only as a small
clock glyph on a row you would have to find first (`app-sidebar.tsx:1192-1200`).

### 4.1 The data already exists server-side

`GET /threads` with no `workspace_id` returns **every** thread across every
workspace, ordered `updated_at desc`, scheduled runs included
(`backend/app/api/threads.py:19-49`). Nothing in the frontend calls it that way:
`threadsApi.listByWorkspace` always sends a `workspace_id`
(`api/threads.ts:12-16`).

So Activity needs **one new API wrapper and zero Python changes**:

```ts
// api/threads.ts
listAll: (signal?: AbortSignal) => api.get<Thread[]>("/threads", signal)
// threadKeys.all = () => ["threads", "all"] as const
```

This is better than the fan-out I first assumed. `command-palette.tsx:166-188`
builds its cross-workspace list with `useQueries` over N workspaces — N requests
where one suffices. New shared hook `hooks/use-all-threads.ts` wraps `listAll`;
the palette switches to it, dropping its fan-out.

**Cache-coherence caveat.** `threadKeys.all()` is a *separate* cache entry from
the per-workspace `threadKeys.byWorkspace(id)` lists, so the existing
invalidations — `app-sidebar.tsx:181`, `:218`, `:380`, and the optimistic
setters at `:327` and `:359-361` — will not touch it. Every one of those sites
must also invalidate `threadKeys.all()`, or ATTENTION and Activity will show
conversations that the workspace sections have already dropped. This is the main
correctness risk in the rewrite; it is cheap to get right and easy to miss.

### 4.2 Unread badge on the rail

The rail's Activity item carries a count of unread conversations, derived from
the same hook plus `useThreadReads` (`hooks/use-thread-reads.ts:76`). This is the
first time "you have N things waiting" is visible without expanding anything.

### 4.3 Stale doc comment to fix

`api/types.ts:445-448` says scheduled threads "are excluded from a workspace's
conversation list by default — pass `include_scheduled` to see them." The backend
defaults `include_scheduled: bool = True` and its docstring explains it reversed
that decision deliberately (`threads.py:28-36`). The comment is wrong; correct it
while touching this file.

---

## 5. Panel: Skills mode

The studio's conversations, plus a link to the catalog
(`/customization?tab=skills`).

The studio **leaves the workspace list entirely.** `workspaces.filter(ws =>
!ws.is_system)` (`app-sidebar.tsx:391`) stays as the panel's workspace source,
but there is no longer a second place where the system workspace is re-inserted
as a fake nav row. Deleted outright:

- `SKILL_STUDIO_LABEL` and its 6-line comment (`:120-126`)
- the `<WorkspaceRow isSystem>` call with its six no-op callbacks (`:510-550`)
- the dual-purpose click handler (`:527-535`)
- the `prevActiveWorkspace` auto-expand effect (`:399-409`) — the generalised
  §3.3 version replaces it
- the `isSystem` branches inside `WorkspaceRow` (`:945-951`, `:961-984`)

That is §0.3 gone: ~75 lines of code and comment, replaced by a rail item with
`to` and `panel` set. `Workspace.is_system` keeps its meaning — it just selects
which surface renders the workspace instead of forcing one surface to render two
kinds of thing.

---

## 6. Theming: no new tokens

`index.css` is 4139 lines with **87 theme blocks**, each defining the full
`--sidebar-*` set (`index.css:65-72` for `.light`, `:116-123` for `.dark`, and 85
more). Adding a `--rail` variable means 87 edits and a permanent obligation on
every future theme. Not worth it for one surface.

Instead, derive the rail from tokens every theme already defines:

- rail surface: `bg-sidebar-accent/40`
- rail text: `text-sidebar-foreground` / `text-sidebar-foreground/70` when idle
- selected tile: `bg-sidebar-accent text-sidebar-accent-foreground`
- divider: `border-r border-sidebar-border`
- panel: `bg-sidebar` (unchanged)

This reads as Slack's darker rail in dark themes and a lighter inset in light
themes, automatically, in all 87. It also satisfies the standing UI rules: every
text element gets a semantic color, no absolute `text-white` / `bg-gray-*`.

---

## 7. Files

### New

| File | Purpose |
| --- | --- |
| `components/layout/nav-rail.tsx` | 68px rail; the §2.1 item table |
| `components/layout/use-panel-mode.ts` | persisted `panelMode` |
| `components/layout/sidebar-panel.tsx` | panel shell: header, toolbar, mode dispatch |
| `components/layout/panel/chats-panel.tsx` | ATTENTION + workspace sections |
| `components/layout/panel/activity-panel.tsx` | filter chips + flat list |
| `components/layout/panel/skills-panel.tsx` | studio conversations |
| `components/layout/panel/workspace-section.tsx` | collapsible section (was `WorkspaceRow`) |
| `components/layout/panel/conversation-row.tsx` | one row, one- or two-line (was `SessionRow`) |
| `components/layout/workspace-dialogs.tsx` | the five dialogs extracted from `app-sidebar.tsx:721-855` |
| `components/layout/use-open-workspaces.ts` | persisted open set (§3.3) |
| `hooks/use-all-threads.ts` | shared `listAll` hook (§4.1) |

### Modified

| File | Change |
| --- | --- |
| `components/layout/app-sidebar.tsx` | 1223 → ~80 lines: `<Sidebar><NavRail/><SidebarPanel/></Sidebar>` plus dialog state |
| `components/ui/sidebar.tsx` | width math becomes rail + panel; `collapsible="icon"` collapses the panel and keeps the rail at 68px instead of shrinking everything to 3rem (`:31`, `:276-278`) |
| `components/layout/app-shell.tsx` | mobile sheet width for rail + panel (§8) |
| `api/threads.ts` | add `listAll`, `threadKeys.all()`; add `threadKeys.all()` to every invalidation site (§4.1 caveat) |
| `api/types.ts` | fix the stale `schedule_id` comment (§4.3) |
| `components/command-palette/command-palette.tsx` | replace the `useQueries` fan-out with `use-all-threads` (§4.1) |
| `components/layout/use-sidebar-selection.ts` | unchanged logic; only its callers drop sticky mode (§3.4) |

`mobile-header.tsx` needs no change — it only calls `setOpenMobile`.

---

## 8. Mobile

Rail + panel both go inside the existing off-canvas sheet. Width moves from
`min(20rem, 86vw)` (`ui/sidebar.tsx:30`) to `min(23rem, 92vw)`: 68px rail plus a
~300px panel. On a 390px-wide phone that is 359px, leaving a usable dismiss
gutter.

One implementation, one mental model, no divergent mobile nav. `MobileDockBar`
and `MobileHeader` are untouched — they serve the workspace dock, which is a
different axis entirely.

Touch targets: rail tiles are 44px+ tall (icon 20px + label 10px + padding),
meeting the usual minimum. The rail does not scroll at 8 items on any phone.

---

## 9. Build order

Big-bang rewrite, per decision — but **on a branch** (`sidebar-redesign`), not
`main`. Same end state; replacing the app's only navigation in one pass means
there is no working app to fall back to mid-flight, and a branch makes
`git switch main` the escape hatch. This is the one place I would push back, and
it costs nothing to accommodate.

1. **Rail + shell.** `nav-rail.tsx`, `use-panel-mode.ts`, sidebar width math,
   mobile sheet width. Panel still renders today's tree, so the app stays usable.
2. **Extract rows and dialogs.** `conversation-row.tsx`,
   `workspace-section.tsx`, `workspace-dialogs.tsx` out of the big file. Pure
   moves, no behavior change — this is what makes steps 3–5 reviewable.
3. **Chats panel.** ATTENTION, persisted open state, delete `visibleThreads`,
   drop sticky mode.
4. **Activity.** `listAll`, `use-all-threads`, the invalidation sweep from §4.1,
   filter chips, rail badge. Palette switches over.
5. **Skills panel** and the §5 deletions.
6. **Sweep.** `bun run lint`, `tsc -b`, and a manual pass over the UI rules —
   grep the new files for text elements without `text-foreground` /
   `text-muted-foreground` / `text-sidebar-foreground`, and for any absolute
   color.

Use `bun`, not `pnpm` — pnpm deadlocks in this environment.

### 9.1 Verification

No test runner is configured in `frontend/package.json`, so this is manual:

- [ ] Every rail destination navigates; active state correct per §2.1
- [ ] Clicking an Activity row opens the chat and the panel **stays** on Activity
- [ ] `panelMode` and open-workspace set survive a reload
- [ ] Starting/finishing a run updates ATTENTION, the section badge, and the rail
      badge — and does **not** reflow a collapsed section (§3.2)
- [ ] Deleting a conversation removes it from the section *and* ATTENTION *and*
      Activity (the §4.1 caveat, the likeliest bug)
- [ ] Bulk ⌘/⇧-select works; a plain click always navigates
- [ ] Collapse (⌘B) hides the panel, keeps the rail
- [ ] Skill Studio reachable from the rail; absent from the workspace list
- [ ] Spot-check ~4 themes incl. one light and one dark for rail contrast (§6)
- [ ] Mobile sheet: rail + panel fit, targets tappable

---

## 10. Deliberately out of scope

- **Panel sub-nav for Customization / Settings.** Their 6 and 3 horizontal tabs
  (`customization-page.tsx:66-71`, `settings-page.tsx:63-65`) would read better
  as vertical panel rows, and the §2.1 contract leaves room for it. But it means
  editing both pages to drop their `TabsList`, which is a different change to a
  different surface. Later.
- **Drag-to-reorder workspaces.** Order is `useWorkspaces` order today; no
  backend field for a custom one.
- **Pinned / starred conversations.** No `pinned` field on `Thread`
  (`types.ts:440-462`); needs a migration. ATTENTION covers the actual need
  (what wants me now) rather than the manual one.
- **Virtualized lists.** Not warranted until a workspace has hundreds of
  conversations.
- **Backend `GET /threads` pagination.** §4 fetches all threads. Fine at current
  volumes; the `include_scheduled=false` escape hatch already exists
  (`threads.py:34-36`) if a busy schedule makes it a problem.
