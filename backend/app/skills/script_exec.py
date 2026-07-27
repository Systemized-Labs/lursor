"""Run a skill's bundled scripts with that skill's own environment variables.

``run_skill_script`` normally goes through pydantic-deep's
``LocalSkillScriptExecutor``, which spawns ``python <script>`` with no ``env``
argument — so a script inherits the *backend process's* environment and can never
see a var the user attached to its skill.

This module supplies a ``CallableSkillScriptExecutor``-compatible function that
spawns the script with the env resolved for the skill that owns it. Ownership is
derived from the script's own path (``script.uri`` lives inside
``<root>/<slug>/``), so a single executor can serve every skill folder handed to
the agent while still giving each script only its own layer:

    global vars → workspace vars → *this skill's* vars

That is the precision the shell path can't offer (a shell command can't be
attributed to a skill), and it means one skill's scripts never see another
skill's secrets. Output is redacted before it is returned, so a script that
prints a token can't leak it into the transcript.

Everything else about execution matches the library's local executor — same
``--flag value`` argument formatting, same cwd (the script's folder), same
timeout semantics, same "(no output)" fallback — so switching executors changes
only the environment.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import anyio
from pydantic_deep.features.skills.exceptions import SkillScriptExecutionError

from app.envvars.resolve import redact

DEFAULT_TIMEOUT = 30


def _script_args(args: Mapping[str, Any] | None) -> list[str]:
    """Format named args as CLI flags, matching ``LocalSkillScriptExecutor``."""
    out: list[str] = []
    for key, value in (args or {}).items():
        if isinstance(value, bool):
            if value:
                out.append(f"--{key}")
        elif isinstance(value, list):
            for item in value:
                out += [f"--{key}", str(item)]
        elif value is not None:
            out += [f"--{key}", str(value)]
    return out


class SkillEnvScriptExecutor:
    """Executor that injects the owning skill's env into ``run_skill_script``.

    ``env_by_folder`` maps a skill folder (absolute path string) to the env that
    skill's scripts should see; ``secrets`` are the values to redact from output.
    A script whose folder isn't in the map (nothing attached to that skill) simply
    runs with the process environment, exactly as before.
    """

    def __init__(
        self,
        env_by_folder: Mapping[str, Mapping[str, str]],
        secrets: tuple[str, ...] = (),
        timeout: int = DEFAULT_TIMEOUT,
    ) -> None:
        self._env_by_folder = {str(Path(k).resolve()): dict(v) for k, v in env_by_folder.items()}
        self._secrets = secrets
        self.timeout = timeout

    def _env_for(self, script_path: Path) -> dict[str, str]:
        """The env for whichever registered skill folder contains this script."""
        resolved = script_path.resolve()
        # Longest folder first so a nested match wins over its parent.
        for folder in sorted(self._env_by_folder, key=len, reverse=True):
            if resolved == Path(folder) or Path(folder) in resolved.parents:
                return {**os.environ, **self._env_by_folder[folder]}
        return dict(os.environ)

    async def __call__(
        self, script: Any, args: dict[str, Any] | None = None
    ) -> str:
        """Signature required by ``CallableSkillScriptExecutor`` (kwargs only)."""
        return await self.run(script, args)

    async def run(self, script: Any, args: dict[str, Any] | None = None) -> str:
        if getattr(script, "uri", None) is None:
            raise SkillScriptExecutionError(
                f"Script '{getattr(script, 'name', '?')}' has no URI for execution"
            )
        script_path = Path(script.uri)
        cmd = [sys.executable, str(script_path), *_script_args(args)]

        try:
            result = None
            with anyio.move_on_after(self.timeout) as scope:
                result = await anyio.run_process(
                    cmd,
                    check=False,
                    cwd=str(script_path.parent),
                    env=self._env_for(script_path),
                )
            if scope.cancelled_caught or result is None:
                raise SkillScriptExecutionError(
                    f"Script '{script.name}' timed out after {self.timeout} seconds"
                )
        except OSError as exc:
            raise SkillScriptExecutionError(
                f"Failed to execute script '{script.name}': {exc}"
            ) from exc

        output = result.stdout.decode("utf-8", errors="replace")
        if result.stderr:
            output += f"\n\nStderr:\n{result.stderr.decode('utf-8', errors='replace')}"
        if result.returncode != 0:
            output += f"\n\nScript exited with code {result.returncode}"
        return redact(output.strip(), self._secrets) or "(no output)"
