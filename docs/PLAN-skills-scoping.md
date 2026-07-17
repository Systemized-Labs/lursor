# PLAN: Skills scoping — global + workspace skill sets, drop per-agent links

> Status: **IMPLEMENTED** (2026-07-17). Backend + frontend landed; `uv run pytest`
> 66 passed, `bun tsc` clean, migration verified against a populated DB, and the
> scope/precedence flow driven end-to-end over HTTP (workspace skill wins over a
> same-slug global skill; global-only skills still injected). Open questions were
> resolved as: (1) reconcile iterates all existing workspaces on startup/list —
> the builder reads disk directly so it never depends on reconcile, and a
> workspace whose directory is gone is skipped (never resurrected); (2)
> `include_skills=false` suppresses **both** scopes (master off switch).

## 0. Why

Skills today are a **single global catalog** on disk (`~/.lursor/skills/<slug>/SKILL.md`,
indexed in the `skills` table) that is **linked per-agent** through the
`agent_skills` / `subagent_skills` join tables. An agent only touches a workspace
indirectly: a `Thread` binds `agent_id` + `workspace_id`, and at build time the
workspace's `path` becomes the agent's filesystem root
(`backend/app/agents/builder.py:462`).

The problem: the skill set is baked onto the **agent**, not the workspace. Point
one agent at a different workspace and its skills don't change — you must manually
edit the agent's `skill_ids` every time. That per-agent churn is the pain point.

Two facts make the fix clean:

- A workspace already **is a real directory on disk** (`Workspace.path`), and it is
  the agent's filesystem root at runtime.
- Skills are already handed to the engine as **directories**, not DB rows:
  `builder.py:473-477` builds `skill_dirs` and passes them as
  `create_deep_agent(..., skill_directories=...)`.

So skills are already directory-driven under the hood. The only reason switching
workspaces is painful is that we resolve those directories from per-agent DB links
instead of from **scope**.

**Target end state:** convention-based dual-scope discovery, like Claude Code. An
agent no longer "has" a skill list; it discovers whatever exists in two scopes for
wherever it is running. Global skills follow the user everywhere; workspace skills
travel with the workspace directory. Zero per-agent skill management.

## 1. How Claude Code does it (reference)

| | User-global | Workspace/project |
|---|---|---|
| Skills | `~/.claude/skills/<name>/` | `.claude/skills/<name>/` |
| Discovery | auto-scanned on start + live reload | auto-scanned, walks up to repo root |
| Registration | none — pure convention | none — pure convention |

Precedence: Personal > Project; on name collision the **closest scope wins**, with
no content merging. Cursor rules (`.cursor/rules/`) and MCP (`~/.mcp.json` vs
`.mcp.json`) follow the same dual-scope pattern.

## 2. Decisions (confirmed with user, 2026-07-17)

1. **Pure convention.** Drop per-agent `skill_ids` entirely. Skills = global dir +
   workspace dir, auto-merged at build time. Agents keep only the `include_skills`
   on/off toggle. (Matches Claude Code; eliminates all per-agent skill management.)
2. **Two scopes:**
   - **Global:** `~/.lursor/skills/<slug>/` — existing `config.skills_dir`. Applies
     to every agent, every workspace.
   - **Workspace:** `<workspace.path>/.agents/skills/<slug>/` — travels with the
     workspace directory, git-shareable. The `.agents/` prefix matches the
     convention several deps already ship (`pydantic_ai`, `sqlmodel`, … each carry
     `.agents/skills`).
3. **Precedence:** on slug collision, **workspace wins over global**
   (closest-scope-wins).
4. **Clean break, migrate data.** Drop the join tables and `skill_ids` plumbing
   rather than reskinning them. Existing agent→skill links are discarded — global +
   workspace membership replaces them (see §6).

## 3. Data model changes

`backend/app/db/models.py`

- **Remove** `AgentSkillLink` (`:40-43`) and `SubagentSkillLink` (`:52-55`) and the
  `Agent.skills` (`:223-227`) / `Subagent.skills` (`:282-286`) relationships.
- **Keep** `Agent.include_skills` (`:212`) and `Subagent.include_skills` (`:260`) as
  the master on/off toggle.
- **`Skill` index** (`:129-155`) gains scope columns so the DB can index both roots:
  - `scope: str` — `"global" | "workspace"`.
  - `workspace_id: str | None` — FK to `Workspace`, set only when `scope == "workspace"`.
  - Identity becomes `(scope, workspace_id, slug)` instead of `slug` alone (a
    workspace may legitimately redefine a global slug — that is the collision case).

The `Skill` table stays a **rebuildable index** over the on-disk source of truth;
`content`/`name`/`description` remain a disk-sourced cache.

## 4. On-disk store changes

`backend/app/skills/store.py`, `backend/app/config.py`

- Introduce the notion of a **skills root** rather than one hard-coded dir. The
  store's path helpers (`path_for`, `list_slugs`, `read_skill`, `write_skill`,
  `delete_skill`, import helpers) take a root argument.
- Add a helper to resolve a workspace's skills root:
  `workspace_skills_root(workspace_path) -> workspace_path / ".agents" / "skills"`.
- `config.skills_dir` stays as the **global** root (`~/.lursor/skills/`).
- No `.agents/skills` directory is created eagerly in a workspace; it is created
  lazily on first workspace-scoped write (and treated as empty if absent on read).

## 5. Runtime injection (the core fix)

`backend/app/agents/builder.py`

Replace `skill_dirs` (`:473-477`, currently resolved from `row.skills`) with a
scope-based merge. `build_deep_agent` already receives the workspace path
(threaded from `chat.py:470`):

```python
# Global skills apply everywhere; workspace skills travel with the directory.
# On slug collision, the workspace copy wins (closest scope). Skip any dir that
# is somehow missing rather than failing the run.
def _scoped_skill_dirs(workspace_path: Path) -> list[str]:
    by_slug: dict[str, Path] = {}
    for slug in skill_store.list_slugs(config.skills_dir):          # global first
        by_slug[slug] = skill_store.path_for(slug, config.skills_dir)
    ws_root = workspace_skills_root(workspace_path)
    for slug in skill_store.list_slugs(ws_root):                    # workspace overrides
        by_slug[slug] = skill_store.path_for(slug, ws_root)
    return [str(p) for p in by_slug.values()]
```

Passed unchanged to `create_deep_agent(..., skill_directories=..., include_skills=row.include_skills)`
(`:620-637`). Read-only ("ask") tool filtering (`:175-213`) is unaffected —
`run_skill_script` still gets stripped in read-only turns.

Result: moving an agent to another workspace auto-swaps the workspace skill set;
global skills stay. No per-agent edits, ever.

## 6. Reconcile + API changes

`backend/app/api/skills.py`

- `reconcile(session)` (`:52-109`) now reconciles **both roots**:
  - Global root ⇄ `Skill` rows where `scope == "global"`.
  - For each `Workspace`, its `.agents/skills` root ⇄ `Skill` rows where
    `scope == "workspace" and workspace_id == ws.id`.
  - Disk stays authoritative; orphan folders get indexed, missing folders get
    materialized from cache, caches refresh from disk (same rules as today, per root).
- CRUD endpoints take a **scope selector** (`scope` + optional `workspace_id`) so
  create/update/delete/import write to the correct directory. Default `scope="global"`
  preserves today's behavior for callers that omit it.
- Startup reconcile (`main.py:44-48`) is unchanged in shape but now covers workspace
  roots too. Since workspaces can be many, reconcile iterates all `Workspace` rows.

### Migration

A DB migration drops `agent_skills` and `subagent_skills` and adds
`skill.scope` / `skill.workspace_id`. Existing `skills` rows backfill to
`scope="global"`. **Existing agent→skill links are intentionally discarded** — the
new model derives membership from scope, so prior per-agent curation does not carry
over. (Call this out in release notes; it is the one behavior change users will
notice.)

## 7. Schema / wire format

- `backend/app/schemas/agent.py` — remove `skill_ids` (`:36/:54/:87`) and the
  `AgentRead.from_agent` mapping (`:109`); keep `include_skills`.
- `backend/app/schemas/subagent.py` — remove `skill_ids` (`:26/:45/:65/:89`).
- `backend/app/schemas/skill.py` — `SkillRead` gains `scope` + `workspace_id`;
  `SkillCreate` gains an optional `scope` selector.

## 8. Frontend

- `frontend/src/pages/agents/agent-form-dialog.tsx` — remove the skill multi-select
  (`:181-188/:544-549`) and the `skill_ids` submit (`:317/:105/:125`); keep the
  `include_skills` toggle.
- `frontend/src/pages/subagents/subagent-form-dialog.tsx` — same removal.
- `frontend/src/pages/skills/skills-page.tsx` — split the catalog into **Global
  skills** and **Workspace skills** (workspace picker → its `.agents/skills`). Create/
  edit target the selected scope.
- `frontend/src/api/skills.ts` + `frontend/src/api/types.ts` — thread `scope` /
  `workspace_id` through the catalog hooks and the `Skill` type.

## 9. Out of scope / notes

- **Live reload** (Claude Code re-scans within seconds) is a nice-to-have, not
  required. Today's reconcile-on-list/import + build-time scan already picks up new
  skills on the next turn. Defer file watching.
- **Nested/monorepo walk-up** (scanning parent dirs to a repo root) is not needed:
  a Lursor workspace is a single directory, so exactly two scopes exist.
- The AG-UI dual-transport rule (new stream events must be wired into both live-send
  and reconnect paths) does **not** apply — this change adds no stream events.

## 10. Open questions

1. Confirm workspace reconcile cost is acceptable when many workspaces exist, or
   make workspace reconcile lazy (only for the workspace of the thread being built /
   the skills page being viewed) rather than all-workspaces-on-startup.
2. Should `include_skills=false` suppress **both** scopes (proposed: yes — it is the
   master off switch), or only workspace skills?
