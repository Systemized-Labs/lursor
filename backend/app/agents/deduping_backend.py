"""The workspace :class:`LocalBackend`, with two rough edges of the base class
sanded off.

**No duplicate background processes.** The base backend mints a fresh ``bg_N``
and spawns a new detached process on *every* ``execute_background`` call, with no
check for an identical command that is already running. The only guard against
duplicate dev servers was an advisory system-prompt instruction
(``DEV_SERVER_DIRECTIVE`` in ``builder.py``) telling the model to run
``list_shells`` first and reuse a running server. That is unreliable: across
turns, compaction, or subagents the model loses sight of what it started and
spins up another ``npm run dev`` / ``npx serve`` — which is how the "3 terminals
running" duplicates appeared, all with the identical command string.

``serve`` (and most dev servers) auto-increment the port when the requested one is
taken instead of failing, so the duplicates all stay alive and indistinguishable.

This subclass enforces the reuse in code: if a background process with the same
(whitespace-normalized) command is still running, ``execute_background`` returns a
handle to *that* process instead of spawning a second one. Different commands
still spawn normally, so restarting with new flags works as before.

**No turn-killing globs.** ``LocalBackend.glob_info`` lets a handful of pathlib
exceptions escape its error guard, so one malformed ``glob`` argument from the
model takes down the whole agent turn. See :meth:`DedupingLocalBackend.glob_info`.
"""

from __future__ import annotations

import re
import threading
from pathlib import Path

from pydantic_ai_backends import BackgroundHandle, FileInfo, LocalBackend

# Pure file-descriptor redirections with no filename target (``2>&1``, ``1>&2``,
# ``>&1`` …). Stripping these before comparison means the model launching
# ``npm run dev`` and ``npm run dev 2>&1`` dedupes to one server rather than two.
_FD_REDIRECT = re.compile(r"\s*\d*>&\d+")


def _normalize(command: str) -> str:
    """Collapse whitespace and drop bare fd redirections so trivially-different
    spellings of the same command compare equal."""
    return re.sub(r"\s+", " ", _FD_REDIRECT.sub("", command)).strip()


class DedupingLocalBackend(LocalBackend):
    """``LocalBackend`` that reuses a running background process for an identical
    command rather than starting a duplicate, and that survives a malformed
    ``glob`` pattern instead of aborting the turn."""

    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)
        # execute_background runs in worker threads (the async adapter dispatches
        # it via asyncio.to_thread), and pydantic-ai runs the tool calls from one
        # assistant turn concurrently. Without a lock, several run_in_background
        # calls all read self._bg before any inserts, all miss the dedup check,
        # and all spawn — which is how three identical dev servers appeared at
        # once. Serialize the whole check-and-spawn so it is atomic.
        self._dedup_lock = threading.Lock()

    def execute_background(self, command: str) -> BackgroundHandle:
        target = _normalize(command)
        with self._dedup_lock:
            for proc in self._bg.values():
                if _normalize(proc.command) != target:
                    continue
                # poll() is None while the process is still alive.
                if proc.popen.poll() is None:
                    return BackgroundHandle(
                        shell_id=proc.shell_id,
                        pid=proc.popen.pid,
                        command=proc.command,
                    )
            return super().execute_background(command)

    def glob_info(self, pattern: str, path: str = ".") -> list[FileInfo]:
        """Glob without letting a bad ``pattern`` take the agent turn down with it.

        The base implementation runs ``base_path.glob(pattern)`` behind an
        ``except (PermissionError, OSError)`` guard, but pathlib rejects several
        patterns with exceptions that guard doesn't catch: ``NotImplementedError``
        ("Non-relative patterns are unsupported") for an absolute pattern,
        ``ValueError`` for ``""``, ``IndexError`` for ``"."``. Any of them
        propagates out of the tool call and aborts the whole turn.

        An absolute pattern is the common case rather than an exotic one — local
        reasoning models routinely echo back the workspace-absolute path they saw
        in earlier tool output — so those are rewritten to be base-relative and
        still return real matches. Anything else degrades to "no matches", which
        is already what the base backend returns for a path it can't read.
        """
        try:
            return super().glob_info(self._relative_pattern(pattern, path), path)
        except (NotImplementedError, ValueError, IndexError):
            return []

    def _relative_pattern(self, pattern: str, path: str) -> str:
        """Rewrite an absolute glob ``pattern`` to one relative to the glob base.

        ``glob_info`` globs from ``path`` (the workspace root by default), so that
        — not the backend root — is what an absolute pattern has to be made
        relative to. The pattern is resolved first so a symlinked spelling of the
        base (on macOS ``/tmp`` → ``/private/tmp``) still lines up with the
        already-resolved base; wildcard components survive ``resolve()`` untouched.

        A pattern pointing outside the base keeps only its non-root part, so it
        matches nothing — a wrong-but-empty answer the model can react to, rather
        than a dead turn. Relative patterns (the common case) pass through as-is.
        """
        candidate = Path(pattern)
        if not candidate.is_absolute():
            return pattern
        try:
            base = self._validate_path(path)
        except PermissionError:
            # ``super().glob_info`` re-validates ``path`` and returns [] for it.
            return pattern
        try:
            return str(candidate.resolve().relative_to(base))
        except ValueError:
            return str(candidate.relative_to(candidate.anchor))
