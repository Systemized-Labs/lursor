# Right panel: editor upgrade

Plan doc. Iterate here before any code lands. Deleted once shipped, with the
durable decisions folded into `AGENTS.md` (see its note on per-feature plans).

## Goal

Make the right dock's Files panel a place you can actually work in for an hour,
not just glance at. Four things, in order of how much they hurt today:

0. **Stop the false red squiggles.** Every TS/TSX file opens covered in errors
   that aren't real. This is the one that makes the editor feel broken.
1. **Maximize the panel** so a file can take the whole window, reversibly.
2. **Search** — find/replace inside the file, and content search across the
   workspace with a results list you can click into.
3. **Split the editor** inside one Files panel, two files side by side.

A fifth section lists cheap Monaco wins that are explicitly *out* of the main
scope and can be picked off individually.

## Where things stand

| File | Role |
| --- | --- |
| `components/shell/right-dock.tsx` | Dock tab strip + `DockPanelContent` switch |
| `hooks/use-dock-state.ts` | Tab list, active tab, collapsed — persisted per workspace |
| `components/files/file-viewer.tsx` | Workspace wiring: tree + editor split, file watcher, open-file requests |
| `components/files/editor-pane.tsx` | File tab strip, editor header, `…` menu, markdown/diff/image bodies |
| `components/files/file-buffers.ts` | `useFileBuffers` — open files, dirty tracking, save, autosave, conflicts |
| `components/files/code-editor.tsx` | `CodeEditor` / `DiffCodeEditor` — Monaco wrappers |
| `components/files/monaco-setup.ts` | Bundled Monaco + language workers |
| `components/files/monaco-theme.ts` | App-theme-derived Monaco theme |
| `backend/app/api/files.py` | list / read / raw / serve / **search (filenames only)** / write / upload / create / rename / delete / watch |

Constraints worth keeping in view: any dock kind can be open more than once, only
the *visible* panel consumes app-wide open requests, and panel state is keyed by
tab id (`lib/tab-storage.ts`). Nothing below may weaken those.

---

## Phase 0 — kill the false diagnostics

### Root cause

`monaco-setup.ts` registers the TypeScript, JSON, CSS and HTML web workers but
never configures them. So:

- **TS/TSX/JS**: the TS worker type-checks each open file as a standalone program
  with default compiler options. There is no `tsconfig.json`, no `node_modules`,
  no sibling modules in the model graph — so every import is "Cannot find module",
  every JSX element is "Cannot use JSX unless the '--jsx' flag is provided", and
  every inferred type from an unresolved import is `any` with a follow-on error.
  Semantic checking here is structurally impossible to get right: the browser
  editor is a single-file view over a repo whose types live on disk.
- **CSS**: the CSS worker flags Tailwind v4 at-rules (`@theme`, `@apply`,
  `@custom-variant`, `@utility`) as unknown. `index.css` is unreadable.
- **JSON**: `tsconfig.json`, `.vscode/*.json` and friends are JSON-with-comments;
  the worker reports every comment and trailing comma as a syntax error.

### Fix

Configure the workers in `monaco-setup.ts`, once, before the first mount:

```ts
// TS/JS: keep syntactic checking (an unbalanced brace is a real error the
// worker can see), drop everything that needs the project graph.
for (const defaults of [
  monaco.languages.typescript.typescriptDefaults,
  monaco.languages.typescript.javascriptDefaults,
]) {
  defaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntacticValidation: false,
    noSuggestionDiagnostics: true,
  })
  // Still set the options that change how the file is *parsed*, so TSX and
  // modern syntax tokenize and syntax-check correctly.
  defaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.Latest,
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    allowJs: true,
    allowNonTsExtensions: true,
    noEmit: true,
  })
}

// CSS/SCSS/LESS: Tailwind's at-rules are not errors.
for (const defaults of [cssDefaults, scssDefaults, lessDefaults]) {
  defaults.setOptions({ validate: true, lint: { unknownAtRules: "ignore" } })
}

// JSON: jsonc is the norm for config files; no schema store to validate against.
monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
  validate: true,
  allowComments: true,
  trailingCommas: "ignore",
  schemaValidation: "ignore",
  enableSchemaRequest: false,   // never phone out to a schema URL
})
```

Two supporting changes:

- `DiffCodeEditor` gets `renderValidationDecorations: "off"` — a review view
  shouldn't decorate either side.
- `monaco-theme.ts` currently sets no `editorError.*` / `editorWarning.*` colors,
  so what squiggles *do* survive are drawn in Monaco's stock red. Add the
  `--destructive` / `--warning` tokens so a genuine syntax error reads as part of
  the theme.

### Decisions

- **No user-facing toggle.** Semantic validation is wrong here for a structural
  reason, not a preference; a "full diagnostics" checkbox would only ever produce
  noise. If we later want real diagnostics, the honest version is an LSP bridge
  (see Rejected).
- Syntax validation stays **on**. It is genuinely useful and needs no project.

### Verify

Open `frontend/src/components/files/file-viewer.tsx`, `frontend/src/index.css`
and `frontend/tsconfig.json` in the panel. Zero markers on all three. Then break
a brace in a scratch `.ts` file — one syntax error appears, themed.

---

## Phase 1 — maximize the panel

### Behaviour

A `⤢` control in the dock tab strip (beside the collapse button) makes the dock
fill the window: the center column (chat/route) collapses to zero and the app
sidebar closes. `⤡` / `Esc` restores both. Dock-level, so it works for Terminal
and Preview too, not only Files — the state belongs to the dock, not to a kind.

### Implementation

The hard requirement is **no remount**. Monaco view state, terminal sessions and
preview iframes all die if the panel's position in the React tree changes, so
maximizing must not move `<RightDock>` into an overlay or a different branch.

- `use-dock-state.ts`: add `maximized: boolean` to `DockState` + `StoredDock`,
  with `setMaximized`. Persisted per workspace alongside `collapsed`; `collapsed`
  wins if both are somehow set (`readDockState` normalizes).
- `app-shell.tsx`: the center `ResizablePanel` gains `collapsible`,
  `collapsedSize={0}` and a `ref`; an effect calls `collapse()` / `expand()` from
  `dock.maximized`. The panel group, the tree and every panel stay mounted and
  keep their sizes — restoring returns to the exact split the user had.
- Sidebar: `AppShell` renders `SidebarProvider` itself, so it can't call
  `useSidebar`. Extract the desktop body into a `<ShellBody>` child component
  inside the provider; it reads `useSidebar()`, closes the sidebar on maximize and
  restores the previous state on exit. (The provider persists open state in a
  cookie, so we snapshot the pre-maximize value in a ref rather than assuming
  "open".)
- `Esc` is handled in `RightDock` on `window`, guarded so it doesn't fire while a
  dialog/dropdown is open (Radix stops propagation itself) or while Monaco's find
  widget has focus — closing find should not also unmaximize.
- The `DockRail` is not rendered while maximized (the dock isn't collapsed).
- macOS: `useMacTitlebar` already gives the strip an `h-11 bg-sidebar` chrome
  line. Maximized, that strip is the only thing under the traffic lights, so keep
  the taller variant and leave the existing left inset.
- Mobile is untouched — the bottom bar already renders panels full-screen.

### Open question

Shortcut. `Cmd+B` / `Shift+Cmd+B` are the sidebar and rail. Proposal:
`Ctrl/Cmd+Shift+Enter` for maximize toggle, since it reads as "expand this pane"
and collides with nothing. Alternative: `Cmd+\`.

---

## Phase 2 — search

Two independent halves; the first is small, the second is where the work is.

### 2a — in the open file

Monaco's find widget already works but nothing advertises it, and it isn't
reachable from anywhere but the editor's own focus.

- `CodeEditor` grows `onReady?: (editor: Monaco.editor.IStandaloneCodeEditor) => void`
  so `EditorPane` can drive editor actions. Store it in a ref, clear on unmount.
- A magnifier button in the editor header runs `actions.find`; the `…` menu gets
  "Find" and "Replace" (`editor.action.startFindReplaceAction`) with shortcut
  hints, so the capability is discoverable.
- Register `Cmd+F` / `Cmd+H` at the pane level too, so they work when focus is in
  the file tab strip or the header rather than inside the text area.
- `monaco-theme.ts`: add the widget/input tokens the find bar actually uses —
  `editorWidget.foreground`, `input.foreground`, `input.border`,
  `inputOption.activeBorder`, `inputValidation.*`, `editor.findMatchBackground`,
  `editor.findMatchHighlightBackground`, `editor.findRangeHighlightBackground`,
  `toolbar.hoverBackground`. Today they fall back to stock `vs`/`vs-dark` and the
  widget looks foreign in every custom theme.

### 2b — across the workspace

**Backend — new endpoint.** `backend/app/api/files.py`:

```
GET /workspaces/{id}/files/grep
  q          required, the needle
  regex      bool = false     (invalid pattern -> 422, not 500)
  case       bool = false     (case sensitive)
  whole_word bool = false
  include    optional glob    ("src/**/*.ts")
  limit      int = 200        matches, hard-capped
->
{
  "matches": [
    { "path": "src/api/files.ts", "line": 42, "column": 7,
      "text": "  search: (workspaceId: string, …", "match_length": 6 }
  ],
  "truncated": bool,     // hit `limit` or the scan ceiling
  "files_scanned": int
}
```

Implementation notes:

- Reuse what `search_files` already establishes: `_workspace_root` +
  `_safe_join` confinement, `_IGNORED_DIRS` pruning, a `_MAX_SEARCH_SCAN`-style
  ceiling. Skip anything over `_MAX_READ_BYTES` and anything containing a NUL
  byte, exactly as `read_file` does, so binaries never produce matches.
- Prefer `rg` when present: `shutil.which("rg")` and an `asyncio.create_subprocess_exec`
  in the shape of `app.api.github._run_git`, with `--json --line-number --column
  --max-count`. Fall back to a pure-Python walk when it isn't — `rg` must stay an
  optimization, never a dependency, because packaged Electron builds can't assume
  it. Both paths return the same model, and the fallback runs under
  `asyncio.to_thread` so it never blocks the event loop.
- Cap matches per file (say 20) so one minified file can't fill the budget.
- Tests in `backend/tests/`: a needle found, a regex, `include` filtering, an
  ignored dir pruned, a binary skipped, traversal rejected, `truncated` set at the
  cap. The bar is `uv run pytest` green without editing existing tests.

**Frontend.**

- `api/files.ts`: `filesApi.grep(...)` + a `GrepMatch` type. Query, not mutation,
  keyed on the full parameter set with `keepPreviousData` so typing doesn't blank
  the list. Debounced ~250ms in the panel, and `AbortSignal` per request.
- The side pane of the Files panel becomes two views behind a small segmented
  control at its top: **Explorer** (today's tree) and **Search**. Both stay
  mounted; switching preserves tree expansion and search results. Which view is
  up is per-tab state (`lib/tab-storage.ts`, keyed by tab id — not workspace-wide,
  or two Files panels fight over it).
- Search view: query input, three toggles (`Aa`, `.*`, `ab|`), an optional
  include-glob field, then results grouped by file — collapsible file header with
  a match count, each row `line │ text` with the match segment emphasized. Footer
  states `N matches in M files`, and says plainly when results were truncated
  rather than silently showing the first 200.
- Clicking a result opens the file **and jumps to the line**. That needs a line
  to survive the open path:
  - `lib/open-file.ts`: `OpenFileRequest` gains `line?: number`, `column?: number`.
  - `useFileBuffers.openFile(path, name, reveal?)` carries a pending reveal on the
    `OpenFile`; `EditorPane` hands it to `CodeEditor`, which on ready (or on
    `path` change) calls `revealLineInCenterIfOutsideViewport` + `setSelection`
    and then clears it so a later re-render doesn't yank the cursor back.
  - Within the same panel the click can call `openFile` directly; the
    `open-file` channel change is what lets the command palette and future
    callers (chat citations, stack traces) do the same. Keep the "only the active
    panel consumes" guard intact.
- Empty/failure states: no query yet (hint at what search covers), no matches,
  request failed with a retry. Never a bare spinner in the results area — show
  the previous results dimmed while refetching.

### Explicitly out of scope for v1

Replace-across-files, search history, and a saved-search UI. Say so in the doc
that ships; the endpoint above is read-only by design.

---

## Phase 3 — split editor inside one panel

### Model

One buffer store, tabs tagged with a group. **Not** two `useFileBuffers`
instances: two stores would each need their own watcher fan-out and reconcile
path, and the same file open in both would produce two independent dirty buffers
of one file on disk — a conflict generator.

- `file-buffers.ts`:
  - `OpenFile` gains `group: 0 | 1`.
  - `activePath: string | undefined` becomes `activePaths: [string | undefined, string | undefined]`,
    plus `focusedGroup: 0 | 1`. Keep a derived `activePath` getter for the group
    that has focus so the skill editor and the dock-tab detail label need no
    change.
  - New: `moveToGroup(path, group)`, `splitFile(path)` (opens the same *file* in
    the other group — one buffer, two views), `closeGroup(group)` (moves its tabs
    back to group 0).
  - `closeFile` already falls back to the last tab; make it fall back within the
    same group, and drop the split when group 1 empties.
- `editor-pane.tsx`: takes a `group` prop, filters `openFiles` by it, and reports
  focus on click/`focus` anywhere inside. Its tab strip becomes a drop target so a
  tab can be dragged across the divider (HTML5 drag with the path as payload —
  no dnd library); the `…` menu also gets "Split Right" / "Move to Other Group"
  for keyboard and mouse-averse paths.
- `file-viewer.tsx`: nests panel groups — `[group 0 | group 1?] | tree`. Reuse the
  existing conditional-panel trick: when there is no split, render a single pane
  and no inner group, so the panel count doesn't churn. `autoSaveId` on the inner
  group must be tab-scoped, or two Files panels share one saved split ratio.
- Opening a file from the tree lands in `focusedGroup`.
- Two views of one buffer: Monaco keys models by `path`, and two `<Editor path=…>`
  with the same path share a model — which is what we want (edits and undo stay
  in sync), but they'd also share view state. Give the second view a distinct
  model URI (`path#2`) fed by the same buffer content, or accept shared scroll;
  needs a spike before committing. Same-file split is the *only* case this
  affects, so if it proves ugly, ship split with distinct files only.
- Sizing: below ~700px of panel width, a split is unusable. Below that the split
  control is disabled with a tooltip saying why, rather than producing two
  30-column editors.

### Verify

Split, edit the left file, save from the right group's header, close the right
group, confirm the tabs come back to the left and no buffer was lost. Then let an
agent edit a file open in both groups and confirm one reconcile, one conflict
banner.

---

## Phase 4 — optional, pick individually

None of these are in the agreed scope; listed so they don't get re-discovered.
Each is roughly an hour once Phase 0's editor ref exists.

- Sticky scroll, bracket-pair colorization, folding controls, indent guides
  (Monaco options, one line each).
- `Cmd+P` quick open scoped to the panel, reusing the existing filename
  `files/search` endpoint.
- Go to line (`Cmd+G`), format document where Monaco has a formatter
  (TS/JSON/CSS/HTML only — no Prettier in the browser).
- Clickable breadcrumb segments that reveal the folder in the tree.
- Restore open tabs across reload (persist paths + active per tab id).
- Git gutter decorations sourced from the existing `api/git` diff.

## Rejected

- **A real language service.** Correct semantic diagnostics need a `tsserver`/LSP
  bridge on the backend per workspace, with the project's own `node_modules`.
  That is a subsystem, not a phase, and it belongs next to the terminal work if
  it is ever wanted. Phase 0 is the honest interim: no wrong errors.
- **Fullscreen API for maximize.** Covers OS chrome, loses the app titlebar, and
  needs a separate Electron path. The in-window maximize is what the panel
  actually needs.
- **Rendering the dock into an overlay/portal when maximized.** Remounts every
  panel — kills terminal sessions and Monaco state.
- **Requiring ripgrep.** Fine as a fast path, unacceptable as a dependency for
  packaged builds.
- **Two `useFileBuffers` for split.** See Phase 3.

## Sequencing

Phase 0 alone is worth shipping first and is small. Then 1, then 2a with 2b, then
3. Every phase is independently landable and independently revertible.

## Verification bar (repo standard)

Frontend has no test runner: `bun run build` (`tsc -b`), `bun run lint`
(oxlint), and a manual pass in a real workspace. Backend: `uv run pytest` and
`uv run ruff check app tests`, with new tests for the grep endpoint and no edits
to existing ones.

## Questions for you

1. Maximize shortcut — `Cmd+Shift+Enter`, `Cmd+\`, or none?
2. Should maximize also hide the app sidebar (proposed: yes), or only the chat
   column?
3. Search results in the side pane (proposed, VS Code-like), or as a full-panel
   view that replaces the editor while searching?
4. Same-file split — worth the model-URI spike, or ship split for distinct files
   only?
