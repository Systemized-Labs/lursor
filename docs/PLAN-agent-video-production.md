# PLAN: Agent video production

> Status: **IMPLEMENTED and verified against a real box** (2026-08-03). The durable
> decisions have moved into `AGENTS.md` §6 ("Video generation" and the bundled-skills
> part of "Skills"); per the repo convention this doc can now be deleted
> (`git log --diff-filter=A -- docs/` finds it again if needed).
>
> **What the plan got wrong, settled by the engine's own source and one real box:**
>
> * **§3.3 is not multipart.** `fl2va` is the same JSON body plus a `conditions`
>   array, keyframe inlined as a `data:` URI — read off SGLang's `video_api.py` /
>   `minimax_h3/request_validation.py`. `create_video` needed **no** new transport
>   branch; the only change is that the stored row elides the inlined bytes. Open
>   question 2 is answered: `frame_index` accepts `[0]`, `[-1]` or `[0, -1]`, and all
>   three were accepted by the running engine.
> * **The real constraint on a keyframe is the gateway's 2 MiB body cap**, which the
>   plan never mentions because nothing documents it (axum's default; measured at
>   2,090,000 pass / 2,200,000 → 413). Nothing to do with the engine's own limits.
> * **The delivered clip is longer than requested** — frames align to 17n+5 at 24 fps,
>   so `duration_seconds=4` returns 4.458 s. Every ffmpeg duration calculation has to
>   come from `ffprobe`.
> * **§9's "without editing existing tests" did not survive §7.** Reconciling active
>   rows inside `list_videos` changes what a listing does, so `test_submit_poll_and_play`
>   asserts that reconcile instead of expecting the listing to be inert. Two fixtures
>   that enumerate NOT NULL columns also needed the new ones.
> * **A fourth tool, `cancel_video`,** was added beyond the plan's three: the API
>   already existed, and without it an agent that starts a wrong 35-minute render can
>   only watch it finish.
> * **The skill does not live in the catalog by hand.** It ships in the repo
>   (`backend/app/skills/bundled/`) and is seeded into `~/.lursor/skills` on startup,
>   stamped so a user's edits are never overwritten by a later release
>   (`app/skills/seed.py`).
>
## 0. Why this is mostly assembly

The generation half already exists and is good. What is missing is a way for an
agent to reach it, a place on disk for the result, and the knowledge to cut it.

**The gateway proxy is done.** `backend/app/api/videos.py` submits
(`create_video:189`), polls and folds status into the row (`video_status:251`),
cancels (`cancel_video:297`) and downloads once into the content-addressed store
(`video_content:325`). It relays the engine's request schema unaltered and
unwraps both gateway error shapes (`_gateway_error_detail:91`) — so per-model
validation messages (`target.short_edge must be 768 for minimax_h3`) already come
back precise and actionable.

**Durability is done.** `VideoJob` is the record of what was asked for, and
`media_store.save_video:99` / `video_path:118` keep the clip under
`~/.lursor/media/videos/<sha256>.mp4`, deduped by content hash.

**Connection and model resolution are done.** `gateway_base` handles both direct
(`:4000`) and lastway-tunnelled topologies, and `non_chat_served_names`
(`backend/app/api/laios.py:281`) already performs the capabilities join that
tells a video model from a chat model — keyed on the *absence* of `chat`, and
failing open.

**The async-resolve-then-build seam is done.** `build_deep_agent`
(`backend/app/agents/builder.py:886`) is synchronous, so anything needing a
session is resolved first in `_build_agent_and_context`
(`backend/app/api/chat.py:818`) and handed in as one value — that is exactly what
`SkillRuntime` is (`backend/app/agents/skill_runtime.py`). A `VideoRuntime`
follows the same shape with no new machinery.

**A tool that calls a model and returns text is done.** `make_view_image_tool`
(`backend/app/agents/vision.py:98`) is the template: a factory bound to the
workspace path, relative paths resolved against it, every failure returned as an
`"Error: ..."` string so a bad path never burns the retry budget or aborts a run.

**Tool budget is already managed.** Everything outside `_CORE_TOOLS`
(`backend/app/agents/tool_loading.py:62`) is deferred and revealed by
`search_tools`, so three new tools cost nothing in the opening prompt.

What is genuinely missing: three tools, a `VideoRuntime`, one agent flag, a
workspace materialize step, the `fl2va` multipart path, a skill, and an ffmpeg
dependency declaration.

## 1. Decisions

1. **Tools own the gateway; the skill owns ffmpeg.** The dividing rule: *a tool
   is required when the work needs a credential, a DB row, or app state.*
   Generation needs all three — the `master_key` is deliberately server-side
   (`backend/app/db/models.py:478`) and injecting it into the agent's shell env
   would create a new secret surface for the sole benefit of letting the agent
   `curl`. ffmpeg needs none of them: it is `execute` plus knowledge. Wrapping
   trim/concat/overlay as tools would be a worse CLI over a good one, and would
   spend the tool budget that `docs/TOOL-SURFACE-AUDIT.md` exists to protect.

2. **Generation never blocks a turn.** At ~44 s per denoise step
   (`frontend/src/pages/video/video-settings.ts`), a draft is ~6 min and a
   50-step final ~35 min. A tool call that waits that long makes the run look
   hung, cannot be steered, and starves the goal loop's iteration budget.
   `generate_video` returns a job id and an ETA immediately; `video_status` takes
   a **bounded** `wait_seconds` (hard cap 300) and returns "still running" rather
   than waiting forever, so the model decides whether to loop or go do something
   else.

3. **The clip is materialized into the workspace, not referenced in the store.**
   The media store is outside the workspace; ffmpeg, `ls`, `read_file` and the
   file tree all live inside it. `video_status` copies the finished clip to a
   workspace-relative path and returns *that*. Anything else forces the agent to
   handle absolute `~/.lursor` paths, which it will get wrong.

4. **Opt-in per agent, and gated on a usable connection.** Two conditions: an
   `Agent.include_video` flag (default **off** — a 35-minute GPU job deserves an
   explicit checkbox), and the presence of a laios connection serving a
   video-capable model. Either missing means the tools are not built at all,
   rather than built and failing at call time.

5. **`view_video` is a tool, not a skill recipe.** It could be composed from
   ffmpeg plus `view_image`, but every generate/edit cycle needs it, it is the
   only way the agent can perceive its own output, and doing it in one tool keeps
   it to a single vision call (a tiled contact sheet) instead of N. It also
   becomes reusable by the goal evaluator later.

6. **`fl2va` gets wired up as part of this.** Clips cap at 15 s. Without
   last-frame → first-frame conditioning, a 60-second piece is four unrelated
   shots — the difference between "the agent made four clips" and "the agent made
   a video". The proxy's own docstring already notes the path is unimplemented;
   it is multipart with the model in the query string.

7. **No new AG-UI event type.** Progress is reported through ordinary tool
   results. Adding a stream event would mean wiring both the live-send and
   reconnect paths (§7.1 of AGENTS.md), and buys nothing a tool result does not
   already give.

## 2. The tool surface

Three tools, all deferred, all in a new `backend/app/agents/video_tools.py`
built as factories bound to a `VideoRuntime` + workspace path, mirroring
`make_view_image_tool`. Every failure returns `"Error: ..."` text; nothing
raises.

### 2.1 `generate_video`

```
generate_video(
    prompt: str,
    aspect_ratio: str = "16:9",     # 16:9 | 9:16 | 1:1
    duration_seconds: float = 4,    # engine range 4-15
    steps: int = 8,                 # engine range 4-50; 8 = draft, 50 = final
    seed: int | None = None,
    first_frame: str | None = None, # workspace path, phase 2 (fl2va)
    last_frame: str | None = None,  # workspace path, phase 2 (fl2va)
) -> str
```

Builds the engine body the same way `toVideoInput` does on the frontend, posts it
through the same code path `create_video` uses, and returns a short text block:
job id, the settings as submitted, the estimated wall clock
(`steps * 44 s`), and the exact `video_status` call to make next. The model never
sees a connection UUID — the runtime resolved it.

Constraints are validated **before** submitting (clamp/reject with the reason),
because a 400 round trip through the tunnel costs more than a local check. The
engine stays the authority: its rejection text is returned verbatim when it
disagrees.

### 2.2 `video_status`

```
video_status(job_id: str, wait_seconds: int = 0) -> str   # wait capped at 300
```

Polls the gateway exactly as `video_status:251` does (terminal rows answered from
the DB, no network), sleeping in ~5 s intervals up to `wait_seconds`. On
`completed` it fetches the clip through `media_store`, copies it into the
workspace (§4), and returns the **relative path**, duration, resolution and the
job id. On `failed` it returns the engine's own failure text. Still running: the
elapsed time, the estimate, and "call again with wait_seconds=300".

### 2.3 `view_video`

```
view_video(path: str, question: str = "Describe this clip.", frames: int = 4) -> str
```

1. `ffprobe` → duration, resolution, fps, stream list.
2. `ffmpeg` → `frames` stills sampled evenly, tiled into one contact sheet under
   `.agents/video/frames/`.
3. `describe_image_bytes` (`backend/app/agents/vision.py`) → one vision call, with
   the question plus the frame timestamps so the answer can refer to them.

Returns the probe summary and the description together. It states plainly that
it **cannot hear the audio track** — MiniMax-H3 emits audio-video, and there is
no audio model in the stack; reporting the stream's presence without pretending
to judge it is the honest version. Individual frames stay on disk so the agent
can `view_image` one at full resolution.

### 2.4 Discovery

The skill body names these tools, and a skill body is not a directive — the
"anything a directive names by hand must be core" rule
(`backend/app/agents/tool_loading.py`) does not apply, and making them core would
be wrong for tools most turns never touch. The SKILL.md therefore opens with:
*if `generate_video` is not in your tool list, call `search_tools("video")` — it
is deferred, not missing.* Nothing else is needed; that cue is exactly what
`_SEARCH_TOOL_DESCRIPTION` already teaches.

## 3. Backend changes

### 3.1 `VideoRuntime`

New `backend/app/agents/video_runtime.py`, mirroring `skill_runtime.py`:

```python
@dataclass(frozen=True)
class VideoRuntime:
    connection_id: str
    connection_name: str
    model: str                 # served name of the video-capable model
    constraints: VideoConstraints   # short edge, duration range, step range
```

`load_video_runtime(session, *, include_video: bool) -> VideoRuntime | None`
returns `None` when the flag is off, when there is no connection, or when no
connection serves a video model. Resolution reuses the control-plane capabilities
join behind `non_chat_served_names` — that function currently returns only the
*excluded* names, so it needs a sibling that returns the video-capable ones
rather than a second way to ask "what does this box serve". Fails closed here
(unlike the picker, which fails open): a box we cannot classify yields no tools,
because a tool that 400s on every call is worse than an absent one.

Called from `_build_agent_and_context` (`backend/app/api/chat.py:818`) next to
`load_skill_runtime`, passed to `build_deep_agent` as a keyword, appended to the
`tools` list at `backend/app/agents/builder.py:1093` where `view_image` is added.

### 3.2 `Agent.include_video`

One boolean beside `include_skills` / `web_search`
(`backend/app/db/models.py:355`), default `False`, plus one idempotent guarded
block in `db/session.py::_apply_lightweight_migrations` (`PRAGMA table_info`) and
a test against a copy of a populated DB, per the migration convention. Schema +
frontend agent editor get the same checkbox treatment as the existing flags.

### 3.3 `fl2va` (multipart) in `create_video`

Per the module docstring, a first/last-frame submission is `multipart/form-data`
with the model named in the query string rather than the body. **Verify the exact
field names against the running engine before building** — the docstring is the
only source here, and guessing the shape is how the frontend ended up offering
four resolutions that were a guaranteed 400.

`create_video:189` grows a branch: when the request carries frame images, send
multipart; otherwise the existing JSON path, byte-identical. The row still stores
the logical request as JSON (frames recorded as their media ids / paths, not
inlined bytes) so history and "reuse" keep working.

### 3.4 What does not change

`video_status`, `cancel_video`, `video_content`, the media store, and the Video
page all stay as they are. Agent-submitted jobs are ordinary `VideoJob` rows and
show up in the page's history for free — which is a feature: the operator sees
what the agent made, with the settings it used.

## 4. Where clips live

```
<workspace>/.agents/video/
  .gitignore          # "*" — written on first materialize
  gen/<slug>-<job>.mp4    # raw generations, never edited in place
  frames/                 # view_video contact sheets and stills
```

`.agents/` is the established convention for agent-owned workspace state
(`.agents/plan/PLAN-<slug>.md`). The self-ignoring `.gitignore` matters: a
workspace is usually a git repo, and mp4 blobs would flood the git panel and the
tree decorations. Deliverables the user asks to keep go wherever the user names
them, explicitly, and are the only video artifacts that should ever be
committed — the skill says so.

Materialization is a **copy**, not a hardlink. Clips are single-digit MB, and a
hardlink shares fate with the cache the store exists to protect. If the same job
is materialized twice the existing file is reused (same content hash).

## 5. The skill

One folder in the catalog, `video-production`, marked global. Everything the
tools deliberately do not do:

- **Preflight.** `ffmpeg -version` / `ffprobe -version` before anything else,
  with `brew install ffmpeg` as the remedy. Loud failure, never a silent one.
- **Cost discipline.** The 44 s/step table: draft every shot at 8 steps
  (~6 min), review, and confirm with the user before any 50-step run (~35 min).
  Reuse the seed between draft and final so the final is the same shot, sharper.
- **The workflow.** Shot list first (each shot ≤ 15 s, with its own prompt) →
  generate drafts → `view_video` each → regenerate the failures → assemble →
  `view_video` the assembly → deliver.
- **Continuity.** How to pull the last frame of shot N
  (`ffmpeg -sseof -0.1 -i in.mp4 -frames:v 1 last.png`) and feed it as
  `first_frame` of shot N+1. This is the whole reason §3.3 exists.
- **ffmpeg recipes**, each with the trap that makes it fail:
  - trim by stream copy (`-ss`/`-to` before `-i`, `-c copy`) and the keyframe
    caveat that forces a re-encode when the cut must be frame-exact;
  - concat demuxer vs `filter_complex`: H3 output carries **audio**, so `-c copy`
    concat only holds when every clip shares codec, resolution, fps and sample
    rate — mixed sources re-encode or they desync;
  - `xfade` + `acrossfade` for transitions (and why the offset arithmetic is
    where people get it wrong);
  - scale/pad to a target aspect without stretching;
  - `drawtext` with a real macOS font path;
  - loop / boomerang / speed ramps;
  - muxing a music bed and ducking under it;
  - poster frame, GIF, and `-movflags +faststart` for anything served over HTTP.
- **Long encodes use `run_in_background`.** Plain `execute` is killed at 120 s
  (`backend/app/agents/deduping_backend.py:103`) — the same rule the dev-server
  directive already teaches, for the same reason.
- **Verify every edit.** `ffprobe -show_streams` afterwards; assert the duration
  and stream count are what was intended. An encode that "succeeded" into a
  0-byte file is the classic silent failure here.

Authoring it in Skill Studio means the skill can be written and tested through
the ordinary workspace surface, with no packaging step.

## 6. ffmpeg is a real dependency

It is not bundled and not declared anywhere today. Two moves, both small:

1. `depends_on formula: "ffmpeg"` in `packaging/homebrew/lursor.rb.template`
   (the cask is not live yet — `docs/DISTRIBUTION.md` — so this lands ahead of
   the tap rather than as a change to a shipped artifact).
2. The skill's preflight as the fallback for every install that is not brew.

Do **not** vendor a binary: ~80 MB, and the licensing question (GPL vs LGPL
builds, encoder patents) is not one this project should be answering to ship a
convenience.

## 7. Orphaned jobs

Nothing advances a job server-side. The browser polls (`useVideoJobSync`, 5 s per
active job); the backend only refreshes a row when someone asks. An agent that
submits and is then stopped leaves a row stuck at `queued` forever while the box
happily finishes the render — a silent stall, which §7's "no silent caps" rule
rules out.

Cheapest honest fix: refresh non-terminal rows inside `list_videos:172`, bounded
to the active ones, so opening the Video page reconciles reality. The fuller fix
is a poll loop modelled on `preview_service._poll_loop`
(`backend/app/agents/preview_service.py:188`), which also lets a scheduled
overnight run finish its own clips. **Recommend the `list_videos` refresh in
phase 1 and the loop only if agent-submitted jobs prove to be routinely
abandoned.**

## 8. UI

Deliberately almost nothing:

- One checkbox in the agent editor for `include_video`, worded with the cost
  ("generation runs for minutes on the connected box"), following the existing
  capability toggles exactly.
- The Video page needs no change. Agent-submitted runs appear in its history
  already. A later nicety: show which thread submitted a run — that needs a
  `thread_id` column on `VideoJob` and is not required for any of the above.

Standard rules apply to both: semantic text colours only, no `container`, no
emoji.

## 9. Tests

Backend, offline, following `backend/tests/test_videos.py` — which already has the
right harness (`_patch_gateway:232` swaps in a handler, so no network and no box).

- `test_video_tools.py` — submit returns a job id and an ETA; bad constraints are
  rejected locally with the reason; a gateway 400 is surfaced verbatim; a
  completed poll materializes the clip into `.agents/video/gen/` and returns a
  relative path; `.gitignore` is written once; a second materialize of the same
  job does not duplicate the file; every failure path returns `"Error: ..."`
  rather than raising.
- `test_video_runtime.py` — no flag → no tools; flag but no connection → no
  tools; connection with only chat models → no tools; unclassifiable box → no
  tools (fails closed, unlike the picker).
- `test_videos.py` gains the `fl2va` multipart case alongside the JSON one.
- `test_video_migration.py` — `include_video` applied idempotently against a copy
  of a populated DB.
- `view_video` is tested with ffmpeg **skipped if absent** (`shutil.which`), so
  CI without ffmpeg stays green and says why.

The bar is `uv run pytest` green without editing existing tests.

## 10. Out of scope

- Bundling ffmpeg (§6).
- A timeline / NLE UI. The workspace file tree plus the preview panel is the
  review surface.
- Audio understanding. `view_video` reports that an audio stream exists and stops
  there.
- Video providers other than laios. The tool signature is provider-neutral, so a
  second backend is additive later.
- Generating video from the chat composer directly (no tool call). Nothing needs
  it and it would duplicate the Video page.
- Long-form: the skill assembles clips; it does not do scripting, voiceover or
  captioning.

## 11. Order of work

1. **§3.3 `fl2va` multipart** — verify the engine's field names first. Highest
   leverage, smallest diff, independently useful from the Video page.
2. **§3.1 + §3.2** `VideoRuntime`, the agent flag and its migration.
3. **§2.1 + §2.2** `generate_video` / `video_status` incl. workspace
   materialization (§4).
4. **§2.3** `view_video`.
5. **§5** the skill, authored in Skill Studio.
6. **§6 + §7** cask dependency and the `list_videos` refresh.
7. **§8** the agent-editor checkbox.

Steps 1-4 are testable offline against the fake gateway; step 5 needs a real box
to be worth anything.

## 12. Open questions

1. **`fl2va` field names.** Docstring only. Needs one real request against the
   engine before §3.3 is written.
2. **Does H3 accept a `last_frame` alone**, or only first, or both? Determines
   whether continuity is "continue from here" or "get from A to B".
3. **Default step count for an agent-initiated draft.** 8 mirrors the recipe's
   smoke test, but an agent generating six shots at 8 steps is still ~36 minutes
   of box time. Should the skill require confirmation before the *first*
   generation of a session rather than only before finals?
4. **Should `include_video` default on when a video-capable connection exists?**
   Off is the safer default and matches `web_search` / `include_memory`; on would
   mean nobody has to discover the checkbox.
