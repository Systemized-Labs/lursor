# PLAN: The skills catalog as a workspace

> Status: **IMPLEMENTED** (2026-07-27). §8 records what was chosen.
>
> Scope: the minimal version. Register `~/.lursor/skills/` as a system
> `Workspace` so the existing chat + dock surface can be pointed at it, and add
> one entry point. No new agent, no changes to how the Skills manager works.
> Follow-ups are listed in §7 and deliberately not built here.

## 0. Why

Authoring a skill today is a form-shaped job in a dialog. `SkillEditorDialog`
(`frontend/src/pages/skills/skill-editor-dialog.tsx:51`) already mounts the real
editor — the same `EditorPane` + `useFileBuffers` the workspace file viewer uses,
so Monaco, tabs, dirty state and ⌘S work on a skill folder. What it cannot do is
everything around the editing:

- **No agent.** There is no way to say "write me a skill that does X" and have
  something draft `SKILL.md`, a `references/` doc and a `scripts/*.py` for it.
  Every character is typed by hand.
- **No terminal.** A skill's scripts are the part most likely to be wrong, and
  there is nowhere to run one.
- **No tree.** The dialog shows three hardcoded groups (Instructions /
  Resources / Scripts, `skill-editor-dialog.tsx:268`) for one skill at a time —
  you cannot see the catalog, or copy a pattern from the skill next door.
- **No history.** No diff, no undo beyond the editor's own buffer.

All four already exist, built and debugged, on the workspace surface — chat
(`frontend/src/pages/chat/workspace-chat-page.tsx`), and the right dock's Files /
Terminal / Changes / Preview panels (`frontend/src/components/shell/right-dock.tsx`).

The reason they are not available for skills is smaller than it looks. Every one
of those surfaces is parameterized by exactly one thing: a `Workspace` row, which
is nothing but a name, a description and a path (`backend/app/db/models.py:514`).
The agent's filesystem is a `LocalBackend` rooted at `workspace.path`
(`backend/app/agents/builder.py:5`); the dock keys its panels off `workspaceId`
(`frontend/src/components/layout/app-shell.tsx:59`); the file API, the watcher and
the terminal do the same.

The skills catalog is a directory (`settings.skills_dir`, `~/.lursor/skills/`,
`backend/app/config.py:61`). It is not a workspace only because nothing ever
inserted the row.

## 1. Decisions

1. **One system workspace, over the catalog root** — not one per skill. The
   agent should see the whole catalog: sibling skills are the best available
   examples of how to write a skill, and cross-referencing them is a feature.
2. **Detect, don't store.** No `kind` column and no migration. A workspace whose
   `path` is `settings.skills_dir` *is* the skills workspace; `WorkspaceRead`
   exposes that as a computed `is_system` boolean. If a user points a second
   workspace at that directory, treating it as the skills workspace is the
   correct behaviour, not a bug.
3. **Ensured at startup, adopted if already there.** The lifespan hook creates
   the row only when no workspace already points at that path, so re-running is
   idempotent and a hand-made one is adopted rather than duplicated.
4. **Guarded, not hidden.** It appears in the sidebar like any workspace (that
   is the point — conversations about skills nest under it and persist). Delete
   and path-change are refused by the API and not offered in the UI. Rename is
   allowed; it changes a label, not a location.
5. **The manager stays the manager.** Assignment, env vars, import, promote and
   delete stay on the Skills tab. The workspace is where files get written; the
   manager is where reach gets decided. No changes to that page beyond the one
   button that opens the workspace.

## 2. What comes free

Nothing below needs code — it is what pointing the existing surface at that
directory already does:

- **Chat with a real agent** rooted in the catalog: read, write, glob, grep,
  execute, subagents, `@file` mentions, slash commands, attachments.
- **Conversations that persist** per workspace, nested in the sidebar, resumable.
- **The file tree over every skill**, with the live watcher — files the agent
  writes appear as it writes them (`frontend/src/components/files/file-viewer.tsx:26`).
- **A terminal rooted at the catalog**, for running a skill's scripts.
- **Dock layout persistence** keyed by workspace id (`useDockState`).
- **Agent-authored skills showing up in the manager, unassigned.** `GET /skills`
  calls `reconcile()` on every request (`backend/app/api/skills.py:338`), and a
  folder that appears out of band is indexed with no assignment
  (`skills.py:214-228`). So: agent writes `~/.lursor/skills/foo/SKILL.md` → the
  Skills tab shows "foo" under **Not assigned** on next load → the user assigns
  it. That handoff is already correct, by accident of a good earlier decision.

## 3. Backend changes

### 3a. `backend/app/api/workspaces.py`

```python
SKILLS_WORKSPACE_NAME = "Skills"

def is_system_workspace(ws: Workspace) -> bool:
    """True for the skills catalog workspace (path == settings.skills_dir)."""
    return Path(ws.path).resolve() == settings.skills_dir.resolve()

async def ensure_skills_workspace(session: AsyncSession) -> Workspace:
    """Register the skills catalog as a workspace, once. Idempotent; adopts an
    existing row pointing at the same directory rather than adding a second."""
```

- `list_workspaces` / `get_workspace` unchanged; `WorkspaceRead.from_workspace`
  gains the computed flag.
- `delete_workspace` (`workspaces.py:171`) → `400` when `is_system_workspace`,
  message along the lines of *"The Skills workspace can't be deleted — it's your
  skills catalog. Delete individual skills from Customization → Skills."*
- `update_workspace` (`workspaces.py:148`) → `400` when the payload sets `path`
  on a system workspace. Name and description still update.

### 3b. `backend/app/schemas/workspace.py`

Add `is_system: bool` to `WorkspaceRead`, computed in `from_workspace`. No new
column, no `_apply_lightweight_migrations` entry.

### 3c. `backend/app/main.py`

In `lifespan`, inside the existing session block, **before** `skills.reconcile`:

```python
await ensure_skills_workspace(session)
await skills.reconcile(session)
```

Order matters only cosmetically — `reconcile` iterates workspaces to index their
`.agents/skills` roots, and running after the insert means the new workspace is
covered on the first pass rather than the second.

`settings.ensure_dirs()` already creates `skills_dir` (`config.py:165`), so the
directory is guaranteed to exist before the row is written.

## 4. Frontend changes

| File | Change |
| --- | --- |
| `frontend/src/api/types.ts:296` | `is_system: boolean` on `Workspace`. |
| `frontend/src/components/layout/app-sidebar.tsx:529` | Sort the system workspace last in the list, give it a distinct icon, and omit **Delete** (and **Clone**) from its row menu. |
| `frontend/src/pages/skills/skills-page.tsx:356` | An **Open workspace** button in the `action` group — renders in both embedded and standalone modes. Finds the workspace via the existing `useWorkspaces()` call already on the page and navigates to `/workspaces/<id>/chat`. |

Bulk-select delete in the sidebar goes through the same `DELETE` endpoint, so the
backend guard covers it; the frontend just surfaces the error toast. Excluding
the row from range-selection is a nicety, not a requirement.

## 5. Things to know, and their answers

- **Changes panel on a non-repo.** The catalog is not a git repo, and
  `backend/app/api/git.py:266` already returns `is_repo=False` for that — the
  panel renders its empty state. No crash, no fix needed. Making the catalog a
  git repo would light the panel up (diff, history, undo for skills) and is
  attractive, but it is a separate decision — §7.
- **Global skills load inside the skills workspace.** A skill assigned
  everywhere is in scope for a run there too (`app/skills/resolve.py:57`). That
  is harmless and arguably useful; worth naming so it is a choice, not a
  surprise.
- **`<catalog>/.agents/skills/` is a valid local-skill root** for this workspace,
  as it is for any other. It will be empty and nothing creates it. Skills written
  to the catalog root are managed skills; skills written into that subfolder
  would be local to the skills workspace, which is meaningless but harmless.
- **Repo-local skills are untouched.** A skill under a repo's
  `.agents/skills/<slug>/` is already editable from that repo's own workspace
  chat — the same surface, arrived at from the other direction.
- **Deleting the row anyway** (via a direct API call, past the guard) loses no
  files: `delete_workspace` deliberately leaves the directory
  (`workspaces.py:176`), and the next startup re-creates the row.

## 6. Tests — `backend/tests/test_skills_workspace.py`

1. `ensure_skills_workspace` creates exactly one row whose path is
   `settings.skills_dir`; calling it twice adds nothing.
2. It adopts a pre-existing workspace already pointing at that path instead of
   creating a second.
3. `DELETE /workspaces/{id}` on it → 400; the row survives.
4. `PATCH` with a new `path` → 400; `PATCH` with a new `name` → 200.
5. `WorkspaceRead.is_system` is true for that row and false for an ordinary one.
6. End-to-end of the handoff: write a skill folder into the catalog directly,
   then `GET /skills` lists it as `managed`, `is_global=False`, no workspace
   links — the "Not assigned" bucket. (Guards the behaviour §2 depends on.)

Plus `bunx tsc --noEmit` and `bun run build` for the frontend.

## 7. Follow-ups

**Built in the access-UX pass** (the entry points, once the workspace existed):

- **Per-skill deep link** — *Open in Skill Studio* on the row menu and in the
  editor dialog, resolving through `frontend/src/lib/skill-location.ts` and the
  `requestOpenFile` bus.
- **Repo-local skill shortcut** — the same action on a local skill opens
  `<repo>/.agents/skills/<slug>/SKILL.md` in the repo that owns it. It fell out
  of the deep link for free; both path conventions are pinned by
  `test_deep_link_path_resolves`.
- **Intent on arrival** — `?draft=` seeds the composer, the Files panel opens on
  first visit, and the studio gets its own chat empty state (which is also where
  "new skills arrive unassigned" is said out loud).
- **Palette** — a Skills filter with every skill deep-linked, plus a Skill Studio
  action.

Still out of scope, and none of it needed:

- **A seeded "Skill Smith" agent** with skill-authoring instructions, defaulted
  in that workspace. Without it, the studio uses whatever agent is selected —
  which works, just with less domain knowledge.
- **`git init` on the catalog**, turning the Changes panel into skill history.
- **A test loop** — "Try this skill" opening a scratch thread with only that
  skill in scope. Probably the highest-value follow-up once authoring is easy:
  writing a skill is not the hard part, knowing whether it fires is.

### A bug this uncovered

The deep link exposed a pre-existing race in `app-shell`: both "open this file"
and "open this preview" tested `dock.tabs` from the render's closure, which on
the render where the workspace changes still holds the *previous* workspace's
tabs. Arriving from a non-workspace route (the manager, the palette) therefore
added a *second* file tab — and since `consumePendingFile` clears the request
globally, the already-mounted viewer ate it and the tab the user was looking at
rendered "No file open". Fixed with `useDockState.ensureTab(kind)`, which
decides inside the updater against current state.

## 8. Open questions — as resolved

1. **Sidebar placement** — its own top-level entry in the **Platform** group,
   below Customization and above the Workspaces label. Not a project, so it does
   not belong in the project list. It is still rendered as a `WorkspaceRow`
   there, so conversations about skills nest under it and stay resumable, with
   three adjustments. Clicking navigates (a nav item should) unless you are
   already inside it, where it is just the folder toggle — navigating again
   would drop the `?c=` and reset the open conversation. *Entering* the studio
   expands it, by whatever route (its row, the manager's button, a deep link,
   the palette), so you never land inside a workspace whose row looks shut; this
   fires on the transition only, so collapsing it by hand while you're there
   sticks. And the Platform group's content is capped and scrolls, so a busy
   studio can't push the workspace list out of the viewport. It is also
   non-selectable, keeping it out of range selection and bulk delete.
2. **Icon** — `Sparkle`, the glyph skills already carry in the `@`-mention menu
   (`frontend/src/components/chat/mentions/sources.ts:92`). It does not swap on
   open/close the way the folder glyph does: the catalog reads as a destination,
   not a folder you filed things into.
3. **A second entry point in the sidebar** — no. The row is already there and
   the Skills tab has the button; a third affordance for one directory is noise.

One deviation from §3a: `PATCH` refuses a path that *differs* from the current
one rather than any path at all, and refuses it before `_materialize` runs. The
edit dialog echoes the current path back on every save
(`workspace-form-dialog.tsx:96`), so a blanket refusal would have blocked
renaming through that dialog, and checking after materializing would have left
an empty directory behind on a rejected move.

The predicate itself lives in `backend/app/workspace_paths.py` as
`is_skills_catalog(path)`, not in `api/workspaces.py` — `schemas/workspace.py`
needs it for the computed flag and cannot import the API module without a cycle.
`api/workspaces.is_system_workspace(ws)` is the thin model-level wrapper the
guards read against.
