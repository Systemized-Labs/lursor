# laios, and media generation

Indexed from [`AGENTS.md`](../../AGENTS.md) §6.

## laios (local models)

Lursor is the **application plane**; the `laios` daemon is the **control plane**.
`api/laios.py` is a thin authenticated proxy that holds the `master_key`
server-side and forwards to the daemon's `/v1/*` API on `:7420`. All
restart/update logic lives in the daemon — Lursor stays a pure proxy. Restart is
special: the daemon dies mid-request, so a dropped connection shortly after a
`202` is expected, surfaced as `202 {restarting: true}`.

A box's *inference* gateway is a separate plane from its control plane
(`gateway_url` decouples them: LAN-side management, tunnelled model traffic), and
the two are joined in one place only — `non_chat_served_names` /
`video_served_names` read the control plane's per-recipe `capabilities` and map them
onto the gateway's flat `/v1/models` list. Same join, opposite failure policies, on
purpose: the chat picker **fails open** (a box we cannot classify shows all its
models rather than none), the video tools **fail closed** (no classification means
no tools, because a tool that 400s on every call is worse than an absent one).

`api/laios.py`'s inventory join is shared: `_served_with_capability(conn, capability,
profile_key=...)` with `video_served_models` / `image_served_models` as wrappers. Of
the ~50 lines, three differ — the `running_instance.status == "running"` check in
particular is a subtlety worth getting right only once.

## Three media sources, chosen in Settings

Images and clips are generated on **one of three sources**, picked app-wide in
Settings → Image & video and stored on `AppConfig.{image,video}_{source,model}`:

* **`laios`** — a connected box, through its inference gateway. Free at the point
  of use, seconds for an image and minutes for a clip, and the source that every
  install used before this setting existed (NULL means `laios`, so an upgrade
  changes nothing).
* **`openrouter`** — `POST /api/v1/images` (synchronous, base64 + an exact cost)
  and `POST /api/v1/videos` (202 + polling). `GET /images/models` and
  `/videos/models` are capability catalogues, which is what a hosted model has
  instead of a laios recipe's `video_profile` block. All of it lives in
  `app/media/openrouter.py`; `app/media/refs.py` owns the string grammar
  (`openrouter:{slug}`, `laios:{cid}:{served}`, `custom:{provider}:{model}`), which
  deliberately mirrors chat's `openrouter:` / `custom:` convention — and for
  `custom:` it is the *same* `CustomProvider` row on both sides.
* **`custom:{provider_id}`** — a user-added OpenAI-compatible endpoint, the one the
  chat picker already routes to. Structurally it is the laios path with a different
  client: the same `/v1/images/generations` and the same `/videos` job API, so
  `videos._endpoint` hands back either and everything above it is shared. Two things
  are its own, both in `app/media/custom.py`:

  * **Modality has to be recovered, because `/models` does not carry it.** Four
    layers, most authoritative first: a `POST {}` route probe (`404`/`405`/`501`
    means there is no images/videos API here at all — nothing is generated and
    nothing is billed by an empty body), then LiteLLM's `/model/info` `mode`, then
    modality fields on the `/models` entry, then the model id itself. A model
    matched only by its name carries `declared: false`, and every surface says "by
    name" rather than stating a guess as a fact. The escape hatch when all four
    miss is an `image:` / `video:` prefix in the provider's manual model list,
    which is excluded from the chat list so tagging one cannot pollute the chat
    picker.
  * **Video is driven as `sglang.video/v1` without a declaration**, which is exactly
    what the laios path refuses to do. The difference is who decided: a box serves
    what it serves, while a custom provider is a URL somebody typed in and pointed
    at a video API on purpose. Every constraint is left *unconstrained* so nothing
    is validated against another model's numbers.

  Providers auto-managed by a laios connection are excluded (`media_providers`) —
  they point at the same box's gateway, so offering them would list every served
  model twice and submit to one GPU by two routes.

**The source never falls back**, and this is the invariant the feature rests on.
If the configured one cannot serve, `resolve_image_target` / `resolve_video_target`
return `None` plus a sentence naming the source — they never quietly use the other.
Crossing would be silent in both directions and wrong in both: onto OpenRouter it
spends money nobody authorised, onto a box it swaps a chosen model for a different
one. A **pinned model that has gone missing fails the same way**; "Auto" is the
setting for anyone who wants the resolver to choose. Every "no" therefore ships
with a reason, and the same string is shown by the Settings card, the Image/Video
pages and the agent editor's capability hint — one state, one sentence.

Consequences worth knowing before touching any of this:

* **Routes are keyed on a source ref, not a connection id** (`/media/images`,
  `/media/videos`). An OpenRouter generation has no connection, run ids were
  already uuids, and content URLs now carry no source at all. `?source=` filters
  the history; omitting it returns everything, on purpose — switching sources must
  not empty the gallery.
* **`connection_id` is `""`, not NULL, for an OpenRouter row**, and holds the
  *custom provider* id on a `custom:` one. It was never a real foreign key, and
  SQLite cannot relax NOT NULL without rebuilding the table. Two id spaces share
  the column, which is safe only because `provider` is always read with it — see
  `videos._refresh_active`, which keys its grouping on the pair.
* **`AppConfig.{image,video}_source` is a free-form ref, not an enum.** The custom
  form carries an id no `Literal` can enumerate, so `set_media` validates by running
  every value through `refs.parse_source` and returning the parser's own sentence.
* **A hosted clip is downloaded eagerly**, on the poll that first sees
  `completed`, because `unsigned_urls` expire. That is the opposite of the laios
  path's deliberate laziness, and the reason is that a clip somebody paid for must
  not become unreachable because they closed the tab. `content_url` stays on the
  row as the retry handle.
* **OpenRouter has no video cancel.** `cancel_video` marks the row locally and
  says plainly that the render continues and will still be billed.
* **A catalogue fetch that fails reuses the last good one** (the `pricing.py`
  shape). With no fallback by policy, a transient blip that emptied the catalogue
  would read as "OpenRouter cannot generate" and stop generation entirely.
* **`_GATEWAY_BODY_LIMIT` is a fact about one axum server**, not about video, so
  the keyframe budget is chosen per source (`video_tools._body_limit`).
* **The `image_tools` lock is GPU contention, not rate limiting** — one box cannot
  run three renders at Qwen's 58.5 GB peak. It is skipped for OpenRouter, where
  serialising would triple the latency of "give me three variations".
* **Pricing is uneven, and that is the API's shape.** Video models publish
  `pricing_skus`, so a per-second floor is derivable and shown up front. Image
  models publish **no** catalogue price — it sits behind a per-model `/endpoints`
  call and is quoted per output *token* — so the only honest number is the mean of
  what past runs actually cost (`app/media/history.py`), and where there is none,
  nothing is shown rather than `$0.00`.

## Video generation

`api/videos.py` drives the job API of whichever source is configured: submit,
poll, cancel, download-once into the content-addressed media store. The rest of
this section is the **laios** half; the hosted half is above. It **does not invent a
request shape** — the body is relayed as sent, so a new engine knob works here the
day it works there. MiniMax-H3 is the only `capabilities: [video]` recipe today:
~44 s per denoise step (8 steps ≈ 6 min, 50 ≈ 35), `short_edge` fixed at 768,
4-15 s clips, and audio-video out in one mp4.

`fl2va` (first/last-frame conditioning) is **not** multipart, despite what an early
docstring guessed. It is the same JSON body plus `conditions: [{type: "image", uri,
role: "keyframe", frame_index}]`, where `frame_index` is `0`, `-1`, or both in that
order, and `uri` may be a `data:` URI — which is the only transport that works from
an off-box Lursor, since a path would name a file the engine cannot see. The
inlined base64 is stripped from the *stored* row (`_storable_request`): the pixels
are the one part of a submission nothing here needs to keep, and the history list
reads `request` on every poll.

Two measured numbers that are not in any doc and are invisible until they bite:

1. **The gateway caps a request body at 2 MiB** (axum's `Bytes` extractor default;
   2,090,000 bytes went through, 2,200,000 got `413 Failed to buffer the request
   body`). A keyframe is base64 in that body — a real 1344x768 frame is 587 KB as
   PNG against 31 KB as JPEG, and an incompressible one is 2.9 MB, so PNG is the
   format that gets you near the edge rather than one that always fails.
   `generate_video` checks the *assembled* body, not each frame (two keyframes share
   the budget), and answers with the `-q:v 3` JPEG remedy. The upstream patch raises
   the limit on that one route.
2. **The delivered duration is not the requested one.** The engine aligns frames to
   17n+5 at 24 fps, so `duration_seconds=4` returns a 4.5 s clip. Every fade/concat
   calculation must come from `ffprobe`, never from what was submitted.

**Which model, and how to ask it** — on a box. (None of this applies to
OpenRouter, and the difference is not that the strictness was relaxed: its
catalogue *is* the declaration, so there is nothing left to classify and one
builder drives every model behind it.) `capabilities: [video]` says a model
generates video; it says nothing about the request shape, and the shape is per-model rather
than per-engine — H3 takes `task`/`target`/`conditions`, the generic SGLang video API
takes `seconds`/`size`/`input_reference`. Guessing wrong does **not** error: SGLang's
base `lower_video_request_kwargs` is `del request; return kwargs`, so a non-H3 model
discards the fields it does not know, falls back to `DEFAULT_VIDEO_SECONDS = 4` and
its own resolution, and returns HTTP 200 — full GPU time for a clip of the wrong
length with its keyframes ignored. Silent wrong output, which is worse than any 400.

So the model declares its shape, in the recipe's `video_profile` block surfaced on
the control plane's `/v1/models` (prepared upstream:
[`../upstream/laios-video-profile.patch`](../upstream/laios-video-profile.patch)).
`video_runtime.py` resolves in that
order: a profile naming a schema we implement → drive it with the profile's own
ranges; no profile but the model *identifies* as MiniMax-H3 → drive it as H3 with
the measured defaults and mark the runtime `assumed`; anything else → **no tools**,
logged. H3 is grandfathered because it predates the block and is the only video
recipe in the wild; requiring a declaration would turn a working box off.

A profile's missing fields leave that knob *unconstrained* rather than inheriting
H3's, or a 5-second-max model would accept 15 and fail on the box. `GET
/video/capability` reports the outcome for the agent editor, because a toggle that
silently does nothing is indistinguishable from a broken one. Model choice among
several is still first-connection, alphabetically-first — correct by accident while
H3 is the only one.

Agents reach it through four deferred tools (`agents/video_tools.py`):
`generate_video` (submit, never wait — a 35-minute tool call makes a run look hung),
`video_status` (poll with a **bounded** wait, then materialize the clip into
`<workspace>/.agents/video/gen/` because ffmpeg and `read_file` live inside the
workspace and the media store does not), `cancel_video` (a wrong render otherwise
holds the GPU for its full estimate), and `view_video` (ffprobe + a tiled contact
sheet + one vision call — and it says plainly that it cannot hear the audio track).
Gated on `Agent.include_video` (default off; a clip is minutes of someone's GPU) plus
a resolved `VideoRuntime`. A subagent inherits the parent's runtime — it has no
session to resolve one with — but only when its own `include_video` is on, so a
video-enabled agent does not silently hand every specialist a GPU.

An agent with both capabilities can also draw an opening still with `generate_image`
and hand it to `generate_video` as a `first_frame` — the image tool's docstring says
so, but only when video is actually available, and it asks for JPEG because a
photographic 1024px PNG exceeds the gateway's inlined-keyframe budget.

Everything ffmpeg — trim, concat, xfade, captions — is the `video-production` skill
instead, because a tool is only justified when the work needs a credential, a DB row
or app state, and ffmpeg needs none of the three. **ffmpeg is a real dependency**
(declared in the cask template, checked by the skill's preflight) and is deliberately
not vendored. Homebrew's formula ships without libfreetype, so `drawtext` is absent
there; the skill carries an `overlay` fallback. `scripts/verify_video_tools.py` is the
one check that needs a real box, and is a script rather than a test for that reason.

Nothing advances a job server-side, so `list_videos` reconciles every non-terminal
row on the way out. Without it an agent that submits and is then stopped leaves a row
at `queued` forever while the box finishes the render — a silent stall.

## Image generation

`api/images.py` + `pages/image/` drive the image surface of whichever source is
configured (see above); the rest of this section is the **laios** half. It reads
like the video page and is architecturally the opposite, because **the image API is
synchronous**: one POST returns the pixels, so there is no job id to bind, nothing to
poll and nothing to cancel. Two `capabilities: [image]` recipes today, and they are
*not* interchangeable — `z-image-turbo` (6B, distilled to 9 steps, no CFG) is ~6.5 s
an image; `qwen-image-2512` (20B) is 58 s at 25 steps and 116 s at 50, because its
default `negative_prompt` is `" "` (a space, not None) which switches CFG on and runs
the transformer twice per step. ~37× the cost for better glyphs, which measured
head-to-head is a narrower win than its reputation.

**The wait lives on the backend, not in the browser.** `create_image` writes the row,
hands the gateway call to an `asyncio` task and returns `201` immediately; the page
polls the row. Holding the request open would be a truer relay and would lose two
minutes of someone's GPU to any reload. The cost of that choice is orphans: a
`running` row is only meaningful while this process holds a task for it, so
`_reap_orphans` fails any `running` row absent from the `_active` map on the next
read. That map — not a timeout heuristic — is what makes the repair exact, and it is
why the backend being single-process is load-bearing here.

Two fields are **not** relayed on the laios path, against the video module's strict
pass-through stance (and are absent from the OpenRouter body, which rejects them):
`response_format` is forced to `b64_json` (the engine's `url` default returns a
relative `/v1/images/{id}/content` whose bytes live in the container and die with it,
so a durable history is impossible on that path), and `n` is pinned to 1 (one row,
one `media_id`). Everything else is the engine's schema, relayed as sent.

The stored MIME is **sniffed from the bytes**, never taken from `output_format` — that
field is a request the engine may ignore, and a `b64_json` payload carries no content
type, so trusting it mislabels the file the browser is later handed. Fixing this
surfaced a latent bug in `media_store`: `_MIME_BY_EXT` is built by inverting
`_EXT_BY_MIME`, where two types map to `.jpg`, so every served jpeg — chat attachment
included — was labelled `image/jpg`, which is not a real type. Now overridden
explicitly rather than by dict order.

Per-model knobs live in `pages/image/image-settings.ts` as a table keyed on served
name, **not** in a recipe block like video's `video_profile`. The distinction is
real: video needed a declaration because H3's request *shape* is unlike any other
engine's and guessing returns HTTP 200 with silently wrong output. Here both models
take the same fields and only the sensible *values* differ, so a table is enough — and
an unrecognised image model still works, it just gets conservative defaults and no
time estimate rather than a confident wrong one. Switching model deliberately resets
steps and guidance: 9 steps is right for a distilled turbo checkpoint and undercooked
on Qwen, so a number that is right for one is wrong for the other.

That table is also why the backend can have a profile table of its own
(`agents/image_runtime.py`) without a recipe declaration to read: the two halves
answer different questions — the frontend's drives sliders, the backend's drives
validation ranges and a tool docstring — and the only field where drift produces a
wrong *request* rather than a worse estimate is `guidance`, which is pinned by test
on both sides.

The page stays in the ⋯ menu rather than pinned to the rail beside Video, by Video's
own argument for being pinned: you leave a clip and come back to it, while an image
finishes while you watch.

Agents reach it through one deferred tool (`agents/image_tools.py`): `generate_image`,
which submits, **waits**, copies the file into `<workspace>/.agents/image/gen/` and
returns the path. That is the deliberate opposite of `generate_video`, and the reason
is latency, not taste — 6.5s (or worst case ~116s) is inside the range where waiting
is simply the better interface, so there is no job id for the model to carry, no poll
tool and no half-finished state to explain. Gated on `Agent.include_image` (default
off) plus a resolved `ImageRuntime`, with the same subagent double opt-in as video.
There is no `cancel_image`: neither source offers one on its image API, so a
submitted generation always runs to completion. There is no `view_image` either — every agent
already has one.

**The tool is not enough on its own, and this cost a round trip to learn.** An agent
with `include_image` on, `generate_image` sitting in its roster next to `execute`, and
a box serving z-image was asked for an image — and ran `curl` against
`image.pollinations.ai` instead. The prompt left the machine for a third party, the
user's own GPU stayed idle, and nothing landed in the media store, the Image pane or
Artifacts. A tool description does not beat a model's prior about how a job is
normally done, especially under a software-engineering persona where `execute` is the
reflex. So `IMAGE_GENERATION_DIRECTIVE` (`agents/builder.py`) states the preference
and **names the wrong path explicitly** — "use X" is much weaker than "use X, never
Y" — closing both the external-API route and the draw-it-in-code route, while leaving
charts-from-data alone. It is gated on the resolved runtime, not on the flag: telling
an agent to use a tool it does not have is the same class of bug. This is the third
directive of its kind, after `DEV_SERVER_DIRECTIVE` and `BROWSER_QA_DIRECTIVE`; any
future capability a model won't reach for unaided needs one too.

Generated media is also **browsable in the file tree**, which needed a change to
`api/files.py`: `.agents/` is hidden wholesale, and the old plan-shaped exception
only understood one subtree. `_VISIBLE_AGENT_SUBDIRS` now lists
`.agents/{plan,image/gen,video/gen}`, and `_tree_hidden` un-hides *ancestors* of a
visible subtree as well as its contents — without that the tree, which is walked one
level at a time, never asks about `.agents/image/gen` because `.agents/image` was
hidden, and `.agents` renders as an expandable folder containing nothing. Only the
`gen/` folders: `.agents/video/frames/` is contact-sheet stills the agent
regenerates at will, and each folder's `.gitignore` is plumbing.

Three consequences of waiting, each handled rather than hoped away. The wait is capped
at 240s and the render **is not cancelled** when it expires, so the message says so; a
timed-out run is remembered and delivered by the next call, because with no run id
there would otherwise be no way back to an image the agent paid for. And calls to one
box are serialised behind a per-connection lock: pydantic-ai runs the tool calls in one
model response concurrently, "three variations" is the obvious prompt, and two renders
on one GPU is slower for both and at Qwen's 58.5 GB peak can be fatal for both. Queue
time is deliberately not charged against the wait budget.

`agents/image_runtime.py` **fails open** where `video_runtime.py` fails closed, and the
asymmetry is the most load-bearing decision here. Video refuses to drive an undeclared
model because the request shape is per-model and guessing returns HTTP 200 with a
silently wrong clip; images share one request surface, so an unrecognised model still
gets the tool with conservative defaults and no time estimate. Video's worst case was a
wrong render, this one's is a mediocre default. Both still fail closed on
*reachability* — an unreachable control plane means no tool either way. The runtime
also resolves *every* serving model rather than one, with the fastest as the default
and `model=` to override, because z-image and qwen differ ~20x in wall clock and the
choice between them is a real tradeoff the agent is better placed to make.
