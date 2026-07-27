# PLAN: Skills UX — reassignable skills + an env manager injected at runtime

> Status: **IMPLEMENTED** (2026-07-27). All five phases landed; `uv run pytest`
> 222 passed, `bunx tsc --noEmit` and `bun run build` clean, `ruff` clean on the
> changed files. Verified against a copy of a populated dev DB (2 global skills
> backfilled to `managed` + `is_global`, four new tables created) and driven
> end-to-end in the running app on an isolated instance: created a secret var
> attached to a skill, moved that skill from global to two workspaces, saw it in
> both workspaces' in-scope listing, and confirmed a shell command there receives
> `$STRIPE_SECRET_KEY` while `echo` of it comes back `***REDACTED***` and the
> prompt names the key without its value. Open questions resolved in §11.
>
> Supersedes the scope model shipped in
> [PLAN-skills-scoping.md](./PLAN-skills-scoping.md) (implemented 2026-07-17) —
> that plan's two hard-coded scopes are replaced by explicit assignment, and
> skills gain environment variables.

## 0. Why

Three problems, all in the same area.

**1. A skill's scope is decided once, at creation, and can never change.**
Today a `Skill` row carries `scope: "global" | "workspace"` plus a single
`workspace_id` (`backend/app/db/models.py:121-176`), and the folder physically
lives in the matching root — `~/.lursor/skills/<slug>/` or
`<workspace>/.agents/skills/<slug>/` (`backend/app/skills/store.py:65-88`). The
frontend states the constraint out loud: *"Scope is immutable after creation"*
(`frontend/src/pages/skills/skill-form-dialog.tsx:71`). So a skill written for
one workspace can't be shared with a second one, can't be promoted to global,
and can't be parked (kept in the catalog but injected nowhere). The only way to
"reassign" is delete and recreate.

**2. There is no way to give a skill its credentials.** A skill folder can ship
`scripts/*.py` and the agent can run them (`run_skill_script`) or shell out to
whatever the SKILL.md describes — but nothing supplies `STRIPE_SECRET_KEY`,
`DATABASE_URL`, or a service token. Neither `create_deep_agent`, `LocalBackend`,
nor pydantic-deep's script executors accept an env mapping (checked against the
installed versions: `LocalBackend.execute` calls `subprocess.run(...)` with no
`env=`, so children inherit the *backend process's* `os.environ`;
`LocalSkillScriptExecutor.run` likewise). Lursor has no env store at all — the
only secrets it holds are the specific ones it needs itself (OpenRouter, Tavily,
Exa, GitHub, laios). A skill that needs a key today can only get it by the user
exporting it into the backend's own environment before launch, which is global,
invisible in the UI, and lost on restart.

**3. The skills page is a flat card grid with no notion of "where does this
apply".** `frontend/src/pages/skills/skills-page.tsx` has one scope dropdown that
doubles as a filter *and* as the target for new skills; the cards show name,
description, a content excerpt, and resource/script counts. There is no
assignment control, no "unassigned" state, and the bundled-file endpoints
(`GET/PUT/DELETE /skills/{id}/files/{path}`) have no UI at all.

## 1. Decisions (confirmed with user, 2026-07-27)

1. **Canonical store + assignment table.** Every UI-managed skill lives once, in
   `~/.lursor/skills/<slug>/`. A DB assignment says where it applies: global
   (every workspace), an explicit set of workspaces, or nowhere. Reassignment is
   a DB write — no file moves, no copies, multi-workspace is free.
2. **Skills committed into a repo keep working.** A folder found in
   `<workspace>/.agents/skills/<slug>/` is still auto-discovered, indexed as a
   **local** skill for that workspace, and wins a slug collision. Local skills
   are not reassignable in place; a **Move to catalog** action moves the folder
   into the canonical store and creates an assignment. No skill folder is ever
   moved out of a user's repo without that explicit action.
3. **Env vars are first-class rows, assignable to skills, workspaces, or
   global.** One `EnvVar` table; each var can attach to any mix of skills and
   workspaces, or be marked global. Skill attachment is the headline case.
4. **Precedence, lowest to highest: global → workspace → skill.**
5. **Values are stored plaintext in SQLite**, matching `GitHubConfig.token`
   (`models.py:412-428`) and `LaiosConnection.master_key` (`models.py:340-362`).
   The API is **write-only**: reads never return a secret's value, only
   `has_value`. Encryption/keychain is a documented follow-up, not this plan.
6. **Injection reaches the agent's shell and its skill scripts only** — the
   interactive terminal panel (`backend/app/api/terminal.py:69-79`) is
   deliberately left alone. Background processes the agent starts (dev servers
   via `run_in_background` → `execute_background`) do inherit the env, because
   they go through the same backend call; that is a consequence of (6), not a
   separate feature.

## 2. Data model

`backend/app/db/models.py`

### Skills

```python
class SkillOrigin(StrEnum):
    managed = "managed"   # canonical store, ~/.lursor/skills/<slug>/ — assignable
    local   = "local"     # discovered in <workspace>/.agents/skills/<slug>/


class Skill(TimestampMixin, table=True):
    slug: str
    name: str
    description: str
    content: str                        # cache; disk is authoritative
    origin: SkillOrigin = managed
    is_global: bool = False             # managed only: applies everywhere
    workspace_id: str | None = None     # local only: the owning workspace


class SkillWorkspaceLink(SQLModel, table=True):
    __tablename__ = "skill_workspaces"
    skill_id: str      = Field(foreign_key="skills.id", primary_key=True)
    workspace_id: str  = Field(foreign_key="workspaces.id", primary_key=True)
```

The three assignment states a managed skill can be in:

| State | Representation | Effect |
|---|---|---|
| Global | `is_global=True` | injected in every workspace |
| N workspaces | rows in `skill_workspaces` | injected in exactly those |
| Nothing | `is_global=False`, no links | in the catalog, injected nowhere |

`is_global` and workspace links are not mutually exclusive in the schema, but the
API normalizes: setting `is_global=True` clears the links (global already covers
everything), so the UI has one unambiguous state to render.

`SkillScope` (`models.py:121`) goes away as a concept. The physical `scope`
column stays in the table, dormant, so the lightweight migration doesn't have to
rewrite the table; §6 covers the backfill.

### Env vars

```python
class EnvVar(TimestampMixin, table=True):
    __tablename__ = "env_vars"
    key: str = Field(index=True)          # POSIX name: ^[A-Za-z_][A-Za-z0-9_]*$
    value: str = ""                       # never returned by the API
    description: str = ""
    is_secret: bool = True                # False → value readable in the UI
    is_global: bool = False               # applies to every run


class EnvVarWorkspaceLink(SQLModel, table=True):
    __tablename__ = "env_var_workspaces"
    env_var_id: str   = Field(foreign_key="env_vars.id", primary_key=True)
    workspace_id: str = Field(foreign_key="workspaces.id", primary_key=True)


class EnvVarSkillLink(SQLModel, table=True):
    __tablename__ = "env_var_skills"
    env_var_id: str = Field(foreign_key="env_vars.id", primary_key=True)
    skill_id: str   = Field(foreign_key="skills.id", primary_key=True)
```

`key` is **not** unique: the same name may legitimately hold different values at
different layers (a per-workspace `DATABASE_URL` alongside a global fallback).
Uniqueness is enforced per layer instead — one row per `key` among globals, one
per `(key, workspace)`, one per `(key, skill)` — so precedence is always
well-defined and the UI never has to guess. Env vars attach to a `Skill` **row**,
so a local skill can carry env too; if a local skill's folder disappears, its row
and links are dropped by reconcile as they are today.

## 3. Resolution — one function, two consumers

New module `backend/app/envvars/resolve.py`:

```python
@dataclass(frozen=True)
class ResolvedEnv:
    values: dict[str, str]           # what actually gets injected
    provenance: dict[str, str]       # key -> "global" | "workspace" | "skill:<slug>"
    conflicts: dict[str, list[str]]  # key -> every source that set it, when >1

async def resolve_env(
    session, *, workspace_id: str, skill_ids: Sequence[str]
) -> ResolvedEnv: ...

async def resolve_skill_env(
    session, *, workspace_id: str, skill_id: str
) -> ResolvedEnv: ...
```

- `resolve_env` builds the **union for a run**: globals, then this workspace's,
  then the vars of every skill in scope. Used for the agent's shell env.
- `resolve_skill_env` builds the env for **one** skill: globals + workspace +
  that skill's own vars. Used for `run_skill_script`, so a script never sees
  another skill's secrets.
- Same-layer collisions across two in-scope skills are resolved
  deterministically (skill slug ascending, last wins) and recorded in
  `conflicts` so the UI can warn. Sorting by slug rather than insertion order
  means the result doesn't depend on directory iteration order.

Skill scope for a run in workspace W, highest precedence first:

1. local skills in `W/.agents/skills/`
2. managed skills linked to W
3. managed skills with `is_global=True`

Collisions resolve by slug, closest layer winning — the same rule as today, just
with an extra layer in the middle. This lives in
`store.merged_skill_dirs` today (`backend/app/skills/store.py:127-142`), which
reads disk only. It now needs the DB, so it moves to
`backend/app/skills/resolve.py` as:

```python
async def skills_in_scope(session, workspace_path: str, workspace_id: str)
    -> list[ScopedSkill]        # (skill_id, slug, folder: Path, layer)
```

`ScopedSkill` carries the `skill_id` because that is what env links hang off —
directories alone are no longer enough.

## 4. Injection at runtime

Four touch points. All of them are additive; with no env vars defined, behaviour
is byte-identical to today.

### 4a. The agent's shell

`backend/app/agents/deduping_backend.py` — `DedupingLocalBackend` already exists
to patch two rough edges of the base `LocalBackend`; env is a third. Add:

```python
def set_env(self, env: Mapping[str, str]) -> None: ...   # workspace-level default
```

plus a `ContextVar[dict[str, str] | None]` run overlay, and overrides of
`execute` / `execute_background` that spawn with
`env={**os.environ, **(overlay or self._env)}`.

Two notes that matter for correctness:

- **The base class takes no `env=`**, so both methods must be reimplemented
  rather than delegated (~45 lines total, copied from
  `pydantic_ai_backends`: permission check via `_check_permission_sync`, default
  120 s timeout, `MAX_EXECUTE_OUTPUT` truncation, `_shell_cmd`,
  `start_new_session`, the `_bg` bookkeeping). That is a dependency-private
  surface, so `tests/test_deduping_backend.py` grows parity tests to catch a
  future upstream drift.
- **A ContextVar is the right run-scoping primitive here.** The backend is shared
  per workspace across runs (`builder.py:100-129`), so a plain attribute would
  leak one run's env into a concurrent run in the same workspace (they can differ
  — an agent with `include_skills=False` gets no skill env). `asyncio.to_thread`,
  which the async adapter uses to dispatch `execute`
  (`pydantic_ai_backends/adapter.py:82-115`), copies the current context into the
  worker thread, and tasks inherit context at creation, so a var set at the top
  of a run is visible to every tool call and every subagent of that run. The
  attribute set by `set_env` stays as the fallback for processes started outside
  a run (auto-started preview servers, `agents/preview_service.py`).

### 4b. Skill scripts, per skill

`create_deep_agent` currently receives plain directory strings
(`builder.py:653-655, 856`), and the library then constructs a default
`SkillsDirectory` per path with a default `LocalSkillScriptExecutor` — no env.
It does, however, pass a `SkillsDirectory` **instance** straight through
(`pydantic_deep/agent.py:1089-1099` forwards anything that isn't a `dict` or
`BackendSkillsDirectory`; `features/skills/toolset.py:263-276` accepts the
instance as-is). So `build_deep_agent` can hand over:

```python
SkillsDirectory(path=folder, script_executor=CallableSkillScriptExecutor(func=run_with_env))
```

New module `backend/app/skills/script_exec.py` holds `run_with_env`: it maps
`script.uri` → owning skill folder → `skill_id`, looks up that skill's
pre-resolved env (resolved once at build time, not per call), and runs
`python <uri>` with `cwd` = the script's parent and `env` merged — mirroring
`LocalSkillScriptExecutor.run`'s own argument-flag formatting and timeout
semantics so nothing else about script execution changes.

`skill_directories` is typed `list[str] | list[dict] | list[BackendSkillsDirectory]`
upstream, so this needs a `# type: ignore` with a comment naming the two source
lines that make it safe.

### 4c. Telling the agent what exists (names only)

`_environment_instructions` (`builder.py:132-161`) gains a section listing the
**keys** and their descriptions and provenance — never values:

```
# Environment
- Workspace: acme-api — …
- Working directory (your filesystem root): /Users/…/acme-api
- Environment variables available to your shell and skill scripts:
  - STRIPE_SECRET_KEY — Stripe live secret (from skill: stripe-refunds)
  - DATABASE_URL — Postgres connection string (workspace)
  Reference them as `$NAME` in commands. Their values are secret: never print,
  echo, or copy a value into a file, a message, or a commit.
```

Without this the agent has no reason to believe a key is present and will ask the
user for it — the listing is what makes the feature discoverable to the model.

### 4d. Secret hygiene: redact on the way out

Every injected value is scrubbed from `execute` / `execute_background` /
`read_background` output and from script output, replaced with
`***REDACTED***`, before it becomes tool output. The backend is the single choke
point, so this covers the transcript, the persisted messages, and the AG-UI
stream in one place. Values shorter than a threshold (say 8 chars) are skipped —
redacting a value like `dev` would mangle unrelated output for no security gain.

## 5. API surface

### Skills — `backend/app/api/skills.py`

- `GET /skills` — replace the `scope` / `workspace_id` filters with:
  `assignment=all|global|unassigned|workspace`, `workspace_id=<id>` (for
  `workspace`, returns everything in scope there: local + linked + global, each
  row tagged with its layer). `SkillRead` gains `origin`, `is_global`,
  `workspace_ids`, `layer`, and `env_var_ids`.
- `PUT /skills/{id}/assignment` — `{is_global: bool, workspace_ids: [str]}`.
  Managed skills only; 409 on a local skill with a message pointing at promote.
- `POST /skills/{id}/promote` — move a local folder into the canonical store,
  flip `origin` to managed, apply an assignment (defaults to the workspace it
  came from). The only operation that moves files out of a user's repo.
- `POST /skills` / `POST /skills/import` — default target is the canonical store
  with the requested assignment; `?workspace_id=` still writes into that repo's
  `.agents/skills` for the git-shareable case.
- `reconcile` reconciles the canonical root against managed rows, and each
  existing workspace's `.agents/skills` against its local rows (the shape it has
  today), and additionally drops `skill_workspaces` rows whose workspace is gone.

### Env vars — new `backend/app/api/env_vars.py`

- `GET /env-vars` — `EnvVarRead` with `has_value: bool`, `is_secret`,
  `is_global`, `workspace_ids`, `skill_ids`. `value` is returned **only** when
  `is_secret=False`.
- `POST /env-vars`, `PATCH /env-vars/{id}` — on PATCH, an omitted `value` keeps
  the stored one and `value: ""` clears it (same convention as the OpenRouter key
  in `api/settings.py:93-104`). Key validated against the POSIX name pattern and
  the per-layer uniqueness rule.
- `DELETE /env-vars/{id}`.
- `PUT /env-vars/{id}/assignment` — `{is_global, workspace_ids, skill_ids}`.
- `GET /env-vars/resolved?workspace_id=…` — the effective set for that workspace:
  keys, provenance, conflicts, `has_value`. No values. This backs the preview
  panel and is the debugging tool when a skill says "credentials missing".

Registered in `backend/app/main.py`'s router loop.

## 6. Migration

`backend/app/db/session.py:36-...` (`_apply_lightweight_migrations`) already does
idempotent `ADD COLUMN`s guarded by `PRAGMA table_info`; new tables come from
`create_all`. Steps:

1. `ALTER TABLE skills ADD COLUMN origin VARCHAR DEFAULT 'managed'`
2. `ALTER TABLE skills ADD COLUMN is_global BOOLEAN DEFAULT 0`
3. Backfill once, keyed off the dormant `scope` column:
   `scope='global'` → `origin='managed', is_global=1`;
   `scope='workspace'` → `origin='local'` (its `workspace_id` already points at
   the right workspace, and its folder is already in the repo — nothing moves).
4. Leave `scope` in place, unread, with a comment. Dropping it is a separate
   cleanup once nothing references it.

Net effect for an existing install: every global skill stays global; every
workspace skill keeps working exactly where it is, now labelled "in repo" with a
promote action. No data is discarded — unlike the previous plan's clean break.

## 7. Frontend

`frontend/src/api/types.ts`, `frontend/src/api/skills.ts`, new
`frontend/src/api/env-vars.ts`.

**Skills tab** (`src/pages/skills/skills-page.tsx`) — the card grid stays; the
scope dropdown splits into two independent controls, which is the core UX fix:

- a **filter** (All / Global / A workspace / Unassigned / In repo), and
- per-card **assignment**, an inline popover with a "Global (all workspaces)"
  toggle and a workspace multi-select (`src/components/multi-select.tsx` already
  exists). Cards show assignment as badges: `Global`, `3 workspaces`,
  `Unassigned`, `In repo · acme-api`.

Local ("in repo") cards show a **Move to catalog** action instead of the
assignment control, with a confirm that names the source and destination paths —
it moves files inside the user's repo, so it should never be a one-click
surprise.

**Skill dialog** (`skill-form-dialog.tsx`) — gains two sections: an **Assignment**
block (same control as the card, so a skill can be assigned at creation) and an
**Environment** block listing attached vars with an inline "attach existing / new
variable" picker. The bundled resources/scripts UI (endpoints exist, no UI) is
noted in §9 as a separate follow-up rather than smuggled in here.

**Environment tab** — new `src/pages/env/env-page.tsx`, added to
`customization-page.tsx`'s `TABS` (`:11`) next to Skills, since assignment is
the concept the two share. Table of `KEY`, description, assigned-to badges, and
value state (`Set` / `Not set`) with a Set/Replace action; secret values are
never fetched, so there is no reveal affordance to get wrong. A per-workspace
**Effective environment** panel renders `GET /env-vars/resolved`, marking
overridden keys and conflicts.

**Mentions** (`src/components/chat/mentions/sources.ts:26-40`) currently unions
two `useSkills` calls to build the `@skill` list. It switches to the single
in-scope listing (`assignment=workspace&workspace_id=…`), which is also what
fixes the current bug-in-waiting: an unassigned skill should not be mentionable.

`_referenced_skill_instructions` (`backend/app/api/chat.py:199-239`) resolves
`@`-referenced slugs against the two hard-coded roots; it moves to
`skills_in_scope` so precedence stays identical to the builder's, with the new
middle layer included.

## 8. Tests (`backend/tests/`)

- `test_env_resolution.py` — layer precedence, per-layer uniqueness, same-layer
  skill collision determinism, conflict reporting, `resolve_skill_env` isolation
  (skill A's script cannot see skill B's var).
- `test_env_injection.py` — a command run through the backend sees an injected
  var; a concurrent run in the same workspace with a different overlay does not
  see the other's; a background process inherits at spawn; redaction rewrites
  `echo $SECRET` output; a script run via the custom executor sees exactly its
  own layer set.
- `test_skill_assignment.py` — assignment CRUD, `is_global` normalization,
  `assignment=unassigned` filtering, 409 on assigning a local skill, promote
  moves the folder and creates the link, workspace deletion cleans up links.
- `test_skill_scope.py` — `skills_in_scope` ordering across all three layers,
  slug collision winners, `include_skills=False` suppresses skills *and* their
  env but keeps workspace/global env.
- `test_migration_backfill.py` — a DB with old `scope` rows backfills to the
  right `origin`/`is_global`, idempotent across two startups.
- `test_skill_reference.py` (existing) — updated for the new resolution path.

Plus `bun tsc` clean, and a manual end-to-end pass: assign one skill to two
workspaces, attach a var to it, confirm the agent can use `$KEY` in both and that
the value never appears in the transcript.

## 9. Phasing

Each phase is independently shippable and leaves the app working.

| Phase | Scope | Rough size |
|---|---|---|
| P1 | Skill assignment: model, migration, resolution, API. No UI yet — existing behaviour preserved by the backfill. | backend only |
| P2 | Skills UX: filter/assignment split, badges, promote, assignment in the dialog, mentions fix. | frontend |
| P3 | Env manager: model, API, Environment tab. Stored but not yet injected. | full stack |
| P4 | Injection: backend env + ContextVar, per-skill script executor, prompt listing, redaction. **The phase that makes it real.** | backend |
| P5 | Env attachment UI on skills + effective-environment panel. | frontend |

P1→P2 and P3→P4→P5 are the two dependency chains; P3 can start in parallel with
P2.

## 10. Out of scope

- **Terminal panel env** (`api/terminal.py`) — decided out. Worth revisiting once
  the resolution function exists, since it is then a two-line change.
- **Encryption / OS keychain** for values. Plaintext SQLite matches every other
  secret the app already stores; a keychain would break headless and packaged
  runs and complicate backup. Documented as a limitation in the Environment tab.
- **Lazy, per-skill shell injection** ("only inject once the agent loads the
  skill"). A shell command can't be attributed to a skill — the agent runs
  `curl`, not "skill X's curl" — so the honest split is: union-of-in-scope for
  the shell, exact-per-skill for `run_skill_script`. Narrowing the shell case
  would need a `load_skill` hook plus a mid-run env update, for a benefit that
  only materializes if the agent is untrusted, which it isn't here.
- **Symlinked or copied skill folders** per workspace — rejected in §1.
- **File-watch live reload** of skill folders (still deferred from the previous
  plan; reconcile-on-list plus the build-time scan already picks up edits on the
  next turn).
- **Resources/scripts editing UI.** The endpoints exist and are unused; a real
  file editor for skill folders is its own piece of work.

## 11. Open questions — resolved

1. **Default assignment for a newly created skill:** Global. `SkillCreate.is_global`
   is tri-state — unset means "global unless `workspace_ids` were given" — so the
   common case needs no extra field, and the create dialog exposes the toggle plus
   a workspace picker for one-click narrowing. When the page is filtered to a
   workspace, that workspace is pre-selected instead.
2. **`include_skills=False` suppresses only skill-attached vars.** The global and
   workspace layers survive: a workspace's `DATABASE_URL` isn't a skill.
   Implemented in `load_skill_runtime` (the caller resolves with
   `include_skills`), and pinned by
   `tests/test_env_runtime_wiring.py::test_skills_off_drops_skill_env_but_keeps_workspace_env`.
   A *subagent* with skills off still shares its parent run's shell environment —
   the env belongs to the run, and the parent could hand it over anyway.
3. **Redaction threshold: 8 characters** (`MIN_REDACT_LENGTH`), and only for vars
   marked secret. Below that, blanking every occurrence mangles unrelated output
   for no real gain.
4. **`.env` paste import: out.** Not needed to make the feature work, and easy to
   add later on top of the existing create endpoint.

### Two decisions made during implementation

- **`store.global_skills_root()` became `store.catalog_root()`.** With "global"
  now meaning an *assignment*, keeping it as a directory name would have made
  every call site ambiguous.
- **A skill folder found in the catalog with no DB row is indexed *unassigned*,
  not global.** A folder restored from a backup or dropped in by hand shows up in
  the UI waiting to be assigned rather than silently applying to every agent.
