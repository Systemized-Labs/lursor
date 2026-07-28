# PLAN: Skills manager as a two-pane browser

> Status: **IMPLEMENTED** (2026-07-28). §§1–6 shipped; §7 still deferred. See
> §10 for where the build differs from the plan.
>
> Scope: replace the five stacked lists in `SkillsPage` with a list rail + detail
> pane. The rail is dense and filterable; the detail pane absorbs every control
> that is currently crammed into a row. `SkillEditorDialog` stays a fullscreen
> dialog for authoring — it is not moved into the pane (§3.4). No backend
> changes. Bulk actions are deliberately deferred to §7.

## 0. Why

`SkillsPage` (`frontend/src/pages/skills/skills-page.tsx:294`) renders five
always-expanded flat lists with no collapse, pagination or virtualization
(`skills-page.tsx:564-594`). Nothing in the page bounds its own height, and the
buckets that grow fastest are the ones you care about least: `external` is every
skill discovered in `~/.claude/skills` and the Cursor folders, which is 25+ rows
on a normal machine before you have authored anything of your own. At ~60px per
two-line row plus five prose group headers, a modest catalog is ~2500px of
scroll — inside a tab, under a `PageHeader`, with the toolbar already scrolled
away.

Length is the symptom. There are four structural causes, and a purely vertical
fix (collapse the big groups) addresses none of them.

### 0.1 The row is overloaded

`SkillRow` (`skills-page.tsx:144`) packs seven interactive targets into one line:
the enable `Switch`, the name-as-button, `SkillScopeMenu`, `SkillEnvMenu`, an
edit `Button`, the `DotsThree` menu, and up to two `Chip`s. It does not fit. The
workspace/origin label already gives up below the `sm` breakpoint
(`hidden ... sm:inline-block`, `skills-page.tsx:215` and `:222`), so on a narrow
window a local skill silently stops telling you which repo owns it.

Two of those seven are `outline` buttons sitting side by side
(`skills-page.tsx:228-230`) that each open a multi-select dropdown. They are
row-level editors for things that are not row-level facts.

### 0.2 Groups mutate under the cursor

Grouping is by reach (`groupOf`, `skills-page.tsx:91-96`), and reach is editable
inline from the row. Narrow an "Everywhere" skill to one workspace and its row
leaves the section you are looking at and reappears in another.

`SkillScopeMenu` already contains the workaround: it holds picks in a draft and
saves once on close, mirrored into a ref because Radix closes the menu inside the
same event as `onSelect`. The comment says why in as many words — saving per
click "would refetch the list, move the row into another group and tear the open
menu down mid-edit, making multi-select impossible" (`skill-scope-menu.tsx:47-56`).
`SkillEnvMenu` carries the same hack for the same reason
(`skill-env-menu.tsx:31-39`). That is ~40 lines of draft/ref plumbing across two
components existing to compensate for a layout decision.

### 0.3 The taxonomy is a flattened cross-product

Origin (`managed` / `local` / `external`) and reach (global / workspace set /
none) are orthogonal. `GROUPS` (`skills-page.tsx:63-89`) flattens them into five
buckets, which produces:

- **"Everywhere" and "From other tools" are both everywhere.** The hint for
  `external` has to say so out loud: "They apply everywhere, and Claude Code or
  Cursor still owns the files."
- **No bucket for an external skill you want narrowed.** The row does not offer
  `SkillScopeMenu` at all for `local` or `external` origins
  (`skills-page.tsx:213-229`) — you get a static label instead. The only route to
  narrowing is Copy/Move to catalog.
- **`unassigned` is a reach, `local` is a source, and they sit in the same list
  of headings** as if they were the same kind of thing.

### 0.4 You cannot ask the real question

The question a person actually has is "what will an agent running in *this*
workspace load?" There is no filter for it. `matches` (`skills-page.tsx:110`)
searches name, slug and description, and that is the whole of it. Answering the
real question today means reading five sections and mentally intersecting the
`assigned` rows' dropdown contents with the `global` rows.

### 0.5 Dead code

`embedded` is always `true`: the only route is `/customization`
(`frontend/src/App.tsx:40`), which renders `<SkillsPage embedded />`
(`customization-page.tsx:64`). The `PageHeader` branch (`skills-page.tsx:519`)
never runs, and neither does the `DESCRIPTION`-as-page-description path.

## 1. Shape

```
┌────────────────────────────┬──────────────────────────────────────────────┐
│ [search skills]         42 │  wiki-cli                       [⋯]         │
│ Applies in: ( Anywhere ▾ ) │  Drive a Hyve wiki — search, read, ingest…   │
│                            │                                              │
│ ▾ Catalog             12   │  Enabled       [•]  Loaded by agents in scope │
│    ● pdf                   │  Applies in    3 workspaces          ▾       │
│    ● wiki-cli          ◀   │  Variables     WIKI_TOKEN, +1        ▾       │
│    ○ playable-ads          │  Files         SKILL.md + 3      [Edit files]│
│    ● xlsx                  │  Folder        ~/.lursor/skills/wiki-cli  ⧉  │
│ ▾ In repos             3   │  ──────────────────────────────────────────  │
│    ● repo-conventions      │  # wiki-cli                                  │
│      lursor                │                                              │
│ ▸ Other tools         27   │  Drive a Hyve wiki — search, read,           │
└────────────────────────────┴──────────────────────────────────────────────┘
```

- **Rail** — one line per skill: state dot, name, and (for `local`) its
  workspace on a second muted line. No dropdowns, no chips, no action buttons.
  Target row height 28px vs today's ~60px.
- **Detail pane** — a labelled property list, then a read-only `SKILL.md`
  preview. Everything that was in the row lives here, with room for a label.
- **Sections are by source, not reach** (§2.2), so editing reach never moves a
  row.

## 2. Rail

### 2.1 Filters, not containers

The rail header holds two controls:

- **Search** — the existing `matches` predicate, unchanged.
- **`Applies in:` select** — `Anywhere` (default, no filtering) or a workspace.
  Picking a workspace filters to what an agent in it would load: `is_global`
  skills, skills whose `workspace_ids` include it, `local` skills whose
  `workspace_id` is it, and every `external` skill. This is §0.4, and it is a
  pure client-side derivation from data `useSkills` already returns.

A `Show disabled` toggle is **not** included. Disabled skills are the ones you
are most likely to be hunting for, and the state dot already distinguishes them.

### 2.2 Sections by source

Three collapsible sections, replacing `GROUPS`:

| Section | Predicate | Default |
| --- | --- | --- |
| Catalog | `origin === "managed"` | expanded |
| In repos | `origin === "local"` | expanded |
| Other tools | `origin === "external"` | **collapsed** |

Source is a property of where the files live. It changes only when you Move or
Copy — both of which are explicit, confirmed actions that already toast. So a row
moves between sections only when you asked it to, which is what §0.2 needs.

Collapsed state persists to `localStorage` under one key. "Other tools" starts
collapsed because it is the largest and the least actionable — those files belong
to Claude Code and Cursor.

Reach does not disappear; it becomes a muted right-aligned label on the row
(`Everywhere` / `3 workspaces` / `Not assigned`) and an editable field in the
detail pane. Within a section, rows sort by name as they do now.

### 2.3 Not virtualizing yet

A realistic ceiling is low hundreds of rows, and at 28px each the DOM cost is
fine. `ScrollArea` (`components/ui/scroll-area.tsx`) over plain rows is enough.
Revisit if a catalog crosses ~500.

### 2.4 Keyboard

`↑`/`↓` move the selection, `Enter` opens the file editor, `/` focuses search.
Selection follows focus, so arrowing down the rail streams detail panes — which
is the fastest way to audit what a catalog actually contains, and is impossible
today.

## 3. Detail pane

### 3.1 Properties

A two-column label/value list. Each row is one concern with a name attached to
it, which is the thing a bare icon button in a table row cannot have:

| Label | Control | Notes |
| --- | --- | --- |
| Enabled | `Switch` | Moved out of the rail. Same `toggleEnabled` call. |
| Applies in | `SkillScopeMenu` | For `managed`. For `local`/`external`, the static explanation currently at `skills-page.tsx:213-226`, plus the Move/Copy affordance so the escape hatch is where the limitation is stated. |
| Variables | `SkillEnvMenu` | Unchanged component. |
| Files | count + `Edit files` | `SKILL.md + n`, hover for paths. |
| Folder | path + reveal | Promote `folderHint` (`skills-page.tsx:103`) from confirm-dialog-only prose to a visible, copyable field. It is the single most useful fact about an `external` skill. |

The `DotsThree` menu keeps Edit files / Open in workspace / Move-or-Copy /
Delete, moving to the pane header.

### 3.2 SKILL.md preview

Below a separator, `SKILL.md` rendered read-only through the existing
`MarkdownRenderer` (`components/ui/markdown-renderer.tsx`) via
`skillsApi.readFile`. Fetched per selection with a React Query key, so arrowing
through the rail is cached.

This is the payload — a skill *is* its instructions — and today reading it costs
a modal open, a Monaco mount and a modal close.

### 3.3 Both menus lose their draft hack

Inside the pane, saving `SkillScopeMenu` no longer relocates anything: sections
are by source and the selection is by id. The draft/ref plumbing in
`skill-scope-menu.tsx:59-103` and `skill-env-menu.tsx:44-92` can collapse to
save-on-select. **Deferred to §7** — behaviour-preserving cleanup, not worth
entangling with a layout change. The plan only claims the hack becomes
unnecessary.

### 3.4 Monaco stays in the dialog

The obvious move is to inline `SkillEditorDialog` as the pane and delete the
modal. Not doing it. That dialog is a fullscreen editor —
`h-[95vh] w-[98vw] max-w-[1400px]` (`skill-editor-dialog.tsx:90`) wrapping
`EditorPane` plus a resizable file list. Squeezed into ~60% of a tab that is
already inside `AppShell` padding, it would be a worse editor than the one we
have.

Division of labour: **the pane is for reading and pointing** (what is this, where
does it apply, what does it say), **the dialog is for authoring**. `Edit files`
and `Enter` open it, `SkillEditor` is untouched, and its dirty-buffer close guard
(`skill-editor-dialog.tsx:64`) keeps working because it still owns its lifecycle.

## 4. Layout and state

- `ResizablePanelGroup` with `autoSaveId="skills-browser"`, mirroring the
  existing `autoSaveId="skill-editor"` (`skill-editor-dialog.tsx:258`). Rail
  `defaultSize={28} minSize={20}`.
- **Below `md`**: rail full-width, detail in a `Sheet`
  (`components/ui/sheet.tsx`) from the right. No two-pane at phone width.
- **Selection in the URL** — `?tab=skills&skill=<id>`, alongside the `tab` param
  `CustomizationPage` already manages (`customization-page.tsx:29-38`). Deep
  links to a skill, and survives reload.
- **Empty selection** — first row of the first expanded section auto-selects on
  load. An empty pane next to a full rail is a dead half-screen.
- **Deleted selection** — falls back to the next row in the same section.

## 5. Files

| File | Change |
| --- | --- |
| `frontend/src/pages/skills/skills-page.tsx` | Rewritten. `GROUPS`/`groupOf`/`SkillRow` out; rail + filters + panel composition in. Keeps `matches`, `folderHint`, the import handlers and all four `ConfirmDialog`s. |
| `frontend/src/pages/skills/skill-rail.tsx` | **New.** Sections, rows, collapse persistence, keyboard nav. |
| `frontend/src/pages/skills/skill-detail-panel.tsx` | **New.** Properties + `SKILL.md` preview + actions menu. |
| `frontend/src/pages/skills/skill-scope-menu.tsx` | Unchanged in phase 1. |
| `frontend/src/pages/skills/skill-env-menu.tsx` | Unchanged in phase 1. |
| `frontend/src/pages/skills/skill-editor-dialog.tsx` | Unchanged. |
| `frontend/src/api/skills.ts` | Add a `readFile` query hook for the preview (the API call exists; only `skillsApi.readFile` is wired, imperatively). |
| `frontend/src/pages/customization/customization-page.tsx` | Pass through the `skill` param; drop `embedded`. |

Backend: nothing. Every field the design needs — `origin`, `is_global`,
`workspace_ids`, `workspace_id`, `root`, `root_label`, `is_owned_root`,
`enabled`, `resources`, `scripts`, `env_var_ids` — is already on `Skill`.

## 6. Order of work

1. Delete the dead `embedded`/`PageHeader` branch (§0.5). Standalone, mergeable
   on its own.
2. `skill-rail.tsx` with sections, filters and collapse. Render it beside the
   existing row list to compare density, then drop the old list.
3. `skill-detail-panel.tsx` properties, reusing both menu components as-is.
4. `SKILL.md` preview + the `readFile` query hook.
5. Resizable layout, URL selection, `Sheet` fallback under `md`.
6. Keyboard nav.

Each step leaves the page working.

## 7. Not in this plan

- **Bulk select.** With 40 skills the missing primitive is a checkbox column plus
  "assign to… / enable / disable / delete" over a selection — narrowing ten
  skills is currently ten dropdown sessions. Wants the rail to exist first.
- **Removing the draft/ref hack** from both menus (§3.3).
- **Workspace lens** — a sibling view that inverts the subject to the workspace
  and shows its loadout with `via:` provenance ("everywhere" / "assigned" /
  "in this repo"). The `Applies in:` filter (§2.1) is the cheap 80% of it.
- **Grouping "Other tools" by root folder** (`~/.claude/skills` vs
  `~/.cursor/rules` vs plugins) rather than badging each row.
- **Reach for `local`/`external` skills** — the §0.3 gap. A product question
  about whether we can narrow a folder another tool owns, not a UX one.

## 8. Constraints

- Every text element gets `text-foreground` or `text-muted-foreground`; no
  absolute colours; no `container` class. The state dot uses `bg-primary` /
  `bg-muted-foreground/40`, not green/grey literals.
- No `any`.
- The rail's state dot needs a non-colour cue for the same reason: filled vs
  hollow ring, plus `aria-label` and `title`.

## 9. Open questions

Built to the recommendation in each case; all three are still cheap to change.

1. **Is the state dot enough, or does the rail keep a real `Switch`?** A dot is
   read-only — toggling means selecting the row first, then the pane. That is
   worse for "turn these four off" and better for density. My call: dot, and let
   bulk select (§7) own the multi-toggle case. Flag if you want the switch kept.
   — **Built as a dot.**
2. **Should `Applies in:` default to the workspace you came from** when you open
   Customization from inside a workspace, rather than `Anywhere`?
   — **Built defaulting to `Anywhere`.**
3. **`Other tools` collapsed by default** — right call, or does hiding 27 skills
   by default make people think they vanished? A count on the collapsed header
   mitigates it. — **Built collapsed, with the count on the header.**

## 10. Where the build differs

- **The single-pane fallback is measured on the container, not the viewport.**
  §4 said "below `md`". The app sidebar takes 256px before this page sees any
  width, so a 768px window leaves ~470px here — two panes at 130px and 340px. A
  `ResizeObserver` on the page root switches to rail + `Sheet` below 720px of
  *container* width, which is the same rule stated in terms of the thing that
  matters. It subsumes phone width, so `useIsMobile` is not used.
- **Rail rows are one line for every origin.** §1 gave `local` skills a second
  muted line for their workspace; instead the right-aligned reach label carries
  it, which keeps every row at 28px and still fixes the §0.1 complaint that the
  owning repo vanishes on a narrow window.
- **`external` rows show their root** (`~/.claude`) rather than `Everywhere`.
  Inside a section headed "Other tools" the reach is already implied, and the
  root is what tells two same-named skills apart — the cheap half of §7's
  "group by root folder".
- **Plain `overflow-y-auto`, not `ScrollArea`** (§2.3) in both panes. Radix wraps
  the viewport's children in a `display: table` box, so the widest thing in an
  arbitrary `SKILL.md` — a long URL, an inline path — sets the width and drags
  the property list out with it.
- **`skillFolder` was added to `lib/skill-location.ts`**, not listed in §5. The
  `Folder` field needs an absolute path, and `Skill.root` is empty for the
  catalog; the path is composed from the owning workspace's `path` (the
  `is_system` one for `managed`), so nothing is hardcoded.
- **The preview strips leading YAML frontmatter.** Markdown reads `---\nname:
  …\n---` as a setext heading. The two fields it holds are the pane's own title
  and subtitle; the editor still shows the file verbatim.
- **`?skill=` survives a trip to another tab**, so you come back to the pane you
  were reading. Clearing it on tab change does not stick — the rail is still
  mounted for that commit and re-publishes its selection — and the param is inert
  everywhere else, so the rule is "it persists" rather than a race.
- **The chrome above the browser is gone.** §1 kept a toolbar row inside the tab,
  under a `PageHeader`. Both went: `Import` and `New skill` portal onto the tab
  strip's own row through a slot
  (`pages/customization/header-actions.tsx`), and Customization's title,
  description and this page's description prose are all removed — the sidebar
  says where you are and the tabs name the sections. The `h1` stays `sr-only`.
  That is ~160px the browser gets back, and the buttons keep living in
  `SkillsPage`'s React tree, so its dialogs, file inputs and pending states are
  unchanged. `Author with agent` is not among them — the Studio is reached from
  the sidebar, from `Open in Skill Studio` in a skill's actions menu, and from
  `Describe a skill` on the empty state.
- **The browser's height is measured, not encoded.** A `calc(100svh - Nrem)` with
  a hand-measured `N` breaks as soon as anything above it changes height, and the
  tab strip now wraps onto a second row at some widths. `useBrowserBox` reads the
  box's own distance to the fold (`ResizeObserver` + `resize`) and sets a pixel
  height, so it ends 24px above the fold at every width and the page never
  scrolls. The same measurement decides the pane count.
