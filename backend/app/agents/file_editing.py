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

END_HASH_REQUIRED = (
    "Error: hashline_edit needs end_hash whenever end_line is given, so both ends "
    "of the range are validated. Without it only the start line is checked and an "
    "edit can silently overwrite lines that changed since you read them. Re-send "
    "with the end line's hash from read_file (the NN in `{line}:NN|`), or drop "
    "end_line to edit a single line."
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


def _tagged_window(lines: list[str], centre: int, radius: int = CONTEXT_LINES) -> str:
    """Re-tag the lines around ``centre`` (1-indexed) in hashline read format.

    Rendered here rather than with ``format_hashline_output`` because that helper
    appends a "... (N more lines)" footer counted against the whole file, which
    reads as truncation when the caller only asked for a window.
    """
    start = max(1, centre - radius)
    end = min(len(lines), centre + radius)
    return "\n".join(f"{n}:{line_hash(lines[n - 1])}|{lines[n - 1]}" for n in range(start, end + 1))


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
        """Finding 1 up front, finding 6 on the way out, counters around both."""
        if args.get("end_line") is not None and not args.get("end_hash"):
            _stats.missing_end_hash += 1
            logger.info(
                "hashline_edit on %s refused: end_line %s without end_hash",
                path,
                args.get("end_line"),
            )
            return END_HASH_REQUIRED

        _stats.edits += 1
        result = await handler(args)

        if not isinstance(result, str):
            return result
        if not result.startswith("Error"):
            # The anchor matched, so the agent's picture of this file was current.
            _mark_seen(backend, path)
            return result

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
        try:
            raw = await ensure_async(backend).read_bytes(path)
        except Exception:  # noqa: BLE001 — recovery is best-effort; keep the error
            logger.debug("could not re-read %s to enrich a hashline mismatch", path)
            return error

        text = raw.decode("utf-8", errors="replace")
        lines = text.split("\n")
        if lines and lines[-1] == "" and text.endswith("\n"):
            lines = lines[:-1]
        if not lines:
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
