---
name: delegating-to-lursor
description: How to hand coding work to a Lursor agent and verify the result, put agents on a schedule, serve local models, and report what it all cost. Use when a task wants a persistent workspace, a long autonomous run, or a different model than the one you are on — and when checking what a delegated run actually changed.
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

## Choosing where the work runs

Each Lursor agent carries its own model, so *which agent you delegate to is which
model you pay for*. `lursor_agents` shows the model per agent; `lursor_usage`
with `group_by="model"` shows what each has actually cost. Long mechanical work
belongs on a local model at zero marginal cost; keep the expensive one for
judgement.

If the model you want isn't up, you can provision it:

1. `lursor_local_models(view="catalog", search=…)` — find a recipe whose
   `vram_estimate_mb` fits the machine. Too large fails slowly.
2. `lursor_serve_model(action="serve", recipe=…)` — the instance returns
   `pulling`/`starting`, **not ready**. Poll `view="instances"` until `running`
   before pointing an agent at it.
3. Delegate.
4. `lursor_serve_model(action="stop", instance_id=…)` — always give the VRAM back.

Check `view="instances"` first: something may already be serving, and
double-serving wastes memory.

## Standing orders

`lursor_create_schedule` puts an agent on a cron expression in a real timezone,
opening a fresh conversation per fire. It validates the expression before
creating anything and returns the next five fire times — read them back to the
user, because "every Monday" and "every day in January" are one character apart.

- Use `run_type="goal"` only when the work genuinely needs to run until done, and
  set `max_iterations`: for an unattended run that is the only bound on spend.
- `lursor_schedule_control(action="run_now")` tests a schedule without consuming
  its next slot. Do this before trusting an overnight job.
- To find out what an overnight run did: `lursor_schedules(schedule_id=…)` for
  the history, then `lursor_messages` on the `thread_id` of the fire you care
  about.
- Prefer `disable` over `delete`. `delete` is irreversible.

## Cloning work in

`lursor_github(action="repos")` lists what the connected account can reach;
`action="clone"` drops one into a brand-new workspace you can delegate against
immediately. Cloning creates state, so only do it when asked.

## Reporting cost

`lursor_usage` answers "what have the agents been spending". Scope it with `days`
rather than pulling all time, and pick the rollup that matches the question:
`model` for which model dominates, `workspace` for which project, `day` for
whether it is trending up.
