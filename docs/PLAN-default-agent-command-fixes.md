# PLAN: Fix the default-agent-per-command setup

> Status: **IMPLEMENTED** (2026-07-22). `bunx tsc` + `oxlint` clean;
> `uv run pytest` 110 passed. Follow-up cleanup to the slash-command refactor
> ([PLAN-slash-commands-refactor.md](./PLAN-slash-commands-refactor.md)).

## Why

The "default agent per slash command" wiring works but has one conceptual flaw
and a few robustness gaps (from a review of the current code):

1. **Per-turn commands permanently mutate thread state.** `/ask` and `/goal` are
   documented as one-off per-turn intents, yet using either silently and
   permanently reassigns `thread.agent_id` to the command's default agent. Type
   `/ask a quick question` in an existing thread and every later plain message
   runs under the ask-agent, not the agent you started with.
2. **Swallowed PATCH error → UI/backend divergence.** `handleAgentChange` catches
   a failed reassign PATCH, toasts, and returns; `handleSend` then proceeds as if
   it succeeded. The UI shows the new agent while the backend still runs the old
   one.
3. **Dual agent-selection mechanism.** The turn's agent id is put on the wire but
   the backend ignores it for existing threads (it reads `thread.agent_id`), so
   the reassign PATCH is the only thing that matters. The wire id looks
   authoritative but isn't.
4. **`chat` slot mislabeled.** Settings presents `chat` as a "default agent per
   command," but plain messages never consult it — it's only the seed agent for a
   *new* conversation. The card copy also claims every command "reassigns the open
   conversation," which is only true for `/plan`.
5. **Reassign idiom hand-copied 4×** (preview memo, `handleSend`,
   `handleNewConversation`, `handleExecutePlan`), each subtly different.
6. **API schema re-closes an open map.** `default_agents` is stored as open JSON,
   but the settings API hard-codes `CommandName`/fixed Pydantic fields, so adding a
   command that carries a default agent needs a backend schema edit — contra the
   "add a command = one registry entry" design goal.

## Design

Split a command's agent behavior into two scopes, carried on the registry
descriptor as `agentScope`:

- **`"turn"`** (`/ask`, `/goal`, and "Execute plan"): a *per-turn override*. Run
  this turn under the command's agent **without** touching `thread.agent_id`. The
  agent id rides on `forwardedProps.agent_id`; the backend honors it for that run
  only.
- **`"thread"`** (`/plan`): a *sticky* switch. Persist the reassignment to the
  thread (PATCH) so later refinement turns (plain `chat` while parked) reuse the
  plan agent. This is the one genuinely sticky command.

The backend gains a per-turn override: if `forwardedProps.agent_id` differs from
`thread.agent_id`, load that agent for the run only (never persisted). For sticky
commands the ids match after the PATCH, so it's a no-op. This makes the wire id
authoritative (fixes #3) and removes the persist for per-turn commands (fixes #1).

Note (accepted): if the *first* message of a brand-new conversation is `/ask` or
`/goal`, the new thread is created owned by that command's agent (there is no
prior agent to preserve). Only existing threads are protected from silent
reassignment — which is the actual reported problem.

## Changes

**Frontend**
- `commands/types.ts` — add `agentScope?: "turn" | "thread"` to `SlashCommand`.
- `commands/registry.ts` — `ask`/`goal` → `"turn"`, `plan` → `"thread"`.
- `pages/chat/workspace-chat-page.tsx`
  - `handleAgentChange` returns `Promise<boolean>`, reverts `selectedAgentId` on
    PATCH failure (fixes #2).
  - New `agentForCommand(key, scope)` helper — persists only for `"thread"`,
    returns the `{id, name}` to run the turn as, or `null` if a required persist
    failed (fixes #5).
  - `handleSend` and `handleExecutePlan` use the helper; per-turn commands no
    longer PATCH.
- `agui/useChatEngine.ts` — forward `agent_id` in `forwardedProps`.
- `pages/settings/default-agents-section.tsx` — fix the card copy + `chat` row
  hint to reflect scope semantics (fixes #4).
- `api/types.ts` — `DefaultAgentsSettings`/`Input` fields optional; doc updated.

**Backend**
- `api/chat.py` — honor `forwardedProps.agent_id` as a non-persisted per-turn
  override.
- `schemas/settings.py` — replace fixed `DefaultAgentsRead/Update`/`CommandName`
  with an open `dict[str, str]` (fixes #6).
- `api/settings.py` — open-map GET/PUT (partial update; blank clears a key).

## Verification

- `bunx tsc` + `oxlint` clean; `uv run pytest` green.
- Manual: `/ask` in an existing thread leaves the agent picker on the original
  agent after send; `/plan` switches and refinements stay on the plan agent.
