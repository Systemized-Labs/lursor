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

from pydantic_ai_backends import BackgroundHandle, LocalBackend


def _normalize(command: str) -> str:
    """Collapse whitespace so trivially-different spellings compare equal."""
    return re.sub(r"\s+", " ", command).strip()


class DedupingLocalBackend(LocalBackend):
    """``LocalBackend`` that reuses a running background process for an identical
    command rather than starting a duplicate."""

    def execute_background(self, command: str) -> BackgroundHandle:
        target = _normalize(command)
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
