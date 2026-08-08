# Skills, and environment variables

Indexed from [`AGENTS.md`](../../AGENTS.md) §6.

## Skills — four layers

`app/skills/resolve.py` owns scope; `app/skills/store.py` owns locations.
Lowest precedence first:

1. **user** — personal roots owned by other tools (`settings.user_skill_roots`)
2. **global** — managed skills with `is_global`
3. **workspace** — managed skills linked to this workspace
4. **local** — folders in one of the workspace's own roots
   (`settings.local_skill_roots`: `.agents/skills`, `.claude/skills`,
   `.cursor/skills`, `skills`) — committed into the repo

Closest layer wins a slug collision; your catalog beats a directory another tool
happens to populate. Roots are **configuration**, because there will be a fifth
convention.

Rules that are load-bearing:

- A managed skill lives **once**, in `~/.lursor/skills/<slug>/`. Reach is a DB
  assignment (`is_global` + `SkillWorkspaceLink`), not a location — so
  reassignment is a DB write and multi-workspace is free. Three states: global /
  N workspaces / **parked** (in the catalog, injected nowhere).
- **Foreign roots are discover-only.** `_reconcile_root(materialize=False)` means
  a row whose folder has vanished is *deleted*, never rebuilt. Pointed at a
  foreign root, the materialize path would create `.claude/` directories in repos
  that never had one and resurrect skills the user deleted in Cursor. This is the
  most important regression test in the skills suite.
- `move` (promote) is only for roots we own; everything else gets **copy**. A
  catalog entry may be a **symlink** into another tool's directory
  (`Skill.link_target`) — `delete` unlinks the link and leaves the target alone.
- `Skill.root` is **stored**, not probed: with several candidate roots per
  workspace the same slug can exist twice, and probing in order resolves an edit
  or a delete to the wrong file.
- `write_skill` **merges** frontmatter rather than replacing it — a Claude Code
  skill routinely carries `allowed-tools`/`license`/`version` and a `PATCH`
  would otherwise delete them from a file in someone's repo.
- `Skill.enabled` is checked in exactly one place (`resolve.candidates`) so env
  vars, `@`-mentions and the agent's own skill directories cannot disagree. A
  disabled row does not *shadow*: switching off a repo's `pdf` reveals the
  catalog's `pdf`.
- `reconcile()` runs on every `GET /skills`. That is up to 3N+2 directory scans;
  known and accepted, worth knowing before blaming it for a slow Skills tab.
- Widening discovery widened the **prompt-injection surface** — cloning a repo
  now loads skill instructions written by whoever wrote that repo. Accepted
  deliberately; `enabled` is the revocation path.
- `tests/conftest.py` pins `USER_SKILL_ROOTS=[]`, or the suite indexes whatever
  is in the developer's own `~/.claude/skills`.

## Bundled skills

**Bundled skills** are the fifth source, and the only one Lursor itself authors:
folders under `backend/app/skills/bundled/` (they ride in the wheel, so they reach the
frozen desktop bundle too) are copied into the catalog by `app/skills/seed.py` on every
start, *before* `reconcile` so the same pass indexes them. They then behave as ordinary
managed skills — editable, assignable, switchable.

The whole design is the upgrade path, since the destination is a directory the user can
edit. Each seeded folder carries a `.bundled` stamp holding the digest of exactly what
was installed, which separates three states: **absent** → install (and globalize once,
because the catalog indexes a new folder as *parked* and a shipped skill in scope
nowhere does nothing); **stamp still matches the contents** → ours and untouched, so a
newer bundled version replaces it; **stamp missing or stale** → a user skill that
happens to share the slug, or ours with their edits in it, so hands off and log the
skip. The globalize step runs only for slugs a pass *installed*, so parking a bundled
skill survives the next release. Copies go via a staging directory and a rename, or an
interrupted write would leave a `SKILL.md` the agent library then fails to parse.

## Skill Studio

**Skill Studio** is the catalog registered as a system `Workspace`
(`is_system` is *computed* from `path == settings.skills_dir` — no column, no
migration). Delete and path-change are refused by the API; rename is allowed.
That gives skill authoring the whole workspace surface — agent, terminal, file
tree, watcher — for the price of one row. A skill the agent writes there shows
up in the manager as **Not assigned** on the next load.

## Environment variables

`app/envvars/resolve.py`. One `EnvVar` table; each var attaches to any mix of
skills and workspaces, or is global. Precedence **global → workspace → skill**.
`key` is deliberately not unique — uniqueness is per layer, so precedence is
always well defined.

Four injection points, all additive (with no vars defined, behaviour is
byte-identical):

- The agent's shell, via `DedupingLocalBackend` overriding `execute` /
  `execute_background`. The base class takes no `env=`, so both are
  reimplemented; `tests/test_deduping_backend.py` carries parity tests against
  upstream drift.
- Per-skill script execution, via a `CallableSkillScriptExecutor` — a script
  never sees another skill's secrets.
- The system prompt lists **keys and descriptions only**. Without this the agent
  has no reason to believe a key exists and will ask the user for it.
- **Redaction on the way out**: every injected value ≥8 chars is scrubbed from
  shell and script output before it becomes tool output. The backend is the
  single choke point, so this covers the transcript, the persisted messages and
  the AG-UI stream at once.

Run-scoping uses a **`ContextVar`**, not an attribute: the `LocalBackend` is
shared per workspace across runs, so an attribute would leak one run's env into
a concurrent run. `asyncio.to_thread` copies context into the worker thread and
tasks inherit at creation, so a var set at the top of a run reaches every tool
call and every subagent of that run.

Values are **plaintext in SQLite**, matching every other secret the app holds
(`GitHubConfig.token`, `LaiosConnection.master_key`). The API is write-only:
reads return `has_value`, never the value. The interactive terminal panel is
deliberately *not* injected.
