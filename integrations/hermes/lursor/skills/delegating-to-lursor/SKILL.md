---
name: delegating-to-lursor
description: How to hand coding work to a Lursor agent and verify the result. Use when a task wants a persistent workspace, a long autonomous run, or a different model than the one you are on — and when checking what a delegated run actually changed.
---

# Delegating to Lursor

Lursor is a local control room for AI agents. Each of its agents is rooted in a
real directory on this machine and has a shell, a filesystem and a git working
tree there. A run is owned by the Lursor backend, not by whoever is watching it,
so it keeps going after you stop listening.

## When this is worth it

Delegate when the work wants something you don't have in-process:

- **A persistent workspace.** The agent stays rooted in one project directory
  across many turns, and its changes accumulate in a git working tree you can
  diff.
- **A long autonomous run.** A goal run works turn after turn until an
  independent evaluator judges the objective met.
- **A different model.** Each Lursor agent carries its own model and capability
  set; delegating is how you reach one.

Don't delegate a file read or a one-line edit you can do yourself. The round trip
costs more than the work.

## The loop

1. `lursor_workspaces` and `lursor_agents` — see what exists. Workspace paths are
   absolute, so you can tell which project is which.
2. `lursor_delegate` — send the work. Choose the turn type deliberately:
   - `chat` for one ordinary turn with full tools;
   - `ask` to inspect without changing anything;
   - `goal` for autonomous work — **your message is the success condition**, so
     write it as one ("the backend test suite passes and ruff is clean"), not as
     a chat opener;
   - `plan` to get a plan document without execution, then `execute_plan` on the
     same `thread_id` once you've read it.
3. `lursor_run_status` — poll anything that didn't finish inline. Goal runs
   default to not waiting; a `chat` turn that outlasts its timeout also keeps
   going, and the result says so.
4. `lursor_diff` — verify. This is the step that gets skipped and shouldn't be:
   an agent's own account of its work is not evidence. Read the changed files and
   line counts, and `include_patch=true` when you need the text.

## Things worth knowing

- **Conversations carry context.** Pass `thread_id` to continue one; the prior
  transcript is resent, so the agent remembers. A new delegation with no
  `thread_id` starts from nothing.
- **One run per conversation.** A second delegate against a busy conversation is
  refused. Either wait, `lursor_stop_run`, or open a new conversation.
- **Stopping is not undoing.** A cancelled run leaves whatever it already wrote
  on disk. Check `lursor_diff` afterwards.
- **A parked plan needs `execute_plan`.** After a `plan` turn the conversation
  sits in `awaiting_approval` with a `plan_path`. Read that file, then send
  `turn="execute_plan"` on the same `thread_id` — an ordinary message there
  *refines* the plan instead of carrying it out.
- **Lursor is unsandboxed and single-user.** Its agents run commands with your
  privileges in the directory you point them at. Delegate accordingly.
