# Lursor plugin for Hermes

A [Hermes](https://hermes-agent.nousresearch.com) plugin that lets Hermes drive a
local Lursor instance: hand work to a Lursor agent rooted in a real directory,
follow autonomous goal runs, and read back the reply, the git diff, and the files
it touched.

The existing relationship between the two runs the other way — Lursor already
picks up skills from `~/.hermes/skills`. This is the reverse direction.

## Install

The easiest route is **Lursor → Settings → Integrations**, which detects your
Hermes install, works out which step you are on, and shows the one command that
moves it forward with a copy button. It is deliberately detect-and-instruct
rather than one-click: Lursor reads another tool's directory and never writes to
it (see `backend/app/api/integrations.py`).

Otherwise, one command. Hermes's installer accepts an `owner/repo/subdir`
shorthand, so it can pull this plugin straight out of the Lursor monorepo:

```bash
hermes plugins install JonathanConn/lursor/integrations/hermes/lursor
```

It clones the repo, extracts this directory, names it from the manifest
(`~/.hermes/plugins/lursor`), and offers to enable it. Then check it loaded:

```bash
hermes plugins list
hermes lursor status
```

Decline the `allow_tool_override` prompt — that capability is for replacing
built-in tools like `shell_exec`, and this plugin never registers with
`override=True`.

**Upgrading.** A subdir install has no `.git` in it, so `hermes plugins update
lursor` cannot work — it reports *"not installed from git"*. Re-run the install
with force instead.

### Developing against a checkout

To have Hermes load your working copy live, symlink it instead:

```bash
ln -sfn "$(pwd)/integrations/hermes/lursor" ~/.hermes/plugins/lursor
hermes plugins enable lursor
```

Use `-n` with `-f`. Without it, a second run resolves *through* the existing
symlink and creates a recursive `lursor/lursor` link inside your checkout —
which is easy to commit by accident.

Either way, Hermes discovers plugins once per process and caches the result, so
**restart Hermes** after installing. A new session in an already-running process
will not pick it up.

No dependencies — the plugin is stdlib-only on purpose, because it is imported by
whatever interpreter the user's Hermes runs in.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LURSOR_API_BASE` | `http://127.0.0.1:8791/api` | Where the Lursor backend listens |

Nothing needs setting for a normal local install. Start Lursor the usual way
(`./scripts/dev.sh`, or the desktop app) before asking Hermes to use it — if it
isn't running, every tool returns an error that says so rather than failing
obscurely.

## Tools

All are registered under the `lursor` toolset.

| Tool | What it does |
| --- | --- |
| `lursor_workspaces` | List workspaces (id, name, absolute path) |
| `lursor_agents` | List agents with model and capabilities |
| `lursor_threads` | List conversations, newest first, with live-run flags |
| `lursor_messages` | Read a conversation's transcript |
| `lursor_delegate` | Send work to an agent; the main entry point |
| `lursor_run_status` | Poll a run; read the newest assistant message |
| `lursor_stop_run` | Cancel a run in flight |
| `lursor_diff` | Uncommitted git changes across the workspace |
| `lursor_list_files` | List a directory inside a workspace |
| `lursor_read_file` | Read a file inside a workspace |
| `lursor_usage` | Token/cost rollups — total, per model, per workspace, per day |
| `lursor_schedules` | List standing orders; one schedule's run history |
| `lursor_create_schedule` | Put an agent on a cron expression, in a real timezone |
| `lursor_schedule_control` | `run_now` / `enable` / `disable` / `delete` |
| `lursor_local_models` | laios daemons: connections, catalog, models, instances, jobs |
| `lursor_serve_model` | Start or stop a local model on your own hardware |
| `lursor_github` | List the connected account's repos; clone one into a new workspace |

Also registered: a `pre_llm_call` hook that tells the agent when a background
delegation has landed, a `/lursor` slash command, a `hermes lursor` CLI command,
and a bundled `delegating-to-lursor` skill (`skill_view("lursor:delegating-to-lursor")`).

### Turn types

`lursor_delegate` takes a `turn`, mapping onto Lursor's per-turn intents:

- `chat` — one ordinary turn, full tools (default).
- `ask` — one read-only turn.
- `goal` — autonomous run; works turn after turn until an independent evaluator
  judges the objective met. **The message is the success condition.**
- `plan` — draft a plan doc and park for review, executing nothing.
- `execute_plan` — carry out the plan parked on a conversation (needs `thread_id`).

`goal` and `execute_plan` default to not waiting, since they run for minutes;
poll them with `lursor_run_status`. Everything else waits inline, bounded by
`timeout_seconds` (default 180).

### The capacity-manager loop

The reason `lursor_serve_model` and `lursor_local_models` are here: Hermes can
provision compute, use it, and give it back.

1. `lursor_local_models(view="catalog", search=…)` — pick a recipe that fits the
   VRAM the machine actually has.
2. `lursor_serve_model(action="serve", recipe=…)` — start it. The instance comes
   back `pulling` or `starting`, **not** ready; poll `view="instances"` until it
   reports `running`.
3. `lursor_delegate` to a Lursor agent configured against that model.
4. `lursor_serve_model(action="stop", instance_id=…)` — free the VRAM.

`lursor_usage(group_by="model")` is what makes this worth doing: it shows local
runs at `$0.00` next to the cloud spend they displaced.

### Schedules

`lursor_create_schedule` validates the cron expression through
`POST /schedules/preview` *before* creating anything, and returns the next five
fire times so a mistake is visible rather than discovered next Tuesday. The
timezone defaults to this machine's IANA zone, read off `/etc/localtime` — a
model has no reliable way to know the operator's, and a schedule's whole point is
that 9am survives DST.

`run_now` fires immediately **without** consuming the next slot or moving the
clock, which is how you test what tonight's run will do. Prefer `disable` to
`delete`; `delete` is irreversible, so the result names what it destroyed.

## Design notes

Three things about Lursor's API shape drove this implementation, and each one is
easy to get wrong:

**Runs outlive their listener.** Lursor owns a chat run as a detached task
(`backend/app/agents/chat_run_manager.py`); the SSE response is only a
subscriber, so hanging up cancels nothing. That is what makes fire-and-forget
delegation safe, and why a timed-out wait reports `status: "running"` and hands
back a `thread_id` instead of pretending the work died.

**History lives in the request, not the database.** Lursor's chat driver passes
`message_history=None` and rebuilds context purely from the AG-UI body. So
continuing a conversation means re-sending the transcript — which
`lursor_delegate` does, from `GET /threads/{id}/messages`, capped at the most
recent 60 messages and reported when the cap bites. Miss this and every follow-up
turn silently starts amnesiac.

**The chat endpoint speaks AG-UI, not plain JSON.** `POST /threads/{id}/chat`
wants a full `RunAgentInput` — every field present and camelCased, even the empty
ones — and answers with an SSE event stream. `tools`/`context` are sent empty
deliberately: the tools a run may use are the Lursor agent's own, configured in
Lursor.

**Validation errors arrive as a list, not a string.** A hand-raised
`HTTPException` puts a string in FastAPI's `detail`, but a schema rejection (422)
puts a list of `{loc, msg, type}` entries — and 422 is the common case here (bad
cron, unknown timezone, out-of-range iterations). `client._format_detail`
flattens both shapes, so a bad cron reports *"cron: Expected 5 space-separated
fields… got 3"* instead of an opaque type error.

Per the Hermes plugin contract, handlers return a JSON string and never raise;
failures come back as `{"error": ...}` with a message written to be read by a
model. Reply text, patches and transcripts are truncated to keep a long run from
swamping Hermes's context, and truncation is always reported rather than silent.

## Tests

```bash
python -m pytest integrations/hermes/tests -q
```

64 unit tests, no backend or network needed — they cover the AG-UI body shape,
SSE framing, name resolution, history re-sending, the truncation reports, cron
validation ordering, the laios views, and the never-raise contract. They were
also validated against a live Lursor backend driven by a stub OpenAI-compatible
model server.

## Security

Lursor is single-user, local-first, and unsandboxed: its agents run commands with
your privileges in whatever directory they are rooted in, and there is no
authentication on the API. This plugin hands that capability to Hermes. Keep the
backend bound to localhost and see [SECURITY.md](../../SECURITY.md).
