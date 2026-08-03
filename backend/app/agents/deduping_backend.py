"""The workspace :class:`LocalBackend`, with the rough edges of the base class
sanded off — and with the run's environment variables injected.

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

**Environment variables.** The base backend spawns every command with no ``env``
argument, so children inherit the *server process's* environment and a var the
user attached to a skill or workspace can never reach the agent's shell. Here the
resolved env (see ``app/envvars/resolve.py``) is injected into ``execute`` and
``execute_background``, and any secret value is redacted out of command output
before it becomes tool output — so one ``echo $TOKEN`` can't persist a secret into
the transcript, the message history, or the AG-UI stream.

The env is run-scoped through a :class:`~contextvars.ContextVar` rather than kept
on the instance, because one backend is shared by every run in a workspace
(``agents/builder.py``) and two concurrent runs there can legitimately resolve
different environments — an agent with skills switched off gets no skill vars.
``asyncio.to_thread`` (how the async adapter dispatches these calls) copies the
current context into the worker thread, and a child task inherits its parent's
context, so a value set once per run reaches every tool call and every subagent of
that run. :meth:`set_default_env` is the fallback for processes started outside
any run, such as an auto-restarted preview server.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import os
import re
import signal
import subprocess
import sys
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from pydantic_ai_backends import (
    BackgroundHandle,
    BackgroundOutput,
    ExecuteResponse,
    FileInfo,
    LocalBackend,
)
from pydantic_ai_backends.backends.local import shell_argv

from app.envvars.resolve import redact

# Pure file-descriptor redirections with no filename target (``2>&1``, ``1>&2``,
# ``>&1`` …). Stripping these before comparison means the model launching
# ``npm run dev`` and ``npm run dev 2>&1`` dedupes to one server rather than two.
_FD_REDIRECT = re.compile(r"\s*\d*>&\d+")


def _normalize(command: str) -> str:
    """Collapse whitespace and drop bare fd redirections so trivially-different
    spellings of the same command compare equal."""
    return re.sub(r"\s+", " ", _FD_REDIRECT.sub("", command)).strip()


def _kill_process_tree(process: asyncio.subprocess.Process) -> None:
    """Kill the subprocess and, on Unix, every grandchild it forked.

    Mirrors the base backend's private helper of the same name; ``async_execute``
    is reimplemented here (see :meth:`DedupingLocalBackend.async_execute`) and
    needs the same reaping behaviour.
    """
    if sys.platform == "win32":
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        return
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)


# Matches ``pydantic_ai_backends.backends.local.MAX_EXECUTE_OUTPUT``; ``execute``
# is reimplemented below (the base method takes no ``env``), so the cap has to be
# restated rather than inherited.
MAX_EXECUTE_OUTPUT = 100_000
# The base backend's default when the caller passes no timeout.
DEFAULT_EXECUTE_TIMEOUT = 120


@dataclass(frozen=True)
class RunEnv:
    """The environment one run injects, plus the values to redact from output."""

    values: dict[str, str] = field(default_factory=dict)
    secrets: tuple[str, ...] = ()

    def is_empty(self) -> bool:
        return not self.values and not self.secrets


_EMPTY_ENV = RunEnv()

# Set once per run, read at every shell call. See the module docstring for why
# this is a ContextVar and not instance state.
_run_env: contextvars.ContextVar[RunEnv] = contextvars.ContextVar(
    "lursor_run_env", default=_EMPTY_ENV
)

# Held while ``os.environ`` is temporarily patched for a background spawn (see
# ``execute_background``). Module-level rather than per-backend so a spawn in one
# workspace can never inherit another workspace's secrets.
_spawn_env_lock = threading.Lock()


def set_run_env(values: Mapping[str, str], secrets: tuple[str, ...] = ()) -> RunEnv:
    """Install this run's environment for the current context.

    Deliberately not reset: the value belongs to the task that set it (and the
    tasks it spawns), and each run resolves its own before use.
    """
    env = RunEnv(values=dict(values), secrets=secrets)
    _run_env.set(env)
    return env


def current_run_env() -> RunEnv:
    return _run_env.get()


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
        # Fallback env for spawns that happen outside any run (see module docstring).
        self._default_env = _EMPTY_ENV

    # --- Environment ----------------------------------------------------------

    def set_default_env(self, values: Mapping[str, str], secrets: tuple[str, ...] = ()) -> None:
        """Env for processes started outside a run, e.g. an auto-restarted server."""
        self._default_env = RunEnv(values=dict(values), secrets=secrets)

    def _env(self) -> RunEnv:
        """This call's env: the run's if one is active, else the workspace default."""
        env = _run_env.get()
        return env if not env.is_empty() else self._default_env

    def _spawn_env(self) -> dict[str, str] | None:
        """``env=`` for a subprocess spawn: ``None`` when there is nothing to add."""
        env = self._env()
        return {**os.environ, **env.values} if env.values else None

    def _response(self, output: str, returncode: int | None) -> ExecuteResponse:
        """Redact secrets, then apply the base backend's cap and exit-code shape."""
        output = redact(output, self._env().secrets)
        truncated = len(output) > MAX_EXECUTE_OUTPUT
        if truncated:
            output = output[:MAX_EXECUTE_OUTPUT]
        return ExecuteResponse(
            output=output,
            exit_code=returncode if returncode is not None else 1,
            truncated=truncated,
        )

    def execute(self, command: str, timeout: int | None = None) -> ExecuteResponse:
        """Run a command with the run's env injected and secrets redacted.

        Reimplemented rather than delegated because ``LocalBackend.execute`` calls
        ``subprocess.run`` with no ``env`` argument, and the whole point here is to
        supply one. Everything else matches the base method — the same permission
        check, the same default timeout, the same output cap and truncation flag,
        the same "Error: …"/exit-code shape — so behaviour is unchanged when no env
        is set. ``tests/test_deduping_backend.py`` pins that parity so an upstream
        change doesn't drift away unnoticed.
        """
        denial = self._execute_denial(command)
        if denial is not None:
            return ExecuteResponse(output=f"Error: {denial}", exit_code=1, truncated=False)

        try:
            result = subprocess.run(
                shell_argv(command),
                cwd=self._root,
                capture_output=True,
                text=True,
                timeout=timeout if timeout is not None else DEFAULT_EXECUTE_TIMEOUT,
                env=self._spawn_env(),
            )
        except subprocess.TimeoutExpired:
            return ExecuteResponse(
                output="Error: Command timed out", exit_code=124, truncated=False
            )
        except Exception as exc:  # noqa: BLE001 — mirrors the base backend
            return ExecuteResponse(output=f"Error: {exc}", exit_code=1, truncated=False)

        return self._response(result.stdout + result.stderr, result.returncode)

    async def async_execute(self, command: str, timeout: int | None = None) -> ExecuteResponse:
        """Cancellable :meth:`execute`, with the same env injection and redaction.

        This override is not optional. ``AsyncBackendAdapter`` prefers
        ``async_execute`` whenever the backend defines it as a coroutine
        (``pydantic_ai_backends/adapter.py``), so from backend 0.2.24 on, the
        agent's ``execute`` tool no longer reaches :meth:`execute` at all — the
        sync method above is left for direct callers. Without this override the
        run's environment silently stops being injected *and* secrets stop being
        redacted from tool output, which is the failure this module exists to
        prevent.

        Cancellation and timeout semantics mirror the base implementation: the
        child gets its own session on Unix so the whole tree is reaped rather
        than orphaned when a turn is stopped or the command overruns.
        """
        denial = self._execute_denial(command)
        if denial is not None:
            return ExecuteResponse(output=f"Error: {denial}", exit_code=1, truncated=False)

        try:
            process = await asyncio.create_subprocess_exec(
                *shell_argv(command),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self._root,
                env=self._spawn_env(),
                start_new_session=(sys.platform != "win32"),
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=timeout if timeout is not None else DEFAULT_EXECUTE_TIMEOUT,
                )
            except asyncio.CancelledError:
                _kill_process_tree(process)
                # Shielded so a second cancel cannot leave the pipes dangling.
                with contextlib.suppress(BaseException):
                    await asyncio.shield(asyncio.ensure_future(process.communicate()))
                raise
            except TimeoutError:
                _kill_process_tree(process)
                with contextlib.suppress(BaseException):
                    await process.communicate()
                return ExecuteResponse(
                    output="Error: Command timed out", exit_code=124, truncated=False
                )
        except Exception as exc:  # noqa: BLE001 — mirrors the base backend
            return ExecuteResponse(output=f"Error: {exc}", exit_code=1, truncated=False)

        output = stdout.decode("utf-8", errors="replace")
        output += stderr.decode("utf-8", errors="replace")
        return self._response(output, process.returncode)

    def execute_background(self, command: str) -> BackgroundHandle:
        """Reuse a live background process for an identical command, else spawn.

        Reads the roster through the public ``list_background`` rather than the
        backend's private process registry: backend 0.2.24 moved that bookkeeping
        behind a ``BackgroundProcesses`` helper, and ``BackgroundProcessInfo``
        already carries everything the dedup needs (command, pid, liveness).
        """
        target = _normalize(command)
        with self._dedup_lock:
            for proc in self.list_background():
                if proc.running and _normalize(proc.command) == target:
                    return BackgroundHandle(
                        shell_id=proc.shell_id,
                        pid=proc.pid,
                        command=proc.command,
                    )
            return self._spawn_background(command)

    def _spawn_background(self, command: str) -> BackgroundHandle:
        """Spawn via the base implementation, with this run's env in place.

        Unlike ``execute``, the base ``execute_background`` owns bookkeeping we
        don't want to duplicate (the output-file registry, the shell-id counter,
        the private process record). ``Popen`` inherits ``os.environ`` at spawn
        time, so the env is patched in around a call that returns in milliseconds,
        under a process-wide lock so a concurrent spawn for another workspace can't
        pick up these values. Long-running work happens *after* the spawn, outside
        the lock.
        """
        env = self._env()
        if not env.values:
            return super().execute_background(command)

        with _spawn_env_lock:
            saved = {key: os.environ.get(key) for key in env.values}
            os.environ.update(env.values)
            try:
                return super().execute_background(command)
            finally:
                for key, previous in saved.items():
                    if previous is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = previous

    def read_background(self, shell_id: str) -> BackgroundOutput:
        """Drain a background process's output, redacting any secret it printed.

        Dev servers echo their configuration on boot, so this is the likeliest
        place for an injected value to surface.
        """
        out = super().read_background(shell_id)
        secrets = self._env().secrets
        if not secrets:
            return out
        return BackgroundOutput(
            shell_id=out.shell_id,
            stdout=redact(out.stdout, secrets),
            stderr=redact(out.stderr, secrets),
            running=out.running,
            exit_code=out.exit_code,
        )

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
            base = self._resolve(path)
        except PermissionError:
            # ``super().glob_info`` re-validates ``path`` and returns [] for it.
            return pattern
        try:
            return str(candidate.resolve().relative_to(base))
        except ValueError:
            return str(candidate.relative_to(candidate.anchor))
