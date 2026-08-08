# The pane layer, the shell, the file editor, first run

Indexed from [`AGENTS.md`](../../AGENTS.md) §6.

## The pane layer

`components/panes/` — every surface is a pane, and panes are tabs inside zones of
a dockview grid. It replaced a router `Outlet` that owned exactly one surface plus
a right dock with its own tab strip and its own four panel kinds: a chat and a
terminal are the same kind of thing to a user, and the app used to model them as
different kinds of thing.

**`renderer: 'always'` is the load-bearing line.** Dockview renders those panels
into one shared overlay container tracked to their group's bounding box, so moving
a pane between zones never reparents its DOM node. That is what keeps a PTY, a
preview iframe and a Monaco buffer alive across a drag — reparenting an iframe
reloads it, and `app-shell` used to contort itself around exactly that (maximize
collapsed the existing panel rather than portaling the dock, for this reason).
Measured before adopting it, and again in the product: a terminal dragged into a
new group keeps its shell, with one xterm instance in the DOM throughout.

Rules that cost something to rediscover:

- **A layout template cannot be a frozen constant.** `fromJSON` destroys any panel
  the incoming layout does not mention — `reuseExistingPanels: true` preserves the
  ones it *also* lists, and nothing more. So every template is a function of the
  live pane set (`layout-templates.ts`), and a saved layout contributes only its
  *geometry*: its pane ids belong to the workspace it came from, so `reshape`
  re-deals the live panes and rebuilds the `panels` map from them.
- **Pane id = dockview panel id, persisted.** Panes key their own state off it via
  `lib/tab-storage.ts` (`lursor:tab:<id>:*`), and those keys are global, so a
  recycled id hands a new pane a dead one's preview URL. The `lursor:dock:*`
  migration carries the old tab ids across for this reason; the old key is left in
  place.
- **Never persist a layout on a workspace switch.** `loadedFor` guards the write:
  on the render where the active workspace changes, a write would land the previous
  workspace's layout in the new one's key. Same trap the right dock documented.
- **`ensurePane` targets active → most recently used → leftmost.** An "open this
  file" request displaces whatever that pane held, so it has to be the pane you are
  looking at, not one you forgot was open.
- **A hidden pane keeps running.** That is what `always` buys and what it costs.
  Every pane gets `active` from `onDidVisibilityChange`; gate expensive work on it.
- **`layout-shapes.ts` is the only module that narrows a serialized tree.**
  `SerializedGridObject<T>` types `data` as `T | SerializedGridObject<T>[]` without
  discriminating on `type`, so readers used to re-assert the shape by hand — 18 casts
  across three files and three separate answers to "what are this tree's leaves". Ask
  `leaves`, `leafViews`, `leafIds`, `countLeaves` or `mapLeaves` instead; the two
  remaining casts live in `asLeaf`/`children`. `LeafData` is dockview's own group
  state, not a hand-written `{id, views, activeView}` — a zone can also carry
  `locked`, `constraints` and `tabGroups`, and a narrower type lets a rebuild drop
  them silently.
- **Read a pane's kind with `paneKindOf(panel)`** (`paneParamsOf` for the rest of the
  params). `panel.params` is an open record, so getting ours out takes a cast, and
  that cast lives in `pane-kinds.ts` and nowhere else.
- **`layout-shapes` and `pane-kinds` import dockview `import type`, and must keep
  doing so.** Both are reached from the shell on every route, so a *value* import
  pulls dockview into the entry chunk past the lazy pane host. That is why
  `HORIZONTAL` is a double-cast string literal instead of `Orientation.HORIZONTAL`.
  Check with `bun run build` and compare *first-load* bytes — the entry chunk alone is
  misleading, because rolldown moves shared modules in and out of it between builds.

**Chat is a pane, so routing is an address, not an owner.** `?c=` is written *from*
the focused chat pane and read exactly once per workspace load, to honour a
bookmark. A sidebar row therefore cannot address a pane through the URL — it parks
a request on `lib/open-thread.ts`, the same channel `open-file` and `open-preview`
use, and the shell routes it.

**To add a cross-component open request, call `createRequestChannel`**
(`lib/request-channel.ts`). The three `open-*.ts` modules are that factory plus their
own request type and their own reason for existing; each re-exports the four names its
callers already use (`requestOpenX` / `peekPendingX` / `consumePendingX` /
`subscribeOpenX`) and the channel object for the shell. Keep the module
dependency-free — no React, no dockview — because it is reached on every route.

On the receiving end the shell uses `usePendingRequest(channel, workspaceId, ready,
handle)`. **`ready` matters**: the pane host is lazy, so a request can arrive before
dockview exists, and a handler that runs then marks it handled while `ensurePane`
no-ops on `if (!api) return` — the request opens nothing and is never consumed. The
shell passes `isMobile || layout.api !== null`, and the `isMobile` half is not
decoration: there is no pane layer on a phone at all, so gating on `layout.api` there
would stop a plan doc ever reaching `MobilePlanView`. Consuming is the *handler's*
choice — a conversation is opened by the shell, while a Preview pane reads its own URL
out of the channel once it mounts.

**Outside a workspace there is a global layout** (`lursor:layout:_global`), which
is what `/analytics`, `/video`, `/image` and `/artifacts` resolve to. Those kinds
are not workspace-scoped — Usage is cross-workspace, Video and Image are scoped to
a LAIOS box — and `WORKSPACE_KINDS` keeps a global zone from offering a Terminal
with no directory to open in. A global layout starts *empty*: the default seeds a
chat pane, and a chat with no workspace has nothing to talk to.

**Mobile has no pane layer.** A four-zone grid on a 390px screen is not a layout,
so a phone shows one surface at a time and the bottom bar switches between them —
reading the workspace's persisted layout (`readLayoutKinds`) so the bar reflects
what you actually opened rather than a fixed list. Same `PaneContent` map, no
zones, tabs or drag.

## The shell

`WindowBar` is the frame's own 44px strip: full width, above the sidebar and the
content. It exists to end a negotiation — on frameless macOS the traffic lights
float over the top-left, and four surfaces each used to reconstruct that band and
each decide whether to inset past the buttons. Reserving it once means nothing
below has to know the buttons exist. On a phone it is the app bar too (hamburger,
title, `⚙`), which is what let `MobileHeader` go.

The sidebar's box is `position: fixed`, so nothing can push it down: the primitive
reads `--sidebar-top` and derives `--shell-height: calc(100svh - var(--sidebar-top))`,
and the shell sets it once. Every `h-svh` that meant "the whole viewport" is
`h-(--shell-height)`.

**Settings is a dialog, not a page.** One category rail over the existing sections,
state in `?settings=<category>` so it deep-links and survives a reload while opening
over whatever route you are on. It absorbed `/settings`, `/customization`, `/laios`
and `/schedules`; those paths are one-hop redirects now. Two-pane categories
(Capabilities, Environment, Schedules) get a wider dialog, and `useBrowserBox`
honours a `data-browser-bounds` ancestor so they size to the modal rather than to
the fold.

**Watch the entry chunk.** Three things belong behind a lazy boundary and will
quietly climb back out: dockview (~76KB, behind the pane host), Monaco (~330KB,
behind both the Files pane and the *skill editor dialog* — the settings dialog
mounts on every route, so an eager import there puts Monaco in the entry), and the
media/analytics pages. `use-pane-layout` must stay free of dockview **value**
imports for the same reason: `Orientation` is a runtime enum, and importing it
pulls the whole library in. When the entry chunk moves unexpectedly, build the
previous commit in a worktree and diff the chunk lists — that is how the Monaco
regression above was found, after two wrong guesses.

## Navigation and the sidebar

One sidebar column (`sessions-pane.tsx`): nav rows, Pinned, and Projects with its
folders and **every** project's recent sessions inline (`INLINE_SESSIONS`). It
replaced a 68px workspace rail plus a contextual panel, which cost the sidebar two
widths, two toggles, and 10px truncated workspace names. It also replaced an
Activity feed — a second cross-workspace list of the same conversations in time
order, with its own filters, reachable only by leaving the projects behind. What it
was good for is in the list itself now: sessions from every project are on screen
at once, and a running agent shows as a dot on its project row
(`use-workspace-status`). Rolled-up marks survive only on a **shut** folder header,
which is hiding the rows that would carry their own; open it and the header goes
quiet. No member count — it restated the list directly below and read as a session
count while counting projects.

A **folder** (`folder-row.tsx`) is a root row like a project, so it takes a
project row's geometry — `pl-2`, one 16px glyph, 13px name, caret trailing on
hover (held open while shut, the one state with no rows to imply it). Its members
hang off a **guide rail** rather than being padded in: each carries four session
rows of its own, and indentation alone left the group's contents at the same left
edge as everything else. Filing into a shut group **opens** it
(`use-workspace-tree`) — otherwise the drop looked like a delete. The studio gets
**no** drag target, since `tree` never sees it and the server would happily file
it somewhere nothing renders.

A project row is **two targets**: the **name** switches to the project and
drills the list into it, the **caret** shows/hides its sessions in place
(`use-collapsed-projects`, persisted; shut projects are stored, so a new project
arrives expanded). They are siblings, not nested — a button inside an anchor is
invalid HTML — and the row div owns the hover background and the drag handlers,
with `draggable={false}` on the link so an anchor drag can't beat filing a
project into a folder. Which project the list is **drilled into** is sidebar
state, not a route (`use-project-drill`) — opening a session navigates, and a
route-derived scope would snap back under the cursor. ⌘1–⌘9 switch without
drilling, because a shortcut that re-scopes the list makes the sidebar jump on
every hop between two repos.

## The file editor

`components/files/` — `file-viewer.tsx` wires a workspace up (tree, search,
watcher, open-file requests); `editor-pane.tsx` renders one group of tabs plus the
active file; `file-buffers.ts` is the state machine behind both; `code-editor.tsx`
wraps Monaco. The skill editor reuses the pane and the buffers, so it is the same
editor without a workspace around it.

**Monaco's language workers must be configured, not just registered.** Left at
their defaults they report a screenful of errors on correct code, because each one
assumes it is the whole toolchain for the file and this is a single-file view over
a repo whose types live on disk. `monaco-setup.ts` therefore turns *semantic*
TS/JS validation off outright (no `tsconfig.json`, no `node_modules`, no sibling
modules in the model graph — so every import is "cannot find module"), demotes
CSS `unknownAtRules` so Tailwind v4's `@theme`/`@apply` are not errors, and puts
the JSON worker in jsonc mode with `enableSchemaRequest: false` so it never phones
out to a schema URL. Syntax validation stays **on** everywhere — an unbalanced
brace is real and needs no project. There is deliberately **no toggle**: semantic
validation here is wrong for a structural reason, not a preference. If real
diagnostics are ever wanted the honest version is a `tsserver`/LSP bridge on the
backend, which is a subsystem, not a flag.

Note the API moved in Monaco 0.56: the language namespaces are top-level
(`monaco.typescript`, `monaco.css`, `monaco.json`), and `monaco.languages.*` is a
deprecated stub. `unknownAtRules` is a real rule in the `vscode-css-languageservice`
behind the worker but missing from Monaco's public `lint` type, so it is set
through a widened type rather than a cast to `any`.

**Content search** is `GET /files/grep`, the counterpart to `/search` (filenames).
Two implementations of one endpoint: ripgrep when the machine has it, a pure-Python
walk when it doesn't — a packaged Electron build cannot assume `rg`, so it stays an
optimization and never a dependency. They are kept deliberately interchangeable:
`rg` runs with `--no-ignore` (a checkout's `.gitignore` must not change what a
search finds from one machine to the next), `--hidden`, and one exclude glob per
`_IGNORED_DIRS` entry, and the `include` filter plus every cap are applied in
Python for both paths. `rg` reports byte offsets and Monaco counts characters, so
the column is converted. Read-only by design — there is no replace-across-files.

**Split is one buffer store with tabs tagged by group**, never two
`useFileBuffers`. Two stores would each need their own watcher fan-out and
reconcile path, and the same file open in both would give one file on disk two
independent dirty buffers — a conflict generator. So `OpenFile.groups` is a *set*
of groups (a file split against itself is one buffer in two views), `saveFile` /
`reconcile` / auto-save stay keyed on path alone, and `closeFile(path, group)`
only prompts about unsaved edits when it is dropping the last view. Two
`<Editor path=…>` with the same path share a Monaco model deliberately: edits and
undo stay in step, while each editor keeps its own scroll and cursor because view
state lives on the editor, not the model. Below `MIN_SPLIT_WIDTH` the split
control is disabled with a reason rather than producing two unreadable columns.

**Files drop *into* the tree, onto the folder under the cursor.** One drop surface
for the whole panel (`dragover` bubbles, so the row is a `closest` away and the empty
space below the last row still stands for the root); a file row passes the drop to
the folder it lives in. `lib/file-drop-in.ts` reads the `DataTransfer`, which is a
hostile object: `items` dies with the event — so the entry walk must be *started*
inside the handler — and a dropped folder arrives as an entry tree whose
`readEntries` returns in batches of 100, silently truncating anything larger if you
call it once. Each walked file carries its relative path in an `UploadEntry`
alongside the `File`, **not** in a re-wrapped `File.name`: some engines take the
source file's name instead and the folder would flatten on drop. Caps (300 files,
128 MB) reject a drop whole rather than uploading part of it.

Upload overwrites by name without asking, which is fine for a menu command and not
for a drop that missed a row by two pixels — so the destination is listed first and
any collision becomes a dialog. The picker takes the same route, so both paths ask
the same question.

**A drop that came from inside the tree is a move, not a copy** (`/files/rename`,
which refuses to overwrite with a 409). It identifies itself two ways, because the
desktop drag-out cancels its own HTML drag and takes the marker with it: the
`TREE_ITEM_DRAG_TYPE` payload on a browser drag, and — for a native one — a
short-lived record of what this window just started dragging, believed only for a
single dropped file whose name matches. Failing both, a dropped file whose *real
path* is already inside the workspace is also a move; that check is off on a remote
connection, where paths belong to the wrong machine.

**A file leaves the window as a file, not as text.** Explorer rows are `draggable`
and go through `lib/file-drag-out.ts`, which has two mechanisms because the renderer
has no way to promise a file to the OS: in the desktop app it cancels its own drag
and lets the main process run a native one (`file:drag` →
`webContents.startDrag`), and in a browser it falls back to Chromium's `DownloadURL`
promise plus the path as `text/plain`. A remote connection stages a temp copy of the
downloaded bytes rather than dragging the path, which is a path on the *other*
machine — see [`../ELECTRON.md`](../ELECTRON.md). Nothing in the tree reorders,
so a draggable row can only ever mean "out"; the composer's drop handler ignores a
drag carrying no `files`, so dragging a row over the chat is a no-op there.

A search result — or any `OpenFileRequest` carrying a `line` — travels as a
`RevealTarget` on the `OpenFile`, is applied on editor mount, and is then cleared,
so a later re-render can't drag the cursor back. A reveal also forces a Markdown
file to open as source: there is no line 42 in a rendered preview.

## First run

`pages/onboarding/` — a five-step walkthrough at `/welcome`: bring a model, connect
GitHub, open the first workspace, create the first agent, then a summary of the
surfaces before landing in it. Full-screen, outside `AppShell` (nothing in the
sidebar or dock is useful yet). Four rules hold it together:

- **Progress is derived, never stored.** `useOnboardingStatus` reads the
  OpenRouter key, custom providers, the GitHub config, the workspace list, and the
  agents — so a step is "done" because the thing exists, not because a step was
  walked. That is what makes `/welcome` safe to revisit (Settings → General links
  to it) and invisible to installs that predate it: `OnboardingGate` silently
  marks a ready install complete instead of showing it a tour.
- **"No workspaces" is never true.** `ensure_skills_workspace` registers the
  skills catalog on every boot, so first-run detection has to filter
  `is_system` — otherwise the walkthrough thinks a workspace already exists.
- **A fresh install has no agents.** Nothing seeds one (unlike prompt templates
  and the skills catalog), and a chat with no agent can't be typed into — hence
  the agent step, without which the walkthrough would hand over a dead end. It
  prefills a name and, on a local-only install, the endpoint's own first `custom:`
  model: inheriting the app default there would name a cloud model the box has no
  key for. Never over a model the user picked themselves.
- **Only a model gates.** GitHub, the workspace, and the agent can be skipped (the
  forward control says so); the rail refuses to unlock past step one until a model
  source exists, since every other surface assumes one. LAIOS is deliberately
  absent — it needs its own daemon installed first, so it stays a post-setup
  destination.
- **The seen-flag is `localStorage`, read synchronously.** The gate short-circuits
  on it before mounting anything, so a returning user fires no extra queries;
  only an unfinished install pays for the check. Losing the flag costs nothing —
  see the first rule.

`GitHubRepoPickerDialog` takes `navigateOnClone={false}` here: it otherwise jumps
straight into the cloned workspace's chat, which would skip the last step.

Finishing hands over to `/workspaces/<id>/chat`, calling **`seedChatOnlyLayout`**
first: a single chat pane for that workspace, so the first conversation is the
whole window instead of a chat beside an empty panel. Guarded by
`hasStoredLayout`, so it is a first-visit default and never overwrites a layout the
user arranged; a zone's `+` adds the rest.
