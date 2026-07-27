"""A :class:`LocalBackend` that refuses to start a duplicate background process.

The base backend mints a fresh ``bg_N`` and spawns a new detached process on
*every* ``execute_background`` call, with no check for an identical command that
is already running. The only guard against duplicate dev servers was an advisory
system-prompt instruction (``DEV_SERVER_DIRECTIVE`` in ``builder.py``) telling the
model to run ``list_shells`` first and reuse a running server. That is unreliable:
across turns, compaction, or subagents the model loses sight of what it started
and spins up another ``npm run dev`` / ``npx serve`` — which is how the "3
terminals running" duplicates appeared, all with the identical command string.

``serve`` (and most dev servers) auto-increment the port when the requested one is
taken instead of failing, so the duplicates all stay alive and indistinguishable.

This subclass enforces the reuse in code: if a background process with the same
(whitespace-normalized) command is still running, ``execute_background`` returns a
handle to *that* process instead of spawning a second one. Different commands
still spawn normally, so restarting with new flags works as before.
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


def _relativize_glob(pattern: str, root: Path) -> str:
    """Rewrite an absolute glob pattern to one relative to the backend root.

    ``LocalBackend.glob_info`` runs ``root.glob(pattern)``, and pathlib rejects an
    absolute pattern with ``NotImplementedError: Non-relative patterns are
    unsupported`` — which escapes the backend's ``(PermissionError, OSError)``
    guard and aborts the whole agent turn. Local reasoning models routinely pass
    an absolute pattern (the workspace-absolute path they see in tool output), so
    normalize it: strip the workspace-root prefix when the pattern is inside the
    root, otherwise just drop the leading slash so the pattern stays relative.
    A relative pattern (the common case) is returned untouched.
    """
    if not pattern or not pattern.startswith("/"):
        return pattern
    try:
        return str(Path(pattern).relative_to(root))
    except ValueError:
        return pattern.lstrip("/")


class DedupingLocalBackend(LocalBackend):
    """``LocalBackend`` that reuses a running background process for an identical
    command rather than starting a duplicate."""

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
        """Glob, tolerating an absolute ``pattern`` instead of crashing on it.

        See ``_relativize_glob``: local models often hand the ``glob`` tool an
        absolute pattern, which pathlib refuses. Normalize to a root-relative
        pattern first so the turn continues instead of failing with "Non-relative
        patterns are unsupported".
        """
        return super().glob_info(_relativize_glob(pattern, self._root), path)
