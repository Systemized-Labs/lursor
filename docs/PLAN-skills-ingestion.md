# PLAN: Ingesting skills that already exist on disk

> Status: **IMPLEMENTED** (2026-07-27). `uv run pytest` 251 passed (19 new in
> `tests/test_skills_ingestion.py`), `bunx tsc --noEmit` and `bun run build`
> clean, `ruff` clean on the changed files. §8 records what was chosen; §9 what
> the implementation added beyond the plan.
>
> Follows `PLAN-skills-workspace.md`, which registered the catalog as a
> workspace. This one is about the skills Lursor currently cannot see at all.
>
> Scope: make the `local` layer multi-root so `.claude/skills` and
> `.cursor/skills` in a repo are read in place, and add a `user` layer for
> `~/.claude/skills` and `~/.cursor/skills`. Read-only discovery plus an explicit
> copy into the catalog. No new UI surface — the Skills manager grows a badge and
> a bucket.

## 0. Why

Skills are an ecosystem format now, not a Lursor format. A repo cloned today
plausibly carries `.claude/skills/<slug>/SKILL.md`; a developer's home directory
almost certainly carries `~/.claude/skills/`. Lursor sees none of it.

The reason is one constant:

```python
# backend/app/skills/store.py:52
WORKSPACE_SKILLS_SUBDIR = Path(".agents") / "skills"
```

Everything else in the `local` layer is already the right machinery.
`resolve.py:88-91` gives repo-committed skills a layer that outranks assigned and
global ones, carries no assignment to configure, and travels with the directory.
`store.read_skill` parses a `.claude/skills` folder today without a line of
change — it is the same standard: `SKILL.md` with YAML frontmatter, optional
resources, optional `scripts/`. `find_skill_folders` already handles nesting.

So this is not a new ingestion pipeline. It is teaching one hardcoded directory
name to be a list, and being careful about the two places that assumption is
load-bearing.

## 1. Decisions

1. **Multi-root, not import-on-detect.** Skills committed to a repo are
   versioned *with* the repo; that is the entire point of committing them. A
   copy-on-open flow is less code (`store.import_folder` already exists) but the
   copy is stale the moment someone pulls. Read in place.
2. **Roots are configuration.** `.cursor/skills` is a young convention and there
   will be a fourth name. `settings.local_skill_roots` and
   `settings.user_skill_roots` cost nothing now and mean the next one is a config
   line, not a release.
3. **Foreign roots are discover-only.** Lursor indexes what is there and never
   creates a directory, never writes a folder that isn't there. See §3f — this is
   the sharp edge, not an aesthetic preference.
4. **User-level roots are a fourth layer, not a fourth local root.**
   `~/.claude/skills` has no owning workspace, so `origin=local` doesn't describe
   it; it isn't in `~/.lursor/skills` either, so `managed` doesn't. New
   `SkillOrigin.external`, new bottom layer `user`.
5. **Auto-enabled.** A discovered skill is in scope for runs in that workspace
   immediately, exactly as `.agents/skills` is today. A per-skill or
   per-workspace enable gate would be safer (§5) but would break the "local
   skills have no assignment" invariant that makes the layer simple. Named here
   so it is a choice.
6. **Copy to catalog, not move, for roots we don't own.** `promote`
   (`api/skills.py:477`) moves the folder. Moving one out of `.claude/skills`
   mutates a git-tracked tree behind the user's back; moving one out of
   `~/.claude/skills` deletes a skill from under Claude Code. Move stays for
   `.agents/skills`; everything else gets copy.
7. **The catalog stays the only write target for creation.** `POST /skills` with
   `origin=local` still writes to `.agents/skills`. Discovery is read; authoring
   has one destination per origin.

## 2. The root model

| Root | Origin | Layer | Discovered | Writable | Created by us |
| --- | --- | --- | --- | --- | --- |
| `~/.lursor/skills/` | `managed` | `global` / `workspace` | yes | yes | yes |
| `<ws>/.agents/skills/` | `local` | `local` | yes | yes | yes |
| `<ws>/.claude/skills/` | `local` | `local` | yes | yes | **no** |
| `<ws>/.cursor/skills/` | `local` | `local` | yes | yes | **no** |
| `~/.claude/skills/` | `external` | `user` | yes | yes | **no** |
| `~/.cursor/skills/` | `external` | `user` | yes | yes | **no** |

"Writable" means an edit through Lursor changes that file. "Created by us" is the
distinction that matters for reconcile: only the first two may be brought into
existence, or have a missing folder rebuilt from the DB cache.

Precedence within `local` is the order of `settings.local_skill_roots`, ours
first. Collisions there are rare and the rule is arbitrary but fixed.

## 3. Backend changes

### 3a. `backend/app/config.py`

Next to `skills_dir` (`config.py:61`):

```python
# Workspace-relative directories scanned for repo-committed skills, in
# precedence order (later roots lose a slug collision). The first is Lursor's
# own convention and the only one it will create; the rest are read in place
# because other tools own them.
local_skill_roots: list[str] = [".agents/skills", ".claude/skills", ".cursor/skills"]

# Absolute (``~``-expanded) directories of personal skills owned by other
# tools. In scope for every workspace, at the lowest precedence.
user_skill_roots: list[str] = ["~/.claude/skills", "~/.cursor/skills"]
```

`ensure_dirs` (`config.py:165`) is **not** extended — none of these are ours to
create.

### 3b. `backend/app/skills/store.py`

`WORKSPACE_SKILLS_SUBDIR` stays as `DEFAULT_LOCAL_SKILL_ROOT` (the write target),
and gains readers:

```python
def local_skill_roots(workspace_path: str | Path) -> list[tuple[str, Path]]:
    """``(key, absolute path)`` for every configured local root that exists.

    ``key`` is the workspace-relative subdir as configured (``".claude/skills"``)
    and is what a ``Skill`` row stores, so the row survives the workspace moving.
    Non-existent roots are omitted: absence is the normal case.
    """

def user_skill_roots() -> list[tuple[str, Path]]:
    """``(key, path)`` for every configured personal root that exists.

    ``key`` is the expanded absolute path — these are not relative to anything.
    """

def is_owned_root(key: str) -> bool:
    """True when Lursor may create this root or rebuild a folder inside it."""
    return key == str(DEFAULT_LOCAL_SKILL_ROOT)
```

`path_for`, `read_skill`, `list_slugs`, `write_file` and friends already take an
explicit `root` and need no change — that parameterization is what makes this
cheap.

**One fix required here.** `write_skill` (`store.py:213`) rebuilds frontmatter
from `{name, description}` only, so any other key is dropped. A Claude Code
skill routinely carries `allowed-tools`, `license` or `version`, and today
`PATCH /skills/{id}` (`api/skills.py:690`) would silently delete them from a file
in someone's repo. `import_markdown` (`store.py:354`) already acknowledges extra
keys exist and preserves them verbatim, so this is a pre-existing gap that
foreign roots turn into data loss on files we don't own. `write_skill` must read
the existing frontmatter and merge, not replace.

### 3c. `backend/app/db/models.py`

`SkillOrigin` gains:

```python
external = "external"
"""Discovered in a personal skills directory owned by another tool
(``~/.claude/skills``). Read in place, in scope everywhere at the lowest
precedence, carries no assignment. ``POST /skills/{id}/copy`` duplicates it into
the catalog; nothing here ever moves or rewrites it implicitly."""
```

`Skill` gains one column:

```python
# Which root the folder lives in. Workspace-relative subdir for ``local``
# (".claude/skills"), absolute path for ``external``, empty for ``managed``
# (the catalog is the only managed root). Identity is
# (origin, workspace_id, root, slug).
root: str = Field(default="", index=True)
```

Storing it rather than probing matters: with three candidate roots per workspace
the same slug can exist twice, and a probe-in-order scheme would resolve an edit
or a delete to the wrong file.

### 3d. `backend/app/db/session.py`

One idempotent block in `_apply_lightweight_migrations` (`session.py:36`),
matching the existing pattern:

```python
skill_cols = await columns("skills")
if "root" not in skill_cols:
    await conn.execute(text("ALTER TABLE skills ADD COLUMN root VARCHAR DEFAULT ''"))
    # Every pre-existing local row came from the one root there was.
    await conn.execute(
        text("UPDATE skills SET root = '.agents/skills' WHERE origin = 'local'")
    )
```

### 3e. `backend/app/skills/resolve.py`

```python
LAYERS = ("user", "global", "workspace", "local")
```

`user` sits at the bottom: your Lursor catalog is a deliberate choice, a
directory another tool happens to populate is not, so the catalog wins a slug
collision. The loop gains a branch selecting `origin == external` rows with
`root = store` path from the row, and the `local` branch resolves
`Path(workspace_path) / row.root` instead of the fixed subdir. A row whose root
no longer exists falls through the existing `store.exists` check and is skipped —
unplugging a directory degrades to "those skills are gone", not an error.

`skills_in_scope` keeps its signature. `skill_runtime.py:70` and
`env_vars.py:285` are unchanged; external skills get real ids, so env vars attach
to them like any other.

### 3f. `backend/app/api/skills.py`

**Root resolution.** `_root_for` / `_root_for_row` (`skills.py:70`, `skills.py:85`)
currently derive a root from `origin` alone. Both become one helper that reads
`row.root`, returning `None` when the root is gone.

**Reconcile is where the danger is.** `_reconcile_root` (`skills.py:168`) writes
to disk: lines 189-197 materialize a folder from the DB cache whenever a row's
folder is missing. Pointed at a foreign root that behaviour would create
`.claude/` directories in repos that never had one, and resurrect skills the user
deleted in Cursor. It gains a flag:

```python
def _reconcile_root(session, root, rows, *, origin, workspace_id, root_key, materialize):
```

With `materialize=False`, a row whose folder has vanished is **deleted** rather
than rebuilt — for a root we don't own, disk is not merely authoritative for
content, it is authoritative for existence.

`reconcile` (`skills.py:240`) then loops `store.local_skill_roots(ws.path)` per
workspace instead of the single root, plus one pass per `store.user_skill_roots()`
entry with `origin=external, workspace_id=None`. External rows are cleaned up
when their root disappears from config or from disk.

**Guards, all returning 409 with a message naming the real path:**

- `PUT /{id}/assignment` (`skills.py:445`) already rejects `local`; extend to
  `external`.
- `POST /{id}/promote` (`skills.py:477`) rejects any root where
  `is_owned_root` is false, pointing at `/copy`.
- `DELETE /{id}` (`skills.py:710`) is *allowed* on foreign roots — it deletes the
  real folder, which is what deleting a local skill has always meant — but the
  frontend confirm must show the absolute path (§4).

**New endpoint**, `POST /skills/{id}/copy`, taking the same `SkillPromote` body:
copies the folder into the catalog under a de-duplicated slug, leaves the source
untouched, and applies the requested assignment (defaulting to the originating
workspace for a `local` source, global for an `external` one). Essentially
`promote` with `shutil.copytree` instead of `move_skill` and no mutation of the
source row.

**Listing.** `list_skills`'s `assignment` pattern (`skills.py:326`) gains `user`,
and the `local` filter is unchanged (it already keys off origin, not root).

### 3g. `backend/app/schemas/skill.py`

`SkillRead` gains `root: str` and `root_label: str` — the latter a display form
(`.claude`, `.cursor`, `.agents`, `~/.claude`) computed server-side so the
frontend doesn't parse paths. `layer`'s docstring gains `"user"`.

## 4. Frontend changes

| File | Change |
| --- | --- |
| `frontend/src/api/types.ts` | `root`, `root_label` on `Skill`; `"external"` on the origin union; `"user"` on the layer union. |
| `frontend/src/pages/skills/skills-page.tsx:58` | A fifth group, **From other tools** (`origin === "external"`), hinted as read-in-place and applying everywhere. The `local` group's hint stops saying `.agents/skills` specifically. |
| `frontend/src/pages/skills/skills-page.tsx:119` | `root_label` as a `Chip` on any row whose root isn't the catalog — the one piece of information that makes two same-named skills distinguishable. |
| `frontend/src/pages/skills/skills-page.tsx:202` | "Move to catalog" only when `is_owned_root`; otherwise "Copy to catalog" hitting the new endpoint. |
| Delete confirm | Show the absolute path for foreign and user roots. Deleting `~/.claude/skills/pdf` from Lursor removes it from Claude Code, and that should be legible before the click, not after. |
| `frontend/src/lib/skill-location.ts:38` | Uses `skill.root` instead of the hardcoded `.agents/skills/`. External skills have no workspace and return `null` — the editor dialog still opens them. |

## 5. Things to know, and their answers

- **This widens the prompt-injection surface, and that is the real cost.** Every
  in-scope `SKILL.md` description goes into the agent's context, so cloning a
  repo now means loading skill instructions written by whoever wrote that repo.
  Technically true of `.agents/skills` today — but that directory is nearly
  always empty, and `.claude/skills` in a cloned repo will not be. Decision 5
  accepts this; the mitigation if it bites is a per-workspace enable gate, which
  is a small change on top of this design (the rows already exist and are already
  distinguishable by root) and deliberately not built now.
- **A repo can define a skill that shadows a catalog one.** Already the collision
  rule (`resolve.py:82-113`), unchanged: closest layer wins. The new `root_label`
  chip is what makes it visible when it happens.
- **Junk in `.claude/` is ignored.** `list_slugs` requires a `SKILL.md` directly
  under `<root>/<slug>/`, so `.claude/settings.json`, `.claude/commands/` and
  anything else in there is invisible. `.claude/plugins/*/skills/` is not scanned;
  a user who wants it adds the path to `local_skill_roots`.
- **Reconcile runs on every `GET /skills`** (`skills.py:338`). This takes it from
  1 + N directory scans to up to 3N + 2. Each is an `iterdir` over a directory
  with a handful of entries, and non-existent roots cost one `is_dir`. Not worth
  optimizing; worth knowing before someone blames it for a slow Skills tab.
- **Moving a workspace doesn't orphan its skills** — `root` is stored relative
  for `local` rows. Moving `~/.claude` would orphan external rows, and reconcile
  drops them, which is correct.
- **Symlinked roots** resolve through the existing escape checks in
  `_discover_resources` / `_resource_path`; a symlink pointing outside the skill
  folder is already excluded from listings.

## 6. Tests — `backend/tests/test_skills_ingestion.py`

1. A workspace with `.claude/skills/foo/SKILL.md` → `GET /skills` lists `foo` as
   `origin=local`, `root=".claude/skills"`, in the `local` layer for that
   workspace.
2. All three local roots populated with distinct slugs → all three in scope;
   `skill_dirs` contains three folders.
3. Same slug in `.agents/skills` and `.claude/skills` → the `.agents` one wins,
   one entry in scope, and an edit writes to the `.agents` copy.
4. **The materialize guard**: a `local` row whose `.claude/skills` folder is
   deleted on disk → reconcile drops the row and does **not** recreate the
   folder. Same for a workspace with no `.claude/` at all: reconcile creates
   nothing. This is the regression test that matters most.
5. `~/.claude/skills/bar` (via a patched `user_skill_roots`) → indexed as
   `external`, in scope for *every* workspace, at layer `user`.
6. An `external` slug that collides with a global managed one → the managed one
   wins.
7. `PUT /{id}/assignment` and `POST /{id}/promote` on an external skill → 409.
8. `POST /{id}/copy` on a `.claude/skills` skill → a new managed row in the
   catalog, source folder still present on disk, source row still `local`.
9. `DELETE` on an external skill removes the real folder.
10. Frontmatter preservation: a `SKILL.md` carrying `allowed-tools` survives a
    `PATCH` that changes only the description.
11. Migration: a DB with pre-existing `local` rows and no `root` column gets
    `.agents/skills` backfilled and resolves unchanged.

Plus `bunx tsc --noEmit` and `bun run build`.

## 7. Follow-ups

- ~~**Per-workspace enable gate** for foreign-root skills, if decision 5 proves
  wrong in practice.~~ **Done, as a global gate instead** — `Skill.enabled`,
  mirroring `Subagent.enabled`, toggled from a switch on each row of the Skills
  page. Decision 5 stands (a discovered skill is in scope the moment it is
  found), but it is now revocable without deleting a folder out of a repo or out
  of Claude Code, which was the only previous way to stop one loading.

  Global rather than per-workspace because the Skills page has no workspace
  context, and because the axis a managed skill was missing is *whether*, not
  *where* — assignment already answers where. Checked in exactly one place,
  `resolve.candidates`, so env vars, `@`-mentions and the agent's own skill
  directories cannot disagree about what is loaded. Two properties are pinned in
  `tests/test_skill_enable.py`: toggling never rewrites `SKILL.md` (verified
  byte- and mtime-identical against a real repo, `git status` clean), and a
  disabled row does not *shadow* — switching off a repo's `pdf` reveals the
  catalog's `pdf` rather than leaving a hole.

  The per-workspace variant is still open if turning one `~/.claude` skill off in
  a single repo turns out to matter.
- **`.cursor/rules` and `AGENTS.md`** are the other two things sitting in these
  repos unread. Different format, different layer, not skills — but the same gap,
  and worth naming as the next one.
- **A "found N skills in this repo" nudge** on first open of a workspace with a
  populated foreign root. Discovery is silent otherwise, and silence is fine for
  a personal directory but under-informs for a repo you just cloned.
- **Watching the roots.** Discovery happens on `GET /skills`; a skill added by a
  `git pull` mid-session appears on the next Skills tab load, not immediately.
  The file watcher already exists per workspace and could drive it.

## 8. Open questions — resolved

1. **`root_label` for `.agents/skills`** — unbadged, as leaned. `SkillRead`
   carries `root_label` for every non-catalog root, and the row renders the chip
   only when `is_owned_root` is false, so exactly the foreign roots draw the eye.
   `is_owned_root` was added to `SkillRead` for this and for §4's copy-vs-move
   split; the frontend never has to know which root names are ours.
2. **Should `external` skills be listed per-workspace at all** — yes, unchanged
   from the plan. They *are* in scope there, and the `~/.claude` chip plus the
   "From other tools" bucket make it legible. Revisit with the enable gate if the
   noise is real.
3. **Precedence of `user` versus `global`** — as planned: catalog above
   `~/.claude/skills`, pinned by `test_catalog_beats_a_personal_root`.

## 9. What the implementation added

Three things the plan didn't call for, each forced by the code:

- **`Skill.root` needs a `server_default`.** `create_all` emits it `NOT NULL`
  with no default, so any insert outside the ORM fails. The migration test does
  exactly that, and so would a hand-written recovery query.
- **`path_for` no longer resolves the skill folder.** It resolved the folder and
  compared the *parent* to the root, which rejects a symlinked skill folder —
  common in a hand-maintained `~/.claude/skills`, and it would have taken out the
  whole root with a 500 on `GET /skills`, not just that skill. The traversal
  guard is now explicit (no separators, no `..`, parent must be the root) and
  files *inside* the folder are still checked against the resolved folder.
  `delete_skill` unlinks a symlinked folder instead of `rmtree`-ing it.
- **Tests pin `USER_SKILL_ROOTS=[]` in `conftest`.** Left at its default, the
  suite indexes whatever is in the developer's own `~/.claude/skills` and scope
  assertions start depending on whose machine ran them. It failed exactly that
  way on the first run.

Two smaller notes: `reconcile` heals a row whose `root` doesn't match the root it
was found in (so pre-migration rows normalize on first listing), and
`.agents/skills` is always scanned even if removed from `local_skill_roots`,
because it stays the write target for `POST /skills`.

**A fourth default root, `skills`.** The first real workspace tried against this
kept its seven skills in a plain top-level `skills/` — no dotfolder at all, which
none of the three planned roots match. Decision 2 anticipated exactly this ("there
will be a fourth name"), and it cost one config line. It is safe as a *default*
because a folder is only a skill if it holds a `SKILL.md`: that workspace's
`skills/_shared/` and `skills/add-endpoint.md` are both correctly invisible.

It does make one collision newly plausible, so `local_skill_roots` now skips a
root that resolves to the catalog. A workspace registered at `~/.lursor` — or the
Skill Studio's own parent — would otherwise match the bare `skills` entry and
index every managed skill a second time as a `local` one, which then shadows the
managed row it came from.
