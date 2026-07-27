"""Everything a run needs to know about skills and their environment.

``build_deep_agent`` is synchronous, but resolving *which* skills apply (an
assignment in the database) and *what* env they carry both need a session. So the
async work happens here, once, and the result is handed to the builder as a single
value. A ``None`` runtime means "build without skills" — the honest default for
the few callers that have no session (tests, one-off helper agents).

What the builder does with it:

- ``skill_dirs`` → ``create_deep_agent(skill_directories=...)``, so the agent
  discovers the folders in scope;
- ``env_by_folder`` → the per-skill script executor
  (``app/skills/script_exec.py``), so ``run_skill_script`` gets exactly its own
  skill's vars;
- ``run_env`` → the workspace backend's shell environment plus the ``#
  Environment`` prompt section (names only, never values).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.envvars.resolve import ResolvedEnv, resolve_env, resolve_skill_env
from app.skills.resolve import ScopedSkill, skills_in_scope


@dataclass(frozen=True)
class SkillRuntime:
    """Resolved skills + environment for one run in one workspace."""

    scoped: tuple[ScopedSkill, ...] = ()
    # Union of every layer in scope: what the agent's shell gets.
    run_env: ResolvedEnv = field(default_factory=ResolvedEnv)
    # Skill folder (absolute path) -> env for that skill's own scripts.
    env_by_folder: dict[str, dict[str, str]] = field(default_factory=dict)

    @property
    def skill_dirs(self) -> list[str]:
        return [str(s.folder) for s in self.scoped]

    @property
    def secrets(self) -> tuple[str, ...]:
        """Values to redact from command/script output."""
        return self.run_env.secret_values


async def load_skill_runtime(
    session: AsyncSession,
    *,
    workspace_path: str | Path,
    workspace_id: str,
    include_skills: bool = True,
) -> SkillRuntime:
    """Resolve the skills in scope and the env that goes with them.

    ``include_skills=False`` (the agent's master skills switch) drops the skills
    *and* their vars, but keeps the global and workspace env layers: a workspace's
    ``DATABASE_URL`` is not a skill, so the skills toggle has no business hiding
    it.

    Resolving each skill's own env is a query per in-scope skill. That is a
    handful of cheap indexed lookups once per run, which buys the guarantee that a
    script can only ever see its own skill's secrets.
    """
    scoped = (
        await skills_in_scope(
            session, workspace_path=workspace_path, workspace_id=workspace_id
        )
        if include_skills
        else []
    )
    run_env = await resolve_env(
        session,
        workspace_id=workspace_id,
        skill_ids=[s.skill_id for s in scoped],
    )
    env_by_folder: dict[str, dict[str, str]] = {}
    for entry in scoped:
        skill_env = await resolve_skill_env(
            session, workspace_id=workspace_id, skill_id=entry.skill_id
        )
        if skill_env.values:
            env_by_folder[str(entry.folder)] = dict(skill_env.values)
    return SkillRuntime(
        scoped=tuple(scoped), run_env=run_env, env_by_folder=env_by_folder
    )
