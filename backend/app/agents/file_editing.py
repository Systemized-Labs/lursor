"""Guards on the file-editing tools, and the mismatch counter that tells us
whether the format is costing us anything.

We ship pydantic-deep's default ``hashline`` edit format, where each read line
comes back tagged ``{line}:{hash}|{content}`` and an edit re-states those tags as
anchors. The hash *is* the staleness check — there is no separate read-before-edit
enforcement — so the anchors have to be load-bearing. Three places where they are
not (see ``docs/FILE-EDITING-AUDIT.md`` for the reproductions):

**A range edit validates one end only.** ``hashline_edit`` takes ``end_line``
with an *optional* ``end_hash``, and skips the end check entirely when the hash is
absent (``pydantic_ai_backends/hashline.py``). A model that read lines 2-4 and
replaces 2-4 after line 4 changed underneath it gets ``error=None`` and destroys
the new content silently. That is worse than the ``str_replace`` format it
replaced, which validates the whole span by construction, and it is the only
path on the list that corrupts 100% of the time under drift. Here an ``end_line``
without an ``end_hash`` is refused before the edit runs.

**Nothing stopped ``write_file`` clobbering a file the agent never read.**
``write_file`` is a whole-file overwrite with no staleness check in either edit
format. It is the one wholly destructive operation the agent has, and the
read-before-write rule is the guarantee Claude Code enforces hardest. Creating a
*new* file is untouched — the guard only fires for a path that already exists.

**An anchor miss was a dead end.** The library's error is "File may have changed
— re-read it first", with no fresh anchors, so every miss costs a full re-read of
the file and spends the token savings the format is sold on. A formatter running
on save invalidates every hash below the edit (the hash covers indentation), so
this is routine rather than exotic. Here the error comes back with the anchor's
new home and a re-tagged window, so the model can retry without re-reading.

**A one-line anchor silently kept the rest of the block.** ``hashline_edit``
replaces *only* ``start_line`` when ``end_line`` is omitted, and nothing checked
that ``new_content`` was one line to match. A model that re-states a whole
function in ``new_content`` but forgets the range gets its new block spliced in
*above* the old one with ``error=None`` — the "duplicate lines" the agents kept
reporting. Measured over 713 real ``hashline_edit`` calls, 16% had this shape,
and they were followed by a re-read-and-re-edit of the same file 75% of the time
against 52% for explicit range edits. Nothing downstream catches it either:
duplicated code is usually still *parseable*, so ``agents/edit_syntax.py`` is
blind to it by construction. :func:`_duplicate_overlap` refuses an edit whose
replacement text already sits next to the splice point, and names the
``end_line``/``end_hash`` that expresses what the model meant.

**Every successful edit now hands back fresh anchors.** 62% of the anchor misses
in that same sample were self-inflicted: the agent edited a file and then edited
it again from line numbers its own earlier edit had shifted. Re-tagging the
edited region on the way out costs a few lines per edit and removes the reason to
re-read, which is the same trade the mismatch recovery above makes.

Mechanism: one ``wrap_tool_execute`` hook. Guard failures are returned as
``"Error: ..."`` *text*, which is the console toolset's own idiom for a refused
call, not raised as ``ModelRetry`` — a raise is wrapped as ``ToolRetryError``
only after it is counted against the tool's retry budget
(``pydantic_ai/tool_manager.py``), so a strict guard implemented that way would
burn retries and eventually hard-fail the call it was trying to make safe.

Instrumentation: :func:`hashline_stats` counts edits and anchor misses across the
process. The audit's open question is what the real mismatch rate is — under 1%
and the remaining findings are noise, 10%+ and the format is costing us more than
it saves — and nobody had that number. Now it is one call away.
"""

from __future__ import annotations

import logging
import os
import re
import weakref
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from pydantic_ai.capabilities import AbstractCapability, ValidatedToolArgs
from pydantic_ai.messages import ToolCallPart
from pydantic_ai.tools import RunContext, ToolDefinition
from pydantic_ai_backends import ensure_async
from pydantic_ai_backends.hashline import line_hash

logger = logging.getLogger(__name__)

READ_TOOL = "read_file"
WRITE_TOOL = "write_file"
HASHLINE_EDIT_TOOL = "hashline_edit"
# The str_replace-mode edit tool. It has its own fingerprint staleness check
# upstream, so it needs no guard here — it is tracked only so switching
# ``edit_format`` doesn't make the write guard start firing on files the agent
# has demonstrably been working in.
STR_REPLACE_EDIT_TOOL = "edit_file"

# `Hash mismatch at line 2: expected '6e', got 'dc'. File may have changed — …`
_MISMATCH = re.compile(r"Hash mismatch at line (\d+): expected '([0-9a-f]+)', got '([0-9a-f]+)'")

# How far either side of the reported line to look for the anchor's new home. A
# formatter or a sibling edit shifts lines by a handful, not by hundreds; a wide
# window would mostly find coincidental 1-in-256 hash collisions.
PROXIMITY_WINDOW = 40
# Lines either side of the reported line to re-tag in the error, so the model can
# retry from the error text instead of re-reading the file.
CONTEXT_LINES = 6
# Most lines a success message will re-tag. A big replacement gets its head and
# tail rather than the whole thing — enough to re-anchor at either edge without
# echoing the content the model just wrote back at it.
MAX_ANCHOR_LINES = 40

# Shortest repeated run worth refusing an edit over. One line repeats by
# coincidence constantly (a blank line, a closing brace); two identical lines in
# a row that the edit is about to add next to their originals do not.
MIN_DUPLICATE_RUN = 2

END_HASH_REQUIRED = (
    "Error: hashline_edit needs end_hash whenever end_line is given, so both ends "
    "of the range are validated. Without it only the start line is checked and an "
    "edit can silently overwrite lines that changed since you read them. Re-send "
    "with the end line's hash from read_file (the NN in `{line}:NN|`). Only drop "
    "end_line if new_content is a single line: without end_line this edit replaces "
    "line start_line and nothing else, so a multi-line new_content leaves the rest "
    "of the block you meant to replace on disk, duplicated below your change."
)

WRITE_NEEDS_READ = (
    "Error: write_file replaces the whole file and {path} already exists, but this "
    "agent has not read it. Read it first (read_file), then either edit the lines "
    "you want to change with hashline_edit or re-send write_file with the full "
    "content you intend to keep. To create a new file, write to a path that does "
    "not exist yet."
)


@dataclass
class HashlineStats:
    """Process-wide edit counters. See the module docstring for why they exist."""

    edits: int = 0
    """``hashline_edit`` calls that reached the tool."""
    mismatches: int = 0
    """Calls refused by the library because an anchor no longer matched."""
    missing_end_hash: int = 0
    """Range edits refused here for validating one end only (finding 1)."""
    recovered_anchors: int = 0
    """Mismatches where the anchor's new line number was found nearby."""
    blocked_writes: int = 0
    """``write_file`` calls refused for targeting an unread existing file."""
    blocked_duplicates: int = 0
    """Edits refused for repeating text that already sits beside the splice."""
    flagged_duplicates: int = 0
    """Edits that repeated such text in a shape too ambiguous to refuse."""

    @property
    def mismatch_rate(self) -> float:
        """Share of executed edits the library refused on a stale anchor."""
        return self.mismatches / self.edits if self.edits else 0.0


_stats = HashlineStats()


def hashline_stats() -> HashlineStats:
    """The live counters. Mutated in place, so callers see a snapshot of *now*."""
    return _stats


def reset_hashline_stats() -> None:
    """Zero the counters. For tests; nothing in the app calls this."""
    global _stats
    _stats = HashlineStats()


# Paths this agent is known to have seen the contents of, keyed on the backend
# instance — the same scope the library uses for its own per-path edit locks. One
# ``LocalBackend`` is shared by every run in a workspace (``agents/builder.py``),
# so a file read in an earlier turn still counts as read, which is what stops the
# write guard from firing on work the agent legitimately has in context. Weak so
# a closed workspace's backend is collectable.
_seen: weakref.WeakKeyDictionary[Any, set[str]] = weakref.WeakKeyDictionary()


def _raw(backend: Any) -> Any:
    """The sync backend under an async adapter, or ``backend`` unchanged."""
    unwrap = getattr(backend, "unwrap", None)
    return unwrap() if callable(unwrap) else backend


def _key(backend: Any, path: str) -> str:
    """Normalized identity for a path, so ``src/a.ts`` and ``/ws/src/a.ts`` match.

    Relative paths are anchored to the backend root the same way the backend
    itself resolves them. ``normpath`` (not ``resolve``) keeps this off the
    filesystem: it is called on every read and every write.
    """
    candidate = Path(path)
    if not candidate.is_absolute():
        root = getattr(_raw(backend), "root_dir", None)
        if root is not None:
            candidate = Path(root) / candidate
    return os.path.normpath(str(candidate))


def _mark_seen(backend: Any, path: str) -> None:
    _seen.setdefault(_raw(backend), set()).add(_key(backend, path))


def _has_seen(backend: Any, path: str) -> bool:
    return _key(backend, path) in _seen.get(_raw(backend), frozenset())


def _tag(lines: list[str], first: int, last: int) -> str:
    """Lines ``first``..``last`` (1-indexed, inclusive) in hashline read format.

    Rendered here rather than with ``format_hashline_output`` because that helper
    appends a "... (N more lines)" footer counted against the whole file, which
    reads as truncation when the caller only asked for a window.
    """
    first, last = max(1, first), min(len(lines), last)
    return "\n".join(
        f"{n}:{line_hash(lines[n - 1])}|{lines[n - 1]}" for n in range(first, last + 1)
    )


def _tagged_window(lines: list[str], centre: int, radius: int = CONTEXT_LINES) -> str:
    """Re-tag the lines around ``centre`` (1-indexed) in hashline read format."""
    return _tag(lines, centre - radius, centre + radius)


def _tagged_span(lines: list[str], first: int, last: int) -> str:
    """``first``..``last``, elided in the middle when it exceeds the cap.

    Both edges are what a follow-up edit needs to re-anchor, so a long span keeps
    them and drops the middle rather than truncating to the first N lines.
    """
    first, last = max(1, first), min(len(lines), last)
    if last - first + 1 <= MAX_ANCHOR_LINES:
        return _tag(lines, first, last)
    half = MAX_ANCHOR_LINES // 2
    hidden = (last - first + 1) - 2 * half
    return "\n".join(
        [
            _tag(lines, first, first + half - 1),
            f"... ({hidden} unchanged lines omitted) ...",
            _tag(lines, last - half + 1, last),
        ]
    )


def _text_lines(text: str) -> list[str]:
    """Split file text the way the hashline format numbers it."""
    lines = text.split("\n")
    if lines and lines[-1] == "" and text.endswith("\n"):
        lines = lines[:-1]
    return lines


async def _read_lines(backend: Any, path: str) -> list[str] | None:
    """The file's current lines, or ``None`` when it cannot be read."""
    try:
        raw = await ensure_async(backend).read_bytes(path)
    except Exception:  # noqa: BLE001 — every caller treats this as "skip the check"
        return None
    return _text_lines(raw.decode("utf-8", errors="replace"))


def _find_anchor(lines: list[str], reported_line: int, expected: str) -> int | None:
    """Nearest line to ``reported_line`` whose hash is ``expected``, if any.

    Searches outward so the closest candidate wins: with a 2-char hash one line in
    256 collides by chance, and the true match is almost always a few lines from
    where the model last saw it.
    """
    for distance in range(1, PROXIMITY_WINDOW + 1):
        for candidate in (reported_line - distance, reported_line + distance):
            if 1 <= candidate <= len(lines) and line_hash(lines[candidate - 1]) == expected:
                return candidate
    return None


def _substantive(block: list[str]) -> bool:
    """Whether a repeated run is real code rather than punctuation.

    ``}``, ``});``, ``)`` and blank lines repeat next to each other all the time
    and mean nothing; the run only indicts an edit if some line in it carries
    actual content. Alphanumerics are the discriminator — a closing-bracket line
    has none however long it is.
    """
    return any(len(line.strip()) > 3 and any(ch.isalnum() for ch in line) for line in block)


@dataclass(frozen=True)
class _Duplication:
    """A run of ``new_content`` that is already on disk beside the splice point."""

    count: int
    """How many lines would appear twice."""
    below: bool
    """``True`` when the existing copy sits after the splice, ``False`` before."""
    first: int
    """1-indexed line where the existing copy starts."""
    last: int
    """1-indexed line where it ends."""
    certain: bool
    """Whether this is the measured bug shape, or merely a repeat worth flagging."""

    @property
    def end_line(self) -> int:
        """The ``end_line`` a replace would need to consume the existing copy."""
        return self.last


def _repeat_below(
    lines: list[str], kept_below: int, new_lines: list[str]
) -> tuple[int, int] | None:
    """Longest tail of ``new_lines`` that already sits below the splice.

    Returns ``(count, last_line)``. The existing copy does not have to start at
    the splice: in the shape this exists to catch, the model replaced the first
    line of a block and left the remainder, so the repeat begins a line or two
    down with the stranded originals in front of it. Anchoring on the last line
    of ``new_content`` and extending backwards finds it wherever it landed, and
    ``last_line`` is then exactly the ``end_line`` the model should have sent.

    The search stops ``len(new_lines)`` past the splice — a block cannot strand
    more lines than the replacement that was meant to cover it.
    """
    best: tuple[int, int] | None = None
    for last in range(kept_below + 1, min(len(lines), kept_below + len(new_lines)) + 1):
        if lines[last - 1] != new_lines[-1]:
            continue
        count = 0
        while (
            count < len(new_lines)
            and last - 1 - count >= kept_below
            and lines[last - 1 - count] == new_lines[-1 - count]
        ):
            count += 1
        if count >= MIN_DUPLICATE_RUN and (best is None or count > best[0]):
            best = (count, last)
    return best


def _repeat_above(
    lines: list[str], kept_above: int, new_lines: list[str]
) -> tuple[int, int] | None:
    """Longest head of ``new_lines`` that already sits above the splice.

    The mirror of :func:`_repeat_below`, for an ``insert_after`` that re-states
    the anchor it was told to insert after. Returns ``(count, first_line)``.
    """
    best: tuple[int, int] | None = None
    for first in range(max(0, kept_above - len(new_lines)), kept_above):
        if lines[first] != new_lines[0]:
            continue
        count = 0
        while (
            count < len(new_lines)
            and first + count < kept_above
            and lines[first + count] == new_lines[count]
        ):
            count += 1
        if count >= MIN_DUPLICATE_RUN and (best is None or count > best[0]):
            best = (count, first + 1)
    return best


def _duplicate_overlap(lines: list[str], args: ValidatedToolArgs) -> _Duplication | None:
    """The text this edit would repeat, or ``None`` if it repeats nothing.

    Compares the replacement against the lines the edit *keeps* on either side of
    the splice, and marks the result ``certain`` for the one shape the history
    says is a bug rather than a judgement call: a replace with no ``end_line``
    carrying multi-line ``new_content``. There the repeat is the remainder of the
    block the model thought it was replacing, and supplying the ``end_line`` this
    reports produces exactly the file the model was aiming for — so it is safe to
    refuse. Every other shape is a warning, because a model that asked for
    ``insert_after`` next to a repetitive structure (a list of similar entries, a
    table of near-identical config blocks) may well mean it.

    Held back deliberately in two more places. A stale ``start_hash`` returns
    ``None`` so the library's own mismatch error wins, which is the more useful
    answer. And nothing fires below :data:`MIN_DUPLICATE_RUN` lines or on a run of
    pure punctuation, because a replacement ending in the same ``});`` as the line
    under it is ordinary rather than wrong.
    """
    start_line = args.get("start_line")
    end_line = args.get("end_line")
    insert_after = bool(args.get("insert_after"))
    new_content = args.get("new_content")

    if not isinstance(start_line, int) or not 1 <= start_line <= len(lines):
        return None
    if line_hash(lines[start_line - 1]) != args.get("start_hash"):
        return None
    new_lines = new_content.split("\n") if isinstance(new_content, str) and new_content else []
    if len(new_lines) < MIN_DUPLICATE_RUN:
        return None

    if insert_after:
        # Nothing is consumed: the lines above and below the insertion point both
        # survive, so both are candidates for being restated.
        kept_above, kept_below = start_line, start_line
    else:
        in_range = isinstance(end_line, int) and start_line <= end_line <= len(lines)
        if end_line is not None and not in_range:
            return None  # out of range; the library reports it better than we can
        kept_above = start_line - 1
        kept_below = end_line if end_line is not None else start_line

    below = _repeat_below(lines, kept_below, new_lines)
    if below is not None and _substantive(new_lines[-below[0] :]):
        count, last = below
        return _Duplication(
            count=count,
            below=True,
            first=last - count + 1,
            last=last,
            certain=not insert_after and end_line is None,
        )

    above = _repeat_above(lines, kept_above, new_lines)
    if above is not None and _substantive(new_lines[: above[0]]):
        count, first = above
        return _Duplication(
            count=count, below=False, first=first, last=first + count - 1, certain=False
        )

    return None


def _duplication_error(
    path: str, args: ValidatedToolArgs, found: _Duplication, lines: list[str]
) -> str:
    """Refuse the edit and spell out the call that expresses what was meant."""
    start_line = args.get("start_line")
    return (
        f"Error: this edit would duplicate {found.count} line(s) of {path}. The last "
        f"{found.count} line(s) of your new_content are already on disk at lines "
        f"{found.first}-{found.last}, and this edit does not replace them — they would "
        f"end up in the file twice. Without end_line, hashline_edit replaces line "
        f"{start_line} and nothing else, so the rest of the block you rewrote stays "
        f"below it. Re-send with end_line={found.end_line} and "
        f"end_hash='{line_hash(lines[found.end_line - 1])}' to replace lines "
        f"{start_line}-{found.end_line} in one go, or drop those {found.count} line(s) "
        "from new_content."
    )


def _duplication_warning(path: str, found: _Duplication) -> str:
    """Flag a repeat on an edit we are not confident enough to refuse."""
    side = "below" if found.below else "above"
    return (
        f"Duplication check: the {'last' if found.below else 'first'} {found.count} "
        f"line(s) of your new_content were already in {path} just {side} this edit "
        f"(lines {found.first}-{found.last} before the change), so that block now "
        "appears twice. The write succeeded — if that was not intended, remove one "
        "copy before moving on."
    )


@dataclass
class FileEditingGuards(AbstractCapability[Any]):
    """Make the hashline anchors load-bearing, and count when they miss.

    Install after the filtering capabilities and before the tool-loading wrapper:
    it keys off tool *names*, so it composes with anything that only adds or
    removes tools.
    """

    async def prepare_tools(
        self, ctx: RunContext[Any], tool_defs: list[ToolDefinition]
    ) -> list[ToolDefinition]:
        """Point ``write_file``'s own description at the tool that exists.

        The library's ``WRITE_FILE_DESCRIPTION`` says "ALWAYS prefer ``edit_file``
        over ``write_file`` for existing files" in *both* edit formats
        (``pydantic_ai_backends/toolsets/descriptions.py``) — but hashline mode
        registers ``hashline_edit`` and no ``edit_file`` at all, so the model is
        told to reach for a tool it does not have. It also predates the
        read-before-write rule :meth:`_write_file` now enforces, so the rule is
        stated here as well: a model that knows it will be refused reads first
        instead of spending a call finding out.
        """
        names = {td.name for td in tool_defs}
        if HASHLINE_EDIT_TOOL not in names or WRITE_TOOL not in names:
            return tool_defs
        return [
            _retarget_write_description(td) if td.name == WRITE_TOOL else td for td in tool_defs
        ]

    async def wrap_tool_execute(
        self,
        ctx: RunContext[Any],
        *,
        call: ToolCallPart,
        tool_def: ToolDefinition,
        args: ValidatedToolArgs,
        handler: Any,
    ) -> Any:
        name = call.tool_name
        if name not in (READ_TOOL, WRITE_TOOL, HASHLINE_EDIT_TOOL, STR_REPLACE_EDIT_TOOL):
            return await handler(args)

        backend = getattr(getattr(ctx, "deps", None), "backend", None)
        path = args.get("path") if isinstance(args, dict) else None
        if backend is None or not isinstance(path, str):
            # Not a console-toolset call we understand — a same-named tool from
            # somewhere else, or a deps object without a backend. Stay out of it.
            return await handler(args)

        if name == HASHLINE_EDIT_TOOL:
            return await self._hashline_edit(backend, path, args, handler)
        if name == WRITE_TOOL:
            return await self._write_file(backend, path, args, handler)

        result = await handler(args)
        if _succeeded(result):
            _mark_seen(backend, path)
        return result

    async def _hashline_edit(
        self, backend: Any, path: str, args: ValidatedToolArgs, handler: Any
    ) -> Any:
        """Findings 1 and the duplication guard up front, finding 6 on the way out."""
        if args.get("end_line") is not None and not args.get("end_hash"):
            _stats.missing_end_hash += 1
            logger.info(
                "hashline_edit on %s refused: end_line %s without end_hash",
                path,
                args.get("end_line"),
            )
            return END_HASH_REQUIRED

        # Read before the edit, for two jobs: the duplication check needs the text
        # the edit is about to splice into, and the success message needs the old
        # length to report how far everything below the change shifted.
        before = await _read_lines(backend, path)
        duplication = _duplicate_overlap(before, args) if before is not None else None
        if duplication is not None and duplication.certain:
            assert before is not None  # only reachable when the pre-flight read worked
            _stats.blocked_duplicates += 1
            logger.info(
                "hashline_edit on %s refused: would duplicate %d line(s) at %d",
                path,
                duplication.count,
                duplication.first,
            )
            return _duplication_error(path, args, duplication, before)

        _stats.edits += 1
        result = await handler(args)

        if not isinstance(result, str):
            return result
        if not result.startswith("Error"):
            # The anchor matched, so the agent's picture of this file was current.
            _mark_seen(backend, path)
            if duplication is not None:
                _stats.flagged_duplicates += 1
                logger.info(
                    "hashline_edit on %s repeated %d line(s) already at %d",
                    path,
                    duplication.count,
                    duplication.first,
                )
                result = f"{result}\n\n{_duplication_warning(path, duplication)}"
            return await self._with_fresh_anchors(backend, path, args, result, before)

        match = _MISMATCH.search(result)
        if match is None:
            return result

        _stats.mismatches += 1
        reported_line, expected = int(match.group(1)), match.group(2)
        logger.info(
            "hashline anchor miss on %s line %s: %d of %d edits (%.1f%%)",
            path,
            reported_line,
            _stats.mismatches,
            _stats.edits,
            _stats.mismatch_rate * 100,
        )
        return await self._recover(backend, path, result, reported_line, expected)

    async def _recover(
        self, backend: Any, path: str, error: str, reported_line: int, expected: str
    ) -> str:
        """Append the anchor's new home and a re-tagged window to the error."""
        lines = await _read_lines(backend, path)
        if not lines:
            logger.debug("could not re-read %s to enrich a hashline mismatch", path)
            return error

        moved = _find_anchor(lines, reported_line, expected)
        parts = [error]
        if moved is not None:
            _stats.recovered_anchors += 1
            parts.append(
                f"The line you anchored on (hash '{expected}') is now line {moved}. "
                f"Adjust your line numbers by {moved - reported_line:+d} and retry."
            )
        else:
            parts.append(
                f"No line near {reported_line} still hashes to '{expected}', so the "
                "content itself changed rather than just moving."
            )
        centre = moved if moved is not None else reported_line
        parts.append(
            f"Current state of {path} around line {centre} — these numbers and "
            "hashes are live, retry from them without re-reading:"
        )
        parts.append(_tagged_window(lines, centre))
        return "\n".join(parts)

    async def _with_fresh_anchors(
        self,
        backend: Any,
        path: str,
        args: ValidatedToolArgs,
        result: str,
        before: list[str] | None,
    ) -> str:
        """Append live anchors for the region this edit just rewrote.

        The agent's next edit to this file is the one that goes wrong: its line
        numbers came from a read that this edit has just invalidated. Re-tagging
        the changed region — and saying how far everything under it moved — is
        what the agent would otherwise spend a whole ``read_file`` to learn.
        """
        after = await _read_lines(backend, path)
        if not after:
            return result

        start_line = args.get("start_line")
        if not isinstance(start_line, int):
            return result
        new_content = args.get("new_content")
        added = len(new_content.split("\n")) if isinstance(new_content, str) and new_content else 0
        if args.get("insert_after"):
            first, last = start_line + 1, start_line + added
        else:
            first, last = start_line, start_line + added - 1

        parts = [result]
        if before is not None and len(after) != len(before):
            shift = len(after) - len(before)
            parts.append(
                f"Lines below this edit moved by {shift:+d}. Any anchor you are holding "
                f"for {path} past line {max(last, first)} is now off by that much."
            )
        # A deletion leaves nothing to tag, so `last < first` — show where it was.
        window = _tagged_span(after, first - CONTEXT_LINES, max(last, first) + CONTEXT_LINES)
        if not window:
            return result
        parts.append(
            f"Current state of {path} after the edit — these numbers and hashes are "
            "live, use them for your next edit instead of re-reading:"
        )
        parts.append(window)
        return "\n".join(parts)

    async def _write_file(
        self, backend: Any, path: str, args: ValidatedToolArgs, handler: Any
    ) -> Any:
        """Finding 4: refuse a whole-file overwrite of a file we have not read."""
        if not _has_seen(backend, path):
            try:
                exists = await ensure_async(backend).exists(path)
            except Exception:  # noqa: BLE001 — never block a write on a probe failure
                exists = False
            if exists:
                _stats.blocked_writes += 1
                logger.info("write_file on %s refused: not read by this agent first", path)
                return WRITE_NEEDS_READ.format(path=path)

        result = await handler(args)
        if _succeeded(result):
            # The agent chose this content, so it knows the file — an immediate
            # follow-up edit or rewrite is legitimate.
            _mark_seen(backend, path)
        return result


_READ_FIRST_RULE = (
    "- You must read an existing file before overwriting it with `write_file`; "
    "a write to a file this agent has not read is refused."
)


def _retarget_write_description(tool_def: ToolDefinition) -> ToolDefinition:
    """``write_file``'s description, with hashline's tool names and our rule."""
    description = tool_def.description or ""
    fixed = description.replace(f"`{STR_REPLACE_EDIT_TOOL}`", f"`{HASHLINE_EDIT_TOOL}`")
    if _READ_FIRST_RULE not in fixed:
        fixed = f"{fixed}\n{_READ_FIRST_RULE}"
    return replace(tool_def, description=fixed)


def _succeeded(result: Any) -> bool:
    """Whether a console-toolset result is a success rather than an ``"Error: …"``.

    Non-string results (``read_file`` returns ``BinaryContent`` for an image) are
    successes: the tool ran and returned content.
    """
    return not isinstance(result, str) or not result.startswith("Error")
