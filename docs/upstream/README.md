# Upstream patches — ready to submit, not submitted

Fixes that belong in a dependency rather than in this repo. Each one is a diff
against that project's HEAD plus the PR text to go with it. **We do not open pull
requests on repositories we do not own** — these are prepared so a human can
submit them under their own identity, or so we can carry them as a local patch if
upstream declines.

| Patch | Target | Verified against | Status |
| --- | --- | --- | --- |
| [`hashline-anchors.patch`](hashline-anchors.patch) | [`vstorm-co/pydantic-ai-backend`](https://github.com/vstorm-co/pydantic-ai-backend) | `058b8aa` (2026-08-03) | not submitted |

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
