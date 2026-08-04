# Upstream patches — ready to submit, not submitted

Fixes that belong in a dependency rather than in this repo. Each one is a diff
against that project's HEAD plus the PR text to go with it. **We do not open pull
requests on repositories we do not own** — these are prepared so a human can
submit them under their own identity, or so we can carry them as a local patch if
upstream declines.

| Patch | Target | Verified against | Status |
| --- | --- | --- | --- |
| [`hashline-anchors.patch`](hashline-anchors.patch) | [`vstorm-co/pydantic-ai-backend`](https://github.com/vstorm-co/pydantic-ai-backend) | `058b8aa` (2026-08-03) | not submitted |
| [`laios-video-profile.patch`](laios-video-profile.patch) | [`cgrohman/laios`](https://github.com/cgrohman/laios) | `7ffe860`, branch `feat/minimax-h3-video` (2026-08-03) | not submitted |

## hashline-anchors.patch

Findings 1, 2, 3, 8 and 9 of [`../FILE-EDITING-AUDIT.md`](../FILE-EDITING-AUDIT.md),
in the layer that owns them. Findings 1 and 6 are *also* worked around locally
(`backend/app/agents/file_editing.py`) because we needed them before upstream
moves; the rest cannot be fixed from outside the dependency without owning the
edit format, which §5 of the audit argues against.

Verified, not just written:

```
git clone https://github.com/vstorm-co/pydantic-ai-backend
cd pydantic-ai-backend && git checkout 058b8aa
git apply /path/to/hashline-anchors.patch
uv sync --all-extras
uv run pytest -q     # 1578 passed, 18 deselected
uv run ruff check src tests && uv run ruff format --check src tests
```

The five upstream tests that encoded the old contract (`test_end_hash_optional`,
`test_whitespace_matters`, the two hash-width assertions) are updated in the same
diff, with new cases for each property added.

---

## PR text

**Title:** `fix(hashline): make line anchors survive reindentation, and validate both ends of a range`

**Body:**

Five related problems with the hashline edit format, all reproducible against
`main`. Each hunk is independent — happy to split into separate PRs if you prefer.

### 1. `end_hash` is optional, so a range edit validates one end only

`apply_hashline_edit_with_summary` skips the end-anchor check entirely when
`end_hash` is `None`:

```python
original = "".join(f"line{i}\n" for i in range(1, 8))
drifted = original.replace("line4", "IMPORTANT_NEW_CODE")

apply_hashline_edit_with_summary(
    drifted, start_line=2, start_hash=line_hash("line2"),
    new_content="replacement", end_line=4, end_hash=None,
)
# -> ('line1\nreplacement\nline5\nline6\nline7\n', None, 'Replaced 3 line(s) with 1 line(s) at line 2')
```

A model that read lines 2-4, then had line 4 change underneath it, destroys the
new content and gets `error=None`. This is the one path that corrupts 100% of the
time under drift — `str_replace` validates the whole span by construction, so
this is a regression relative to the format it replaces.

The patch requires `end_hash` whenever `end_line` is given, with an error that
says why. `test_end_hash_optional` becomes `test_end_hash_is_required_with_end_line`.

### 2. The hash covers indentation, so a formatter invalidates every anchor

```python
line_hash("  return 1")    # '6e'
line_hash("    return 1")  # 'dc'
```

Prettier-on-save, Black, gofmt — any of them, on any line, and the model's
anchors are stale even though the code it read is unchanged. Whitespace-insensitive
anchoring is the format's selling point ("eliminating whitespace-matching errors",
per the module docstring), and every other hashline implementation we could find
hashes trimmed content for exactly this reason.

The patch strips before hashing. Interior whitespace still counts (`a b` ≠ `ab`).

### 3. Two hex characters is 256 buckets

Measured false-pass rate for an unrelated real-looking line: **0.365%** (theory
1/256 = 0.391%), i.e. roughly 1 stale edit in 275 applies to the wrong content
with no error at all. Trimming (2) removes indentation as a distinguishing
feature, which pushes that the wrong way, so the two changes belong together.

The patch widens to 4 characters (1 in 65536) for two more tokens per line, and
adds `hash_matches()`, which compares on the shorter of the two lengths — so a
2-character anchor a model is already holding still validates after the upgrade
rather than failing its next edit.

### 4. CRLF files get mixed line endings

`_split_lines` splits on `\n` only, so line 2 of a CRLF file is `beta\r`: the
model is asked to hash an invisible character, and anything it writes lands with a
bare LF between CRLF neighbours.

```python
apply_hashline_edit("alpha\r\nbeta\r\ngamma\r\n", 2, line_hash("beta\r"), "BETA")
# -> 'alpha\r\nBETA\ngamma\r\n'
```

The patch strips `\r` before hashing and rejoins with whatever ending the file
already used.

### 5. One undecodable byte is replaced file-wide by any edit

`hashline_edit` reads with `errors="replace"`, edits the decoded text, then writes
the *whole file* back — so every byte that could not be decoded is replaced on
disk, including bytes nowhere near the edit:

```python
# file: b'header\n\xff\xfe payload\ntail\n', edit line 1
# after: b'HEADER\n\xef\xbf\xbd\xef\xbf\xbd payload\ntail\n'
```

The patch refuses to edit a file that is not valid UTF-8 and says to use
`execute()` instead, rather than silently corrupting the part it cannot represent.

### Compatibility

- (1) is a behaviour change: a caller passing `end_line` without `end_hash` now
  gets an error instead of a half-validated edit. That is the point, but it is the
  one hunk that could break a caller relying on the old shape.
- (2) changes hash *values*. An anchor computed over untrimmed content will not
  match after the upgrade; the affected edit fails safe (mismatch error, re-read)
  rather than applying wrongly.
- (3) is backward compatible via `hash_matches()`.
- (4) and (5) only change behaviour for files that were already being handled
  wrongly.

### What is not here

The error on a mismatch is still `File may have changed — re-read it first`, with
no fresh anchors and no proximity search, so every miss costs a full re-read of
the file — which is the token saving the format is sold on. That is a larger
change and a separate conversation; we currently do it in a capability on our
side and would be glad to contribute it if you want it in the library.

---

## laios-video-profile.patch

Two changes a client of `/v1/videos` cannot make for itself. Both found while
building Lursor's agent-facing video tools against a real box (`AGENTS.md` §6).

Verified, not just written:

```
git clone git@github.com:cgrohman/laios
cd laios && git checkout 7ffe860        # feat/minimax-h3-video
git apply /path/to/laios-video-profile.patch
cargo check -p laios-core -p laios-daemon -p laios-gateway    # clean
cargo test -p laios-core --lib          # 112 passed (110 existing + 2 new)
cargo test -p laios-gateway             # passed
```

---

## PR text

**Title:** `feat(video): declare a model's request shape, and stop 413-ing keyframe submissions`

**Body:**

Two problems that only show up once something other than a curl one-liner drives
`/v1/videos`. Independent hunks; happy to split.

### 1. `POST /v1/videos` rejects a legitimate first/last-frame submission

`create_video` buffers with `body: axum::body::Bytes`, which inherits axum's
`DefaultBodyLimit` of **2 MiB**. An `fl2va` request inlines its keyframes in the
JSON body as base64 `data:` URIs — which is the only transport available to a
client that is not running on the box, since a `file://` path names a file the
engine cannot see. Measured against a Spark serving `minimax-h3`:

```
2,090,000 byte body  -> 400 target.short_edge must be 768 ...   (reached the engine)
2,200,000 byte body  -> 413 Failed to buffer the request body: length limit exceeded
```

One 1344x768 frame is ~587 KB as PNG (~780 KB base64) and ~31 KB as JPEG, and
`fl2va` accepts **two** keyframes, so the ceiling is reachable with ordinary inputs.
The 413 names neither the frame nor the limit, so from the client side it reads as
the gateway being broken.

The patch layers `DefaultBodyLimit::max(32 MiB)` on that one route. Still bounded —
the body is held in memory before being relayed — but above what a real
two-keyframe request needs. Nothing else changes; `/v1/videos/{id}` and `/content`
are untouched.

### 2. `capabilities: [video]` says a model generates video, but not how to ask it

The capability flag is enough to keep a generator out of a chat picker. It is not
enough to *drive* one, because the request surface is per-model rather than
per-engine: MiniMax-H3 takes its own canonical body (`task` / `target` /
`conditions`), while the generic SGLang video API takes `seconds` / `size` /
`input_reference`.

Guessing wrong does not fail loudly. In SGLang, the base
`SamplingParams::lower_video_request_kwargs` is `del request; return kwargs` and
`video_request_extra_fields` returns an empty set, so a non-H3 model **silently
discards** `task`, `target` and `conditions`, then falls back to
`DEFAULT_VIDEO_SECONDS = 4` and its own default resolution. The caller pays full
GPU time (minutes) for a clip of the wrong length and aspect with its conditioning
frames ignored, and gets HTTP 200.

So today a client has exactly two options: hardcode one model, or risk that. The
patch adds an optional `video_profile` block to the recipe, carries it through the
manifest, and surfaces it on `/v1/models`:

```yaml
capabilities: [video]
video_profile:
  request_schema: minimax_h3.request/v1
  short_edge: 768
  aspect_ratios: ["16:9", "9:16", "1:1"]
  sizes:                      # what the engine returns, not what arithmetic says
    "16:9": 1344x768          # 768 at 16:9 computes to 1365; H3 snaps to 1344
    "9:16": 768x1344
    "1:1": 768x768
  duration_seconds: { min: 4.0, max: 15.0 }
  num_inference_steps: { min: 4, max: 50 }
  seconds_per_step: 44        # the only progress signal for a model that
  keyframes: true             #   reports `queued` until it is done
  audio: true
```

`request_schema` is the one field with no default: it is the difference between a
correct clip and a silently wrong one. The rest lets a client reject an
out-of-range knob locally instead of spending a tunnel round trip to learn that
`short_edge` must be 768.

Deliberately **not** inferred from the engine or the recipe id. An operator writing
a recipe already knows which body the model wants; this is where that stops being
tribal knowledge. Absent means undeclared, which a client should read as "do not
drive this automatically" rather than as permission to guess — that is how Lursor
consumes it, and the reason a video model with no profile gets no tools there
rather than a hopeful request.

### Compatibility

- Additive and optional. `#[serde(default)]` on the recipe field and
  `skip_serializing_if` on the manifest and API fields, so old recipes parse, old
  manifests load, and `/v1/models` is byte-identical for every model without a
  profile.
- `Recipe` gained a field, so the nine struct literals in the existing tests gained
  `video_profile: None`. That is the whole of the churn.
- No recipe in-tree declares a profile yet: the H3 recipe is operator-supplied
  (`~/.laios/recipes/sglang/minimax-h3-fl2va.yaml`), so the block above is what to
  paste into it.
