"""``run_skill_script`` runs a script with its own skill's environment.

Covers ``app/skills/script_exec.py`` and the wiring in ``agents/builder.py`` that
hands pydantic-deep a ``SkillsDirectory`` per folder with that executor attached —
the one path where env injection is per-skill rather than per-run.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest
from pydantic_deep.features.skills import SkillsDirectory

from app.agents.builder import _skill_directories
from app.agents.skill_runtime import SkillRuntime
from app.envvars.resolve import ResolvedEnv
from app.skills.resolve import ScopedSkill
from app.skills.script_exec import SkillEnvScriptExecutor


@dataclass
class _Script:
    """The bits of ``SkillScript`` the executor touches."""

    name: str
    uri: str


def _skill_folder(root: Path, slug: str, body: str) -> Path:
    folder = root / slug
    (folder / "scripts").mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(f"---\nname: {slug}\ndescription: d\n---\n\nbody\n")
    (folder / "scripts" / "show.py").write_text(body)
    return folder


PRINT_ENV = (
    "import os, sys\n"
    "print(os.environ.get('A_KEY', 'missing-a'))\n"
    "print(os.environ.get('B_KEY', 'missing-b'))\n"
    "print(' '.join(sys.argv[1:]))\n"
)


async def test_script_sees_only_its_own_skill_env(tmp_path):
    alpha = _skill_folder(tmp_path, "alpha", PRINT_ENV)
    bravo = _skill_folder(tmp_path, "bravo", PRINT_ENV)
    executor = SkillEnvScriptExecutor(
        {str(alpha): {"A_KEY": "a-value"}, str(bravo): {"B_KEY": "b-value"}}
    )

    out_a = await executor.run(_Script("show.py", str(alpha / "scripts" / "show.py")))
    assert "a-value" in out_a and "missing-b" in out_a

    out_b = await executor.run(_Script("show.py", str(bravo / "scripts" / "show.py")))
    assert "b-value" in out_b and "missing-a" in out_b


async def test_script_output_is_redacted(tmp_path):
    folder = _skill_folder(
        tmp_path, "leaky", "import os\nprint(os.environ['LEAK'])\n"
    )
    executor = SkillEnvScriptExecutor(
        {str(folder): {"LEAK": "leaked-secret-value"}}, ("leaked-secret-value",)
    )
    out = await executor.run(_Script("show.py", str(folder / "scripts" / "show.py")))
    assert "leaked-secret-value" not in out
    assert "***REDACTED***" in out


async def test_script_args_are_formatted_like_the_library(tmp_path):
    folder = _skill_folder(tmp_path, "args", PRINT_ENV)
    executor = SkillEnvScriptExecutor({})
    out = await executor.run(
        _Script("show.py", str(folder / "scripts" / "show.py")),
        {"flag": True, "skip": False, "name": "x", "many": [1, 2], "nothing": None},
    )
    # True → bare flag, False/None dropped, list repeats the flag.
    assert "--flag" in out and "--skip" not in out and "--nothing" not in out
    assert "--name x" in out
    assert "--many 1 --many 2" in out


async def test_unregistered_folder_still_runs(tmp_path):
    """A skill with no attached vars runs exactly as before."""
    folder = _skill_folder(tmp_path, "plain", PRINT_ENV)
    executor = SkillEnvScriptExecutor({str(tmp_path / 'other'): {"A_KEY": "nope"}})
    out = await executor.run(_Script("show.py", str(folder / "scripts" / "show.py")))
    assert "missing-a" in out


async def test_failing_script_reports_exit_code(tmp_path):
    folder = _skill_folder(tmp_path, "boom", "import sys\nsys.exit(3)\n")
    executor = SkillEnvScriptExecutor({})
    out = await executor.run(_Script("show.py", str(folder / "scripts" / "show.py")))
    assert "exited with code 3" in out


async def test_missing_uri_raises(tmp_path):
    from pydantic_deep.features.skills.exceptions import SkillScriptExecutionError

    with pytest.raises(SkillScriptExecutionError):
        await SkillEnvScriptExecutor({}).run(_Script("show.py", None))  # type: ignore[arg-type]


def _runtime(folders: list[Path], env_by_folder: dict[str, dict[str, str]]):
    return SkillRuntime(
        scoped=tuple(
            ScopedSkill(
                skill_id=f"id-{f.name}",
                slug=f.name,
                name=f.name,
                folder=f,
                layer="global",
            )
            for f in folders
        ),
        run_env=ResolvedEnv(),
        env_by_folder=env_by_folder,
    )


def test_builder_builds_non_validating_directories_when_no_env(tmp_path):
    """No env anywhere → still our own ``SkillsDirectory``, just no custom executor.

    Handing the library a plain path would have it construct the directory itself,
    with ``validate=True`` — under which one malformed ``SKILL.md`` raises out of
    ``create_deep_agent`` and fails the whole build. See
    ``test_skill_malformed.py``.
    """
    folder = _skill_folder(tmp_path, "nodep", PRINT_ENV)
    dirs = _skill_directories(_runtime([folder], {}))
    assert len(dirs) == 1
    assert isinstance(dirs[0], SkillsDirectory)
    assert dirs[0]._validate is False
    assert not isinstance(dirs[0]._script_executor, SkillEnvScriptExecutor)
    assert list(dirs[0].get_skills()) == [str(folder)]


def test_builder_wires_the_env_executor_when_env_exists(tmp_path):
    """With env attached, each folder becomes a SkillsDirectory using our executor.

    This is the integration point that depends on pydantic-deep forwarding a
    ``SkillsDirectory`` instance untouched; if that ever changes, this fails.
    """
    folder = _skill_folder(tmp_path, "withenv", PRINT_ENV)
    dirs = _skill_directories(_runtime([folder], {str(folder): {"A_KEY": "v"}}))
    assert len(dirs) == 1
    assert isinstance(dirs[0], SkillsDirectory)
    assert isinstance(dirs[0]._script_executor, SkillEnvScriptExecutor)
    # The skill and its scripts are discovered through it (the directory keys by
    # folder path; the Skill itself carries the name from SKILL.md).
    discovered = list(dirs[0].get_skills().values())
    assert [s.name for s in discovered] == ["withenv"]
    assert [s.name for s in discovered[0].scripts] == ["scripts/show.py"]
    # ...and running one goes through our executor, so it gets the skill's env.
    assert discovered[0].scripts[0].executor is dirs[0]._script_executor


def test_builder_returns_nothing_without_a_runtime(tmp_path):
    assert _skill_directories(None) == []
