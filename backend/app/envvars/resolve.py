"""Resolve the environment variables a run (or one skill) should see.

Layers merge lowest → highest: **global** (every run) → **workspace** (this
directory) → **skill** (a skill in scope for the run). The later layer wins, so a
skill can override a workspace value and a workspace can override a global one.

Two entry points, because the runtime needs two different sets:

- :func:`resolve_env` — the union for a whole run, used for the agent's shell.
  A shell command can't be attributed to a skill (the agent runs ``curl``, not
  "skill X's ``curl``"), so every in-scope skill's vars are present.
- :func:`resolve_skill_env` — one skill's own view, used for
  ``run_skill_script``. A script therefore sees its own skill's vars plus the
  base layers, and never another skill's secrets.

Same-layer collisions (two in-scope skills both defining ``API_KEY``) are
resolved by skill slug ascending, last wins, and recorded in
:attr:`ResolvedEnv.conflicts` so the UI can warn. Sorting by slug rather than
query or directory order keeps the winner stable across runs.

Values are never logged from here. What reaches the model is names only
(``agents/builder.py``), and any secret value appearing in shell output is
redacted before it becomes tool output (``agents/deduping_backend.py``).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import EnvVar, EnvVarSkillLink, EnvVarWorkspaceLink, Skill

# Minimum length for a value to be redacted from command output. Below this,
# redaction does more harm than good: blanking every occurrence of a 3-character
# value would mangle unrelated output while protecting nothing worth protecting.
MIN_REDACT_LENGTH = 8


@dataclass(frozen=True)
class ResolvedEnv:
    """The effective environment for a run or a single skill."""

    # key -> value; exactly what gets injected into the child process.
    values: dict[str, str] = field(default_factory=dict)
    # key -> "global" | "workspace" | "skill:<slug>"; which layer won.
    provenance: dict[str, str] = field(default_factory=dict)
    # key -> every source that set it, when more than one did (lowest first).
    conflicts: dict[str, list[str]] = field(default_factory=dict)
    # key -> description, for the agent-facing listing.
    descriptions: dict[str, str] = field(default_factory=dict)

    @property
    def secret_values(self) -> tuple[str, ...]:
        """Values worth redacting from command output (longest first).

        Longest first so that when one value contains another, the longer match
        is replaced before the shorter one can split it.
        """
        return tuple(
            sorted(
                {v for k, v in self.values.items() if k in self._secret_keys},
                key=len,
                reverse=True,
            )
        )

    # Populated alongside ``values``; kept private because callers should go
    # through ``secret_values``.
    _secret_keys: frozenset[str] = field(default_factory=frozenset)

    def is_empty(self) -> bool:
        return not self.values


def _merge(
    layers: list[tuple[str, list[EnvVar]]],
) -> ResolvedEnv:
    """Fold ``(source, vars)`` layers in order; later layers win."""
    values: dict[str, str] = {}
    provenance: dict[str, str] = {}
    sources: dict[str, list[str]] = {}
    descriptions: dict[str, str] = {}
    secret_keys: set[str] = set()

    for source, rows in layers:
        for row in rows:
            values[row.key] = row.value
            provenance[row.key] = source
            sources.setdefault(row.key, []).append(source)
            if row.description:
                descriptions[row.key] = row.description
            if row.is_secret and len(row.value) >= MIN_REDACT_LENGTH:
                secret_keys.add(row.key)
            else:
                secret_keys.discard(row.key)

    return ResolvedEnv(
        values=values,
        provenance=provenance,
        conflicts={k: v for k, v in sources.items() if len(v) > 1},
        descriptions=descriptions,
        _secret_keys=frozenset(secret_keys),
    )


async def _global_vars(session: AsyncSession) -> list[EnvVar]:
    stmt = select(EnvVar).where(EnvVar.is_global.is_(True)).order_by(EnvVar.key)
    return list((await session.execute(stmt)).scalars().all())


async def _workspace_vars(session: AsyncSession, workspace_id: str) -> list[EnvVar]:
    stmt = (
        select(EnvVar)
        .join(EnvVarWorkspaceLink, EnvVarWorkspaceLink.env_var_id == EnvVar.id)
        .where(EnvVarWorkspaceLink.workspace_id == workspace_id)
        .order_by(EnvVar.key)
    )
    return list((await session.execute(stmt)).scalars().all())


async def _skill_layers(
    session: AsyncSession, skill_ids: Sequence[str]
) -> list[tuple[str, list[EnvVar]]]:
    """One layer per skill, ordered by slug so the winner is deterministic."""
    if not skill_ids:
        return []
    stmt = (
        select(Skill.slug, EnvVar)
        .join(EnvVarSkillLink, EnvVarSkillLink.env_var_id == EnvVar.id)
        .join(Skill, Skill.id == EnvVarSkillLink.skill_id)
        .where(EnvVarSkillLink.skill_id.in_(list(skill_ids)))
        .order_by(Skill.slug, EnvVar.key)
    )
    by_slug: dict[str, list[EnvVar]] = {}
    for slug, row in (await session.execute(stmt)).all():
        by_slug.setdefault(slug, []).append(row)
    return [(f"skill:{slug}", rows) for slug, rows in sorted(by_slug.items())]


async def resolve_env(
    session: AsyncSession, *, workspace_id: str, skill_ids: Sequence[str] = ()
) -> ResolvedEnv:
    """The union of every layer that applies to a run in ``workspace_id``.

    Pass the ids of the skills in scope (empty when the agent has skills off, in
    which case only the global and workspace layers apply — a workspace's
    ``DATABASE_URL`` is not a skill, so the skills toggle doesn't gate it).
    """
    return _merge(
        [
            ("global", await _global_vars(session)),
            ("workspace", await _workspace_vars(session, workspace_id)),
            *await _skill_layers(session, skill_ids),
        ]
    )


async def resolve_skill_env(
    session: AsyncSession, *, workspace_id: str, skill_id: str
) -> ResolvedEnv:
    """What one skill's scripts should see: base layers plus its own vars only."""
    return await resolve_env(session, workspace_id=workspace_id, skill_ids=[skill_id])


def redact(text: str, values: Sequence[str]) -> str:
    """Replace every occurrence of a secret value in ``text`` with a marker.

    The single choke point for secret hygiene: applied to command output before it
    becomes tool output, so one ``echo $TOKEN`` can't persist a secret into the
    transcript, the message history, or the AG-UI stream.
    """
    for value in values:
        if value and len(value) >= MIN_REDACT_LENGTH and value in text:
            text = text.replace(value, "***REDACTED***")
    return text
