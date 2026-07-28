# PLAN: Honest subagent roster + drop built-in overrides

> Status: **IMPLEMENTED** (2026-07-28). Open questions resolved: **Copy to new
> subagent** was dropped (Q1 — the read-only card is enough), and the
> disabled-builtin state stays global (Q2). Two things landed beyond the plan as
> written, both noted inline below: a same-name guard so a user subagent shadows a
> built-in rather than being silently shadowed by it, and an empty-roster case for
> the `task` description (the library registers `task` even with nothing to
> delegate to).

> Triggered by a user report: with the
> `general-purpose` built-in disabled, the agent still delegates to it and the
> chat shows `Error: Unknown subagent 'general-purpose'. Available: coder,
> code reviewer, Thinker, planner`.

## Why

Three problems, all in the same seam between our roster resolution
(`app/agents/builder.py`) and pydantic-deep's subagent toolset.

### 1. The `task` tool tells the model to use a subagent that may not exist

`subagents_pydantic_ai/prompts.py:80`, inside `TASK_TOOL_DESCRIPTION`, ships this
line to every agent unconditionally:

```
- **Choose the right subagent**: Match the subagent_type to the task.
  Use "general-purpose" when no specialized subagent fits.
```

It is never rewritten from the live roster. Disable the `general-purpose`
built-in and the tool description still instructs the model to fall back to it.

Nothing at the schema layer stops the call either: `subagent_type: str`
(`subagents_pydantic_ai/toolset.py:342`) has no enum, so the provider cannot
reject an unknown name. Validation happens after dispatch
(`toolset.py:369-376`) and returns the error string above as the tool result.

Claude models additionally carry a strong prior for `general-purpose` — it is
the canonical subagent type in Claude Code's Task tool. Prior + the hardcoded
sentence + no enum reproduces the report reliably.

Note what is *not* broken: the roster we advertise is correct. The system prompt
lists exactly the enabled specialists (`pydantic_deep/instructions.py:60-67` →
`get_subagent_system_prompt`), and `toolset.py:333-337` appends
`Available subagent types: ...` to the tool description. The model has the right
list and the same description talks it out of using it.

Severity is a wasted delegation turn plus an alarming card, not a dead run: the
tool returns a string rather than raising, so the model can retry with a valid
name, and `frontend/src/components/chat/ChatSubagentCalls.tsx:55` marks the card
"Failed" purely by matching the `"Error:"` prefix.

### 2. Built-in overrides are a redundant concept

A built-in override is a `Subagent` row with `builtin_name` set — an editable
copy of a pydantic-deep built-in, managed under `/subagents/builtins/{name}`.
It can express strictly *less* than an ordinary subagent row:

- Override (`BuiltinOverrideUpdate`, `app/schemas/subagent.py`): `description`,
  `instructions`, `model`.
- User subagent: those plus `include_todo/subagents/skills/memory/plan`,
  `web_search`, `thinking`, `tool_choice`, linked tools, `extra_config`,
  `enabled`.

Both take the same path at build time (`builder.py:836-838` runs `_config(...)`
on either), so "override a built-in" is exactly "disable the built-in + create a
subagent". One extra click, one fewer concept, and a chunk of API + UI surface
that exists only to support the shorter of the two forms.

### 3. Override rows bypass the `enabled` check (bug)

`builder.py:826-838`:

```python
overrides = {sa.builtin_name: sa for sa in rows if sa.builtin_name}
subagent_configs = [_config(sa) for sa in rows if not sa.builtin_name and sa.enabled]
...
subagent_configs.append(_config(override) if override else dict(builtin))
```

User subagents are filtered on `sa.enabled`; override rows are not. Override
`general-purpose`, then toggle *that copy* off, and it stays in every agent's
roster — the inverse of the reported bug. Deleting the override concept deletes
this bug with it.

## Design

### A. Rewrite the `task` tool definition from the live roster

`pydantic-deep` is third-party (`vstorm-co/pydantic-deepagents`, pinned to a SHA
in `backend/pyproject.toml:17`), and `create_deep_agent` exposes no passthrough
to `create_subagent_toolset(descriptions=...)`. So we fix it on our side with a
second `PrepareTools` capability, alongside the existing read-only filter
(`builder.py:449`, applied at `builder.py:878`).

The capability runs every step and, for the `task` tool only:

1. Strips the `Use "general-purpose" when no specialized subagent fits.`
   sentence from the description and replaces it with the live roster
   (`Use one of: <names>. Do not invent a subagent type.`).
2. Injects `"enum": [<names>]` into the `subagent_type` property of
   `parameters_json_schema`, so providers that honour enums (Anthropic, OpenAI)
   cannot emit an invalid name at all.

`ToolDefinition` is a dataclass (`pydantic_ai/tools.py:699`), so the rewrite uses
`dataclasses.replace` with a freshly built schema dict — never in-place mutation
of the toolset's own schema, which is shared across runs.

Names come from `subagent_configs` (already assembled at `builder.py:820-838`),
plus `"planner"` when `include_plan` is on — pydantic-deep appends that built-in
itself (`pydantic_deep/agent.py:1001-1013`), so we mirror the same condition.
The library's post-hoc validation stays as the backstop for local models that
ignore enums (GLM/DeepSeek via OpenAI-compatible endpoints).

Ordering: read-only mode drops `task` outright, so if both capabilities are
active the rewrite simply finds nothing. Either order is safe.

### B. Built-ins become a plain on/off toggle

Delete the override concept end to end. A built-in is then: name, library
description, library instructions, and a switch.

Accepted behavior change: an un-overridden built-in is handed to the library as
a plain config dict (`dict(builtin)`), so it gets pydantic-deep's lean subagent
factory — no skills or memory, thinking off — whereas an override row got our
full-parity `_subagent_config` factory. After this change, built-ins are always
lean. The way to get a `general-purpose` with skills, web search, or a pinned
model becomes: turn the built-in off, create your own subagent. The capability
moves, it does not disappear.

The built-in card keeps showing the library `description` read-only (the
`/defaults` payload still carries `default_description` / `default_instructions`)
next to the switch. No copy-to-subagent action: authoring one from scratch is the
same handful of fields, so seeding the form was not worth the extra prop.

## Changes

**Backend**

- `app/agents/builder.py`
  - New `_task_tool_roster_filter` factory + `PrepareTools` capability appended
    next to the read-only one (~line 878).
  - `823-838` collapses to: user rows filtered on `enabled`, then every built-in
    not in `disabled_builtins` appended as `dict(builtin)`. The `overrides` dict
    and the `_config(override) if override else ...` branch go away (fixes #3).
- `app/api/subagents.py` — delete `_override_rows`, `PUT /builtins/{name}`,
  `DELETE /builtins/{name}`, the `override=` field in `_defaults_payload`, and
  the `Subagent.builtin_name.is_(None)` filter in `list_subagents`.
- `app/schemas/subagent.py` — delete `BuiltinOverrideUpdate`,
  `BuiltinSubagentRead.override`, `SubagentRead.builtin_name`.
- `app/db/models.py:415-427` — drop the `builtin_name` column and fix the
  `enabled` comment that references override rows.
- `app/db/session.py:151-152` — replace the `ADD COLUMN builtin_name` retrofit
  with the migration below.
- `app/agents/deep_defaults.py` — module docstring drops the "overridden (an
  editable copy)" clause; resolution logic is unchanged.

**Frontend**

- `pages/subagents/subagent-defaults-panel.tsx` — delete
  `BuiltinOverrideDialog`, the Override/Edit and Reset buttons, and the
  "Overridden" badge. `BuiltinCard` becomes name + description + switch.
- `pages/subagents/subagents-page.tsx` — drop `editingBuiltin` state and the
  dialog wiring (lines 48, 137, 174-177); `nextDisabledBuiltins` and
  `toggleBuiltin` stay.
- `api/subagents.ts` — delete `overrideBuiltin`, `resetBuiltin`,
  `useOverrideBuiltin`, `useResetBuiltin`.
- `api/types.ts` — delete `BuiltinOverrideInput`, `BuiltinSubagent.override`,
  `Subagent.builtin_name`. Keep `ResolvedInt.override` (line 259) — that is
  `max_nesting_depth`, unrelated.

**Migration** (`_apply_lightweight_migrations`, still SQLite + `create_all`, no
Alembic)

Existing installs may hold override rows; do not delete a user's edits. For each
row with `builtin_name` set:

1. `UPDATE subagents SET builtin_name = NULL` — it becomes an ordinary subagent
   and appears in the roster.
2. Append its `builtin_name` to `AppConfig.deep_defaults["disabled_builtins"]`,
   so the library built-in of the same name stops competing with the copy the
   user actually edited. This preserves today's effective behavior exactly
   (override wins over the built-in) with no duplicate names.
3. Then `ALTER TABLE subagents DROP COLUMN builtin_name`, guarded on
   `PRAGMA table_info` like the rest of that function (SQLite ≥3.35).

Run the whole thing only when the column is still present, so it is idempotent.

## Tests

- `tests/test_subagent_defaults.py`
  - Delete `test_override_builtin_and_hidden_from_roster` (lines 66-92) and the
    override half of `test_builder_roster_respects_disable_and_override`; the
    disable assertions stay.
  - New: `PUT/DELETE /subagents/builtins/{name}` return 404/405 (route gone).
- New builder test: with `disabled_builtins=["general-purpose"]`, the prepared
  `task` tool definition (a) never contains the string `general-purpose` and
  (b) has `subagent_type.enum` equal to the enabled roster. This is the
  regression test for the reported bug.
- New builder test: a user subagent with `enabled=False` is excluded (guards
  against #3 regressing under the simplified loop).
- New migration test: seed a row with `builtin_name` set, run
  `_apply_lightweight_migrations`, assert the row survives with
  `builtin_name` gone and the name added to `disabled_builtins`.

## Out of scope

- Upstreaming the description fix to `vstorm-co/pydantic-deepagents` — not our
  repo; we fix it locally.
- Changing how the "Failed" state is derived in `ChatSubagentCalls.tsx`. The
  prefix match is crude but correct here, and with A in place an unknown-subagent
  result should stop occurring.
- Per-agent subagent links, and any change to `max_nesting_depth` resolution.

## Open questions

1. **Copy to new subagent** — worth the ~10 lines, or is a read-only built-in
   card enough? (Recommendation: include it; it is the only part of the override
   flow anyone would miss.) **Resolved: dropped** — the read-only card is enough.
2. Should the disabled-builtin state stay global (`AppConfig.deep_defaults`) or
   become per-agent? Global today; this plan keeps it global.
