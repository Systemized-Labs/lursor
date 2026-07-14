# PLAN: Mobile portrait support (all pages)

Status: **IMPLEMENTED** (Phases 0–4). QA: no horizontal overflow on any route
at 360/390px; bottom-sheet dialogs and the mobile dock sheet verified via
Playwright. `npm run build` passes.
Owner: frontend (`products/lursor/frontend`)
Target: **mobile web view** (phones hitting the Spark LAN UI via `scripts/startup.sh`), portrait orientation.

## Goal

Every page in the Lursor web view is usable in portrait on a phone (≥360px
wide): no horizontal scroll, tap targets ≥44px, chat is thumb-friendly, and the
desktop-only dock surfaces (Changes / Files / Terminal / Preview) are reachable
via a bottom sheet instead of being hidden. Works as a real touch web app
(iOS Safari + Android Chrome), including safe-area insets and the mobile URL bar
resize behavior.

Non-goal: this is not the Electron desktop window. We optimize the browser web
view; the desktop app already gets the same responsive CSS for free but is not
the acceptance target.

## Current state (audit)

What already exists:

- `useIsMobile()` (`src/hooks/use-mobile.ts`) — true below **768px** (`md`).
- Off-canvas sidebar on mobile (`src/components/ui/sidebar.tsx` uses a Sheet).
- `AppShell` (`src/components/layout/app-shell.tsx`) collapses the right dock
  entirely on mobile (`dockVisible = !isMobile && …`) and shows a floating
  `SidebarTrigger` (`md:hidden`).
- A `Sheet` primitive already exists (`src/components/ui/sheet.tsx`) — reusable
  for the mobile dock and for turning dialogs into bottom sheets.
- 14 of 85 `.tsx` files use responsive breakpoints today; the management pages
  (agents/tools/skills/prompts/providers/subagents/laios) have *some* `md:`
  grids. Chat, new-agent home, settings/customization tabs, and all 21 dialogs
  are essentially desktop-first.

Gaps:

1. **Right dock is inaccessible on mobile** — Changes/Files/Terminal/Preview
   simply vanish below 768px. (Decision: make reachable via bottom sheet.)
2. **`index.html` viewport** lacks `viewport-fit=cover`; no safe-area padding
   anywhere → content collides with the notch / home indicator.
3. **Layout uses `h-svh`** in the shell (good), but chat inner regions and
   dialogs assume desktop height; need `dvh`/safe-area review for the URL-bar
   resize.
4. **Dialogs** (21 of them) are centered modals with fixed `max-w-*` — cramped
   and often taller than the viewport on phones.
5. **Tab bars** (settings, customization) can overflow horizontally with no
   scroll affordance.
6. **Chat surface** — header (agent switcher + title + actions), composer, and
   message list need portrait layout; todo list / goal banner stack.
7. **Touch targets** — many icon buttons are `h-8 w-8` (32px), below the 44px
   guideline.

## Approach

Establish shared mobile primitives first, then sweep pages by tier. Keep to the
project UI rules: semantic text colors only (`text-foreground` /
`text-muted-foreground`), no absolute colors, no `container` class — use
`px-4 py-6 sm:px-6`-style padding.

### Breakpoint strategy

- Keep the single `md` (768px) boundary that `useIsMobile` and the sidebar
  already use — do **not** introduce a competing breakpoint.
- **Fluid, not fixed.** No hard pixel floor — layouts flex down to any width.
  Prefer `%`/`min()`/`clamp()`/`flex` and avoid fixed `w-[…]`/`min-w-[…]` that
  can force horizontal scroll. QA anchors: 360 / 390 / 430px portrait.
- Prefer CSS (`md:` prefixes, `dvh`, `flex-col` → `md:flex-row`) over JS
  `useIsMobile` where possible; reserve the hook for structural swaps (mount a
  Sheet vs. a resizable panel).

## Phases

### Phase 0 — Foundation (shared primitives)

- [ ] `index.html`: viewport → `width=device-width, initial-scale=1,
      viewport-fit=cover`; add `theme-color`.
- [ ] Add safe-area CSS utilities (Tailwind v4 `@theme`/`@utility` for
      `pt-safe`, `pb-safe`, `pl-safe`, `pr-safe` using `env(safe-area-inset-*)`).
- [ ] Audit `h-svh`/`min-h-svh` → confirm `dvh` where the URL bar should be
      accounted for (composer pinned to bottom, message list fills rest).
- [ ] Create a `ResponsiveDialog` wrapper (or extend `dialog.tsx`): renders a
      centered `Dialog` on `md+` and a bottom `Sheet` (`side="bottom"`,
      scrollable, `max-h-[90dvh]`) below `md`. Migrate dialogs to it in Phase 3.
- [ ] Make `TabsList` horizontally scrollable on overflow
      (`overflow-x-auto` + hidden scrollbar) as a shared tweak.
- [ ] Establish a min touch-target: bump primary icon buttons to `h-9 w-9`+ and
      ensure interactive rows are ≥44px on mobile.

### Phase 1 — App shell + mobile dock

- [x] Global mobile top header (`mobile-header.tsx`): hamburger (opens the
      off-canvas sidebar) + contextual title (route / workspace / active dock
      view). Replaces the old floating trigger; content flows beneath it so no
      per-page clearance hacks are needed. In-page `PageHeader` titles are
      screen-reader-only on mobile to avoid a doubled title.

- [ ] `AppShell`: on mobile, instead of dropping the dock, expose a **bottom tab
      bar** inside `/workspaces/:id` routes (Chat / Changes / Files / Terminal /
      Preview). Tapping a tab **switches the center view in place** (full-screen
      panel swap, not a drawer); panels mount on first visit and stay alive
      (hidden) when switched away so terminal/editor state survives.
- [ ] Bottom tab bar is `pb-safe` and only shown inside workspace routes where
      the dock is meaningful; "Chat" tab returns to the conversation.
- [ ] Verify `TerminalPanel` (`@xterm/addon-fit`) refits when the sheet opens.
- [ ] `FileViewer` (Monaco, lazy-loaded) — **full editing on mobile**. Apply
      touch-friendly editor options on mobile: `minimap.enabled: false`,
      `wordWrap: "on"`, larger `fontSize`, compact line numbers.
- [ ] Ensure the floating `SidebarTrigger` doesn't overlap page headers on
      mobile (it's `absolute left-2 top-2`); reconcile with per-page headers.

### Phase 2 — Core flows

- [ ] **New-agent home** (`new-agent/new-agent-page.tsx`): centered composer,
      project/agent pickers, branch selector — stack vertically, full-width
      controls, composer reachable above the keyboard.
- [ ] **Workspace chat** (`chat/workspace-chat-page.tsx`, 585 lines):
  - Header: agent switcher + editable title + actions collapse into a compact
    row / overflow menu.
  - Message list fills viewport, scrolls independently.
  - `ChatComposer` pinned to bottom with `pb-safe`; attachments + mode select
    fit narrow width.
  - `ChatTodoList` / `GoalBanner` / `GoalSetup` stack and scroll.
- [ ] **Settings** (`settings/*`) and **Customization** (`customization/*`):
  scrollable tab bars, single-column sections, full-width forms.

### Phase 3 — All remaining pages + dialogs

- [ ] Management pages: `agents`, `tools`, `skills`, `prompts`, `providers`,
      `subagents`, `laios`, `github` — grids → single column on mobile, tables →
      stacked cards or horizontal scroll with sticky first column.
- [ ] Migrate all **21 dialogs** to `ResponsiveDialog` (bottom sheet on mobile):
      `agent-form`, `prompt-form`, `provider-form`, `skill-form`, `tool-form`,
      `subagent-form`, `workspace-form`, `github-repo-picker`,
      `laios-connection`, `serve-model`, `instance-logs`, etc.
- [ ] Command palette (`components/command-palette/`) — full-screen on mobile.
- [ ] Model picker (`components/model-picker.tsx`) — already uses `useIsMobile`;
      verify.

### Phase 4 — QA pass

- [ ] Manual sweep at 360 / 390 / 430px portrait on every route (checklist
      below), plus one real iOS Safari + Android Chrome pass over the LAN URL.
- [ ] Automated smoke via the `webapp-testing` (Playwright) skill at a phone
      viewport: load each route, assert no horizontal overflow
      (`scrollWidth <= clientWidth`), screenshot for review.
- [ ] Verify keyboard-open behavior on the chat composer (no content hidden
      behind the on-screen keyboard).

## Per-page acceptance checklist

For each route, swept across a fluid width range (QA anchors 360 / 390 / 430px):

- No horizontal scroll (`document.scrollWidth <= innerWidth`) at any width.
- All text uses `text-foreground` / `text-muted-foreground` (dark+light OK).
- Primary actions reachable without pinch-zoom; tap targets ≥44px.
- Safe-area respected (nothing under the notch/home indicator).
- Any modal/sheet is scrollable and ≤ ~90dvh tall.

Routes: `/` (new-agent), `/customization`, `/settings`,
`/workspaces/:id/chat`, + the back-compat redirects, + all dialogs.

## Decisions (confirmed)

1. **Monaco on mobile** — **full editing**, not read-only. Keep Monaco lazy;
   enable touch-friendly editor options (`fontSize` bump, `minimap.enabled:
   false`, `wordWrap: "on"`, `lineNumbers` compact) on mobile so editing is
   actually workable on a phone.
2. **Mobile dock entry point** — **persistent bottom tab bar** inside workspace
   routes (e.g. Chat / Changes / Files / Terminal). Tapping a tab opens the
   corresponding dock surface as a bottom sheet / full-height overlay.
3. **Width** — **no hard pixel floor; fully fluid/responsive.** Layouts must
   flex down gracefully to any narrow width. Test anchors 360/390/430px are for
   QA only, not minimums — nothing should assume a fixed width. Prefer fluid
   units (`%`, `min()`, `clamp()`, `flex`) and avoid fixed `w-[…]`/`min-w-[…]`
   that can force horizontal scroll.

## Risks

- `react-resizable-panels` and xterm fit logic assume a stable desktop layout;
  swapping to a Sheet on mobile needs careful remount/refit handling.
- Monaco bundle + touch editing; keep it lazy, tune touch options, verify text
  selection / cursor placement are workable on a phone.
- The single `AppShell` drives every route — regressions there hit everything,
  so land Phase 0/1 behind careful desktop regression checks.

## Files likely touched (indicative)

- `index.html`, global CSS (Tailwind `@theme`/`@utility` for safe-area)
- `src/components/layout/app-shell.tsx`
- `src/components/shell/right-dock.tsx` (+ mobile host)
- `src/components/ui/dialog.tsx` / new `responsive-dialog.tsx`, `sheet.tsx`,
  `tabs.tsx`
- `src/hooks/use-mobile.ts` (maybe expose breakpoint constant)
- `src/pages/**` (chat, new-agent, settings, customization, all management pages
  + dialogs)
- `src/components/model-picker.tsx`, `command-palette/*`
