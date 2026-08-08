# File editing audit — August 2026

How Lursor's agents read and modify files, measured against industry harnesses
(Claude Code, Anthropic's text editor tool, Aider) and against the reference
implementations of the edit format we actually ship.

Method: every finding below was reproduced by calling
`pydantic_ai_backends.hashline` the way our stack calls it —
`read_bytes` → `decode("utf-8", errors="replace")` → apply → `write(whole text)`
— not inferred from reading the source. The probe script is reproduced in §7.
Upstream claims were checked against the dependency's HEAD, not its changelog.

## 1. What we run

`create_deep_agent` is called at `backend/app/agents/builder.py:1261` with no
`edit_format`, so we inherit pydantic-deep's default of `"hashline"`
(`pydantic_deep/spec.py:96`). The console toolset is built by the library
(`pydantic_deep/agent.py:408-415`), not by us: we pass no `descriptions`, no
`document_support`, and no `interrupt_on`, so the effective config is
`image_support=True`, `document_support=False`, no write approval.

The choice is implicit. A row's `extra_config` (`builder.py:1072`) can flip
`edit_format` to `"str_replace"` and silently change which tools exist.

| Tool | Shape |
| --- | --- |
| `read_file` | `{line}:{hash}\|{content}`, `limit=2000` lines, images returned as `BinaryContent` before tagging |
| `write_file` | whole-file overwrite, creates parents |
| `hashline_edit` | `start_line`+`start_hash`, optional `end_line`/`end_hash`, `new_content`, `insert_after`; `new_content=""` deletes |

The hash is the first 2 hex chars of the line's MD5, computed over the raw line
including indentation (`hashline.py:38-50`). There is no `edit_file` in our
build — hashline mode registers `hashline_edit` instead.

Safety model: the hash *is* the staleness check. The fingerprint cache
`str_replace` mode uses (`_edit_staleness_error`) never runs, so the
`_record_read` call on the hashline read path (`console.py:678`) is dead weight.
`hashline_edit` holds a per-path `asyncio.Lock` (`console.py:772`) keyed on the
backend instance; since one `LocalBackend` is shared per workspace, that lock
spans concurrent runs, which is correct. `write_file` does not take it.

## 2. Where the industry is

Three different bets:

| Harness | Bet | Compensating machinery |
| --- | --- | --- |
| Claude Code | exact-string `Edit`, unique `old_string` or `replace_all` | harness-level read-before-edit **enforcement**, file-state tracking so no verification re-read is needed, `LSP` diagnostics tool, post-edit hooks, `NotebookEdit`, PDF/notebook reads |
| Anthropic text editor tool | `view` / `str_replace` / `create` / `insert` | `view_range`, `insert_line`, `max_characters` truncation; docs recommend app-level backups before edits |
| Aider | `whole` / `diff` / `udiff` | diff formats far more token-efficient; `whole` more stable across multi-turn |

Notably, the hashline proposal was filed against Claude Code as issue #25775 and
**closed as "not planned"** — the market leader deliberately made the opposite
bet and pays for it with harness-layer guarantees instead.

The hashline research is nonetheless real and strong. Can Bölük's *The Harness
Problem* (Feb 2026) benchmarked 16 models x 180 tasks x 3 runs changing only the
edit tool: Grok Code Fast 1 went 6.7% → 68.3%, average +15pp, with large
output-token reductions from eliminated retry loops. Two caveats bear directly
on us:

- An independent replication found hashline **worse** than `str_replace` on
  Python (70% vs 95%), neutral on TypeScript, mixed on Rust — hypothesising
  significant whitespace as the cause, and noting that the original benchmark
  included **LSP validation feedback** as a likely confound. Small n, not
  rigorous, but pointed at the two things we get wrong.
- The reference implementations have moved past what we ship. oh-my-pi's current
  hashline mode uses a file-level snapshot tag, **mandatory** range end anchors,
  **multiple hunks batched in one patch** with non-shifting line numbers, no-op
  detection and structural repair heuristics. A third-party port documents a
  **4-char hash over trimmed input** — "whitespace-insensitive anchors;
  indentation changes don't break edits" — plus proximity search when lines
  shift. Implementations disagree on the algorithm (MD5 vs CRC32) but converge
  on trim-before-hash and at least 4 hex chars.

That convergence is the crux: **whitespace-insensitivity is the entire selling
point of the format, and our version does not have it.**

## 3. Findings

Ranked by severity. Every row reproduced; §7 has the script.

| # | Severity | Finding |
| --- | --- | --- |
Status added after implementation (§7): **fixed** = closed in this repo,
**patch** = fixed in the ready-to-submit upstream diff, **open** = left alone.

| # | Severity | Status | Finding |
| --- | --- | --- | --- |
| 1 | high | fixed + patch | `end_hash` is optional, so range edits validate one end only — silent destruction under drift |
| 2 | high | patch | hashes include indentation, so any formatter run invalidates every anchor |
| 3 | medium | patch | 2-char hash (256 buckets) where reference implementations use 4 |
| 4 | high | fixed | nothing stops `write_file` clobbering a file the agent never read |
| 5 | medium | fixed | no post-edit validation of any kind |
| 6 | medium | fixed | mismatch recovery is a dead end — no fresh anchors, no proximity search |
| 7 | low | open | one hunk per call; no batching |
| 8 | medium | patch | CRLF files get mixed line endings |
| 9 | medium | patch | non-UTF-8 bytes destroyed file-wide by any edit |
| 10 | medium | open | `read_file` has no character cap on the hashline path |
| 11 | low | open | no PDF or notebook reads |
| 12 | high | fixed | a one-line anchor carrying a multi-line body strands the rest of the block — the duplicate lines the agents kept reporting |
| 13 | high | fixed | agents re-edit from line numbers their own previous edit shifted; 62% of all anchor misses |

### 3.1 `end_hash` optional — silent destruction under drift

`hashline.py:221` reads `if end_hash is not None and actual_end_hash != end_hash`.
Omit it and the end anchor is never checked. A model that read lines 2-4 and
issues a replace of 2-4 while line 4 changed underneath it:

```
file after external change: 'line1\nline2\nline3\nIMPORTANT_NEW_CODE\nline5\n…'
error:   None
summary: Replaced 3 line(s) with 1 line(s) at line 2
result:  'line1\nreplacement\nline5\nline6\nline7\n'
```

This is *worse than `str_replace`*, which validates the whole span by
construction, and the reference implementations require the end anchor for
exactly this reason. It is the only 100%-under-drift corruption path on the list.

### 3.2 Indentation in the hash — a formatter kills every anchor

```
model read:      '1:00|def f():\n2:6e|  return 1'
after Black:     hash of '    return 1' = dc
edit outcome:    Hash mismatch at line 2: expected '6e', got 'dc'.
```

Prettier-on-save does this on every edit in a JS workspace. This is also the
most likely explanation for the Python regression in the replication study.

### 3.3 2-char hash

256 buckets, uniformly distributed (all 256 used; 335-464 hits per bucket over
100k synthetic lines). Measured false-pass rate for an unrelated real-looking
line: **0.3645%** (theory 1/256 = 0.3906%; 4 chars would be 0.0015%). Roughly 1
in 275 stale edits applies to the wrong content with no error. Real but two
orders of magnitude rarer than 3.1.

### 3.4 `write_file` has no read-before-write guard

`console.py:712-737` has no staleness check in either edit mode — only
`edit_file` ever had one. This is the guarantee Claude Code enforces hardest,
and it covers the one wholly destructive operation we expose.

### 3.5 No post-edit validation

No LSP, no syntax check, no lint hook; a grep for diagnostics across
`backend/app` finds only `preview_detect.py`. We adopted the edit format without
the feedback loop the research partly credits for its gains. See §4.

### 3.6 Mismatch recovery

The error is `Hash mismatch at line 2: expected '6e', got 'dc'. File may have
changed — re-read it first.` No updated hashes, no proximity search, no repair.
Every anchor miss costs a full re-read, spending the token savings the format is
sold on.

### 3.7 One hunk per call

Reference implementations batch hunks in a single patch against stable
original-file line numbers. Ours needs N round trips, worked bottom-to-top so
line numbers do not shift — and each anchor miss along the way costs a re-read
(3.6).

### 3.8 CRLF

`_split_lines` splits on `\n` only, so line 2 of a CRLF file is `beta\r` and the
model must hash the invisible `\r`. Editing line 2 of
`'alpha\r\nbeta\r\ngamma\r\n'` yields `'alpha\r\nBETA\ngamma\r\n'`.

### 3.9 Non-UTF-8 bytes

The path is `read_bytes` → `decode(errors="replace")` → edit → `write(whole
text)`, so replacement characters are persisted across the whole file:

```
in:  b'header\n\xff\xfe binary-ish payload\ntail\n'
out: b'HEADER\n\xef\xbf\xbd\xef\xbf\xbd binary-ish payload\ntail\n'
```

Corruption in a region the edit never touched.

### 3.10 No character cap on the hashline read

Only a 2000-*line* limit. A 500k-char minified bundle (one line) returns 500,005
characters — about 125k tokens — in one tool result. The 200k `read` ceiling the
dependency advertises lives on `backend.read()`; the hashline path calls
`backend.read_bytes()` and routes around it. Anthropic's own text editor tool
ships `max_characters` for precisely this.

### 3.11 PDFs and notebooks

`document_support` exists in the console toolset but pydantic-deep hardcodes only
`image_support=True` (`pydantic_deep/agent.py:413`). Claude Code's `Read` handles
both, plus a dedicated `NotebookEdit`.

### 3.12 One-line anchor, multi-line body — the duplicate lines

`end_line` is optional and nothing checks that `new_content` is one line to
match, so a model that re-states a whole block but forgets the range gets the new
copy spliced in *above* the old one with `error=None`. This is the "duplicate
lines" the agents kept reporting, and unlike 3.1 it needs no drift at all — the
anchor is perfectly valid, the edit is just narrower than the content.

Measured over the 713 real `hashline_edit` calls in `~/.lursor/lursor.db`: **16%
(114) had this shape**, and they were followed by a re-read-and-re-edit of the
same file **75%** of the time against **52%** for explicit range edits. It also
slips past 3.5's fix by construction — duplicated code is usually still
*parseable*, so `edit_syntax.py` stays quiet. Confirmed against the checker: a
`.tsx` file with `flightTime: 0` twice in one object literal and `const
groundLevel` declared twice (the real bug from the minigame session) returns
`None`; both are semantic, not syntactic, and `transpileModule` reports only
syntactic diagnostics.

Fixed in `agents/file_editing.py`. The replacement is compared against the lines
the edit *keeps* on either side of the splice; a repeat of two or more
substantive lines is refused with the `end_line`/`end_hash` that expresses what
the model meant. Anchoring on the last line of `new_content` and extending
backwards is what finds it — the repeat rarely starts at the splice, because the
stranded originals sit in front of it. Measured on this repo's own source:
**96.9%** of the bug shape caught with the *correct* `end_line` named, **0.17%**
of legitimate range edits flagged (all as warnings, never refusals), and **0%**
of legitimate one-line-to-many expansions touched.

Refusal is reserved for the replace-with-no-`end_line` shape, where supplying the
reported range produces exactly the file the model was aiming for. `insert_after`
next to a repetitive structure — a list of near-identical config blocks — may
genuinely mean it, so that gets a warning appended to a successful write instead.

### 3.13 Agents re-edit from line numbers they already invalidated

**13.7% of the 713 calls (98) failed on a hash mismatch — and 62% of those were
self-inflicted**: the agent edited a file, then edited it again from numbers its
own earlier edit had shifted. That answers §3's open question about the real
mismatch rate, and it lands above the 10% line at which the format costs more
than it saves.

The mismatch is the *lucky* outcome. The hash is positional-blind, and on this
repo's source **19.1% of lines share a 2-char hash with another line within ±10
lines** (75.5% file-wide — blank lines, `}`, `  );`), so a drifted anchor
validates against the wrong line roughly one time in five and splices silently.
Range edits are well covered once 3.1 is fixed: simulated under 1-5 lines of
drift with both hashes supplied, only **0.01-0.21%** are falsely accepted. The
exposure is concentrated in the single-anchor path.

Fixed by re-tagging the edited region on every *successful* edit, with the line
delta, so the next edit never needs stale numbers or a re-read. Same trade as
3.6, applied to the success path rather than the error path.

Related, and worth keeping in mind rather than fixing: `_find_anchor`'s recovery
advice is wrong 4% of the time at 2 lines of drift and 19% at 10, because a
nearer hash collision outranks the true match. Low volume in practice (15 "moved
to line N" against 7 "content changed" in the history), and a wrong suggestion
still fails its own hash check on retry.

### Also open

- The UI reports `-0` on every edit: `frontend/src/agui/file-changes.ts:84`
  reads `args.old_string`, a `str_replace` field `hashline_edit` never sends, and
  `occurrences()` parses `replaced (\d+) occurrence` which the hashline summary
  never emits. A pure deletion renders as `+0 -0`. The real numbers are in the
  summary string (`Replaced N line(s) with M line(s)`). `DELETE_TOOLS =
  ["delete_file"]` on line 18 is dead.
- `WRITE_FILE_DESCRIPTION` (`console.py:127`) tells the model to prefer
  `edit_file`, which does not exist in hashline mode — the same shape as trap 12.
  Our own docstring at `builder.py:907` repeats it.

## 4. Judgment call: is post-edit validation worth building?

Yes, but not as a typecheck. The `tsc --noEmit` shape is a bad trade: no
tree-sitter or JS parser is installed, workspaces are user-scaffolded so a
toolchain may be absent, a project-wide run is seconds per edit, and it reports
pre-existing errors the agent then chases. Narrow it on three axes:

- **Syntax only, not semantics.** "Your edit left this file unparseable at line
  N" is the failure findings 1-3 actually produce. Type errors are a different
  problem with a slower loop that already exists.
- **Delta only.** Check before and after; report only failures the edit
  *introduced*. Without this it is noise.
- **Skip when there is no cheap checker.** Python/JSON/YAML need no new
  dependency (`compile()`, `json.loads`). For TS/TSX — most of what our agents
  write — use whatever parser the workspace already vendors, and skip silently
  when absent rather than installing anything. Note that `esbuild` is *not* that
  parser any more: Vite 8 bundles rolldown, so our own `frontend/` (`vite
  ^8.1.5`) has no `esbuild` in `node_modules` at all. What it does have is
  `@oxc-project` (rolldown's parser, present transitively) and `tsc`. Probe for
  `oxc-parser` first and fall back to a single-file `tsc` syntax pass; probing
  only for `esbuild` would silently skip exactly the TS/TSX files this section
  argues matter most.

Value is highest because our fleet is weak local models via
`TolerantOpenAIChatModel`, and the harness research's central claim is that the
weakest models gain most from tool-layer feedback. One `after_tool_execute` hook,
no subprocess in the common case.

Not starting from zero, though: browser QA's `get_console_logs` and the goal
evaluator already surface broken code, just at end-of-turn after the agent has
built on top of it. This is a latency improvement on an existing signal — worth
doing, not urgent.

## 5. Judgment call: should we own the edit format?

No. Trimming before hashing and widening to 4 chars means owning both
`read_file` and `hashline_edit` — the most safety-critical mutation path in the
product — and permanently diverging from a dependency that ships weekly.

- **Findings 1 and 6 capture most of the benefit and touch no hash.** Requiring
  `end_hash` closes a 100%-under-drift path; finding 3 is 0.36%. Returning fresh
  anchors on mismatch turns Prettier-on-save into one cheap retry instead of a
  full re-read, which is most of what whitespace-insensitivity buys day to day.
- **This is upstream's design decision**, the fix is a handful of lines each, and
  they are receptive (same org publishes hashline write-ups). Per the repo rule
  we do not open PRs on repos we do not own: prepare the diff and PR text and
  hand it over.

Prerequisite before anyone argues priority: **log the hash-mismatch rate per
edit.** Under 1% of edits and finding 3 is noise with finding 6 sufficient; 10%+
and it justifies pushing upstream hard. Nobody has that number yet — everything
here is reproduced mechanics, not observed production frequency.

## 6. Upstream state

| Package | Ours | Upstream | Note |
| --- | --- | --- | --- |
| `pydantic-ai-backend` | 0.2.24 (Aug 3) — was 0.2.16 | 0.2.24 | upgraded; see §7 item 1 for what it took |
| `pydantic-deep` | 0.3.38, pinned at `04c802b6` (Jul 24) | — | our pin requires backend `[console]>=0.2.16` with no upper bound |

The pin does not force the two to move together: 0.3.38 accepts backend 0.2.24
as-is. The real risk in the upgrade is that upstream restructured `console.py`
across those eight releases — the hashline read path moved from ~676 to ~341, and
`create_console_toolset` is called by the library, not by us. So step 1 of the
queue is a migration needing a console-toolset smoke test, not a version bump
plus a green install.

Between those releases the maintainers ran a ten-finding audit of this exact
file (#80) including a security fix: `permissions=READONLY_RULESET` left
`run_in_background` registered, so a "reads only" ruleset still had a working
shell. **That one does not reach us** — we never pass `permissions=`. The
`edit_file` lock serialisation and encoding work do.

Upgrading does **not** fix findings 1, 2, 3, 8, 9 or 10. Verified at upstream
HEAD: `line_hash` is still `md5(...)[:2]` with no trim, `end_hash` is still
optional, and the hashline read still calls `read_bytes`. These survived two
recent audits; they will not fix themselves.

## 7. Queue — done

All six items shipped. What each one turned into:

1. **Upgraded `pydantic-ai-backend` 0.2.16 → 0.2.24.** This was a migration, not a
   bump, exactly as §6 predicted: 17 tests failed because upstream restructured
   `LocalBackend` (`_check_permission_sync` → `_execute_denial`/`_guard`,
   `_shell_cmd` → module-level `shell_argv`, `_validate_path` → `_resolve`, the
   `_bg` registry → a `BackgroundProcesses` helper). `agents/deduping_backend.py`
   now targets the new API and reads its background roster through the *public*
   `list_background`.

   It also carried a silent regression worth recording: 0.2.24 adds a cancellable
   `async_execute`, and `AsyncBackendAdapter` prefers it whenever the backend
   defines it — so our `execute` override stopped being on the path the agent's
   shell tool takes. Env injection and secret redaction would have quietly
   stopped working. `async_execute` is now overridden too, with tests that assert
   redaction through `ensure_async(backend).execute` rather than through the sync
   method nothing calls any more.
2. **Findings 1 and 6** → `agents/file_editing.py` (`FileEditingGuards`). An
   `end_line` without an `end_hash` is refused before the edit runs; a hash
   mismatch comes back with the anchor's new line number (searched outward from
   the reported line, nearest first) and a re-tagged window, so the model retries
   without a re-read.

   The retry-budget caveat is sidestepped rather than accepted: guard failures are
   returned as `"Error: …"` *text*, the console toolset's own idiom for a refused
   call, so nothing is counted against `max_retries`. Implemented in
   `wrap_tool_execute`, which can short-circuit without calling the handler.
3. **Finding 4** — `write_file` over an existing file this agent has not read is
   refused. The read set is ours (the library's `_record_read` cache is private),
   keyed on the backend instance in a `WeakKeyDictionary` the way upstream keys
   its own edit locks — so, since one `LocalBackend` is shared per workspace, a
   file read in an earlier turn still counts. Creating a new file is never
   blocked, a successful write or a matching-anchor edit both mark the file as
   known, and paths are normalized so a relative read covers an absolute write.
4. **Finding 5** → `agents/edit_syntax.py` (`EditSyntaxCheck`), in the narrow form
   of §4: syntax only, delta only, and no installs. Python/JSON/TOML/YAML are
   checked in-process with no subprocess at all. JS/TS probes the workspace once
   for `esbuild`, then for the classic TypeScript compiler API via Node, and skips
   silently otherwise.

   §4's premise needed correcting again on contact: **TypeScript 7 has no
   single-file syntax API** (the native rewrite dropped `transpileModule`; its
   replacement needs a whole `Program`, i.e. type checking), and `oxc-parser` is
   not resolvable in a Vite 8 project either — rolldown keeps its parser in the
   native binary and `@oxc-project/types` is types only. So our own `frontend/`
   gets no JS/TS check. That is the documented failure mode, not a bug: installing
   a parser into a user's workspace to satisfy a lint pass is worse than staying
   quiet.
5. **Findings 2, 3, 8, 9 as an upstream diff** —
   [`docs/upstream/hashline-anchors.patch`](upstream/hashline-anchors.patch), with
   PR text, against upstream `058b8aa`. Verified rather than written: applies
   cleanly to a fresh HEAD clone, and their whole suite passes (1578 tests, ruff
   clean) including the five tests that encoded the old contract, updated in the
   same diff. Not submitted — per the repo rule, a human opens it.

   The patch hashes trimmed content, widens to 4 hex chars with a
   prefix-compatible `hash_matches()` so anchors in flight across the upgrade
   still validate, makes `end_hash` mandatory with `end_line`, keeps CRLF out of
   the hashed text and restores the file's own ending on write, and refuses to
   edit a file that is not valid UTF-8 instead of replacing undecodable bytes
   file-wide.
6. **Instrumented.** `hashline_stats()` counts edits, mismatches, recovered
   anchors, refused range edits and blocked writes; every mismatch logs the
   running rate; `GET /analytics/file-editing` returns the counters. The number
   the priority argument needs is now one request away instead of nonexistent.

Also closed from "Also open": `hashline_edit` no longer renders as `-0` in the UI
(`frontend/src/agui/file-changes.ts` reads both counts out of the summary string,
since the arguments cannot supply them), and `write_file`'s description no longer
tells the model to prefer a tool that does not exist in hashline mode — a
`prepare_tools` hook retargets it at `hashline_edit` and states the
read-before-write rule up front, so the model reads first instead of spending a
call discovering the guard.

Not done, deliberately: findings 7 (hunk batching), 10 (character cap on the
hashline read) and 11 (PDF/notebook reads) are upstream feature work, not
correctness bugs, and none of them corrupts anything.

Mechanism note: none of this patches the vendored dependency.
`wrap_tool_execute` can short-circuit a call or rewrite its result,
`before_tool_execute` returns the args dict so it can rewrite validated args, and
`prepare_tools` can rewrite a tool description. `ModelRetry` from a hook is
wrapped as `ToolRetryError` only after `_check_max_retries` counts it
(`pydantic_ai/tool_manager.py:365-374`), which is why none of the guards raise it.

## 8. Reproduction

```python
from pydantic_ai_backends.hashline import (
    apply_hashline_edit_with_summary, format_hashline_output, line_hash,
)

# 3.1 — range edit with end_line but no end_hash
original = "".join(f"line{i}\n" for i in range(1, 8))
drifted = original.replace("line4", "IMPORTANT_NEW_CODE")
print(apply_hashline_edit_with_summary(
    drifted, start_line=2, start_hash=line_hash("line2"),
    new_content="replacement", end_line=4, end_hash=None,
))  # -> error None, IMPORTANT_NEW_CODE gone

# 3.2 — a formatter invalidates the anchor
print(line_hash("  return 1"), line_hash("    return 1"))  # 6e dc

# 3.8 — CRLF
crlf = "alpha\r\nbeta\r\ngamma\r\n"
print(repr(format_hashline_output(crlf)))                   # tags include \r
print(apply_hashline_edit_with_summary(crlf, 2, line_hash("beta\r"), "BETA"))

# 3.9 — one bad byte, edit elsewhere
raw = b"header\n\xff\xfe payload\ntail\n"
text = raw.decode("utf-8", errors="replace")
new, _, _ = apply_hashline_edit_with_summary(text, 1, line_hash("header"), "HEADER")
print(new.encode("utf-8"))                                  # \xff\xfe destroyed

# 3.10 — no character cap
print(len(format_hashline_output("var a=1;" * 62_500)))      # 500005
```

## 9. Sources

- [Claude Code issue #25775 — hash-based line addressing, closed "not planned"](https://github.com/anthropics/claude-code/issues/25775)
- [Anthropic text editor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool)
- [Can Bölük, *The Harness Problem*](https://stencil.so/blog/the-harness-problem)
- [Hashline vs Replace — independent replication](https://nwyin.com/blogs/hashline-vs-replace-edit-bench)
- [oh-my-pi hashline mode reference](https://deepwiki.com/can1357/oh-my-pi/8.1-hashline-mode)
- [kebbbnnn/hashline — 4-char trimmed hash, proximity search](https://github.com/kebbbnnn/hashline)
- [Aider code editing leaderboard](https://aider.chat/docs/leaderboards/edit.html) /
  [edit format implementations](https://deepwiki.com/Aider-AI/aider/3.1-edit-format-implementations)
- [pydantic-ai-backend #80 — the ten-finding audit](https://github.com/vstorm-co/pydantic-ai-backend/pull/80)
