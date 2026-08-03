"""An edit that leaves a file unparseable has to say so, and only when it did.

The check is delta-only by design (see ``agents/edit_syntax.py``): a file that was
already broken is the agent's business, not ours. These tests drive the real
console toolset over a real ``LocalBackend`` so the before/after reads are the
ones the capability actually performs.

The JS/TS path shells out to whatever the *workspace* provides, so it is tested
against a stub ``node_modules/.bin/esbuild`` — that keeps the test hermetic and
pins the contract we depend on (exit 0 parses, exit 1 is a syntax error, anything
else means the checker itself is broken and must stay silent).
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from pydantic_ai import Agent as PydanticAgent
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai_backends import LocalBackend
from pydantic_ai_backends.toolsets.console import create_console_toolset

from app.agents.edit_syntax import EditSyntaxCheck, _find_js_checker
from app.agents.file_editing import FileEditingGuards


@dataclass
class Deps:
    backend: Any


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    return tmp_path


@pytest.fixture
def backend(workspace: Path) -> LocalBackend:
    return LocalBackend(root_dir=str(workspace), enable_execute=False)


def _write(backend: LocalBackend, path: str, content: str) -> list[str]:
    """One agent turn that writes ``content`` to ``path``, returning tool results.

    ``FileEditingGuards`` is installed alongside the syntax check exactly as
    ``builder.py`` installs them, so the read-before-write guard is satisfied the
    way it is in production rather than bypassed.
    """
    calls = [("read_file", {"path": path}), ("write_file", {"path": path, "content": content})]
    step = {"i": 0}

    def respond(messages, info: AgentInfo):
        if step["i"] < len(calls):
            name, args = calls[step["i"]]
            step["i"] += 1
            return ModelResponse(parts=[ToolCallPart(name, args)])
        return ModelResponse(parts=[TextPart("done")])

    agent = PydanticAgent(
        FunctionModel(respond),
        deps_type=Deps,
        toolsets=[create_console_toolset(edit_format="hashline", include_execute=False)],
        capabilities=[FileEditingGuards(), EditSyntaxCheck()],
    )
    result = agent.run_sync("go", deps=Deps(backend=backend))

    return [
        str(part.content)
        for message in result.all_messages()
        for part in message.parts
        if type(part).__name__ == "ToolReturnPart"
    ]


def _syntax_notes(outputs: list[str]) -> list[str]:
    return [out for out in outputs if "Syntax check:" in out]


# --- In-process checkers ---------------------------------------------------------


def test_python_breakage_is_reported(backend):
    outputs = _write(backend, "mod.py", "def f(:\n    return 1\n")

    notes = _syntax_notes(outputs)
    assert len(notes) == 1
    assert "left mod.py unparseable" in notes[0]
    assert "line 1" in notes[0]
    # The write is not reverted — the model is told, and told what to do next.
    assert "Wrote" in notes[0] and "fix it before moving on" in notes[0]


def test_valid_python_is_not_annotated(backend):
    assert _syntax_notes(_write(backend, "mod.py", "def f():\n    return 1\n")) == []


def test_pre_existing_breakage_is_not_blamed_on_this_edit(backend, workspace):
    """A file that was already broken and is *still* broken stays quiet."""
    (workspace / "mod.py").write_text("def f(:\n    pass\n")

    outputs = _write(backend, "mod.py", "def f(:\n    return 2\n")

    assert _syntax_notes(outputs) == []


def test_fixing_a_broken_file_is_not_annotated(backend, workspace):
    (workspace / "mod.py").write_text("def f(:\n")

    assert _syntax_notes(_write(backend, "mod.py", "def f():\n    pass\n")) == []


def test_json_breakage_is_reported(backend):
    notes = _syntax_notes(_write(backend, "data.json", '{"a": 1,}\n'))
    assert len(notes) == 1 and "data.json" in notes[0]


def test_valid_json_is_not_annotated(backend):
    assert _syntax_notes(_write(backend, "data.json", '{"a": 1}\n')) == []


def test_yaml_breakage_is_reported(backend):
    notes = _syntax_notes(_write(backend, "conf.yaml", "a: 1\n  b: 2\n"))
    assert len(notes) == 1 and "conf.yaml" in notes[0]


def test_toml_breakage_is_reported(backend):
    notes = _syntax_notes(_write(backend, "conf.toml", "a = = 1\n"))
    assert len(notes) == 1 and "conf.toml" in notes[0]


def test_unknown_extensions_are_skipped(backend):
    """No parser, no opinion — prose and unknown formats are never flagged."""
    assert _syntax_notes(_write(backend, "notes.md", "# hi\n((((\n")) == []
    assert _syntax_notes(_write(backend, "data.bin", "\x00nonsense")) == []


def test_a_hashline_edit_is_checked_too(backend, workspace):
    """The check covers the edit tool, not just whole-file writes."""
    from pydantic_ai_backends.hashline import line_hash

    (workspace / "mod.py").write_text("def f():\n    return 1\n")

    step = {"i": 0}
    calls = [
        (
            "hashline_edit",
            {
                "path": "mod.py",
                "start_line": 1,
                "start_hash": line_hash("def f():"),
                "new_content": "def f(:",
            },
        )
    ]

    def respond(messages, info: AgentInfo):
        if step["i"] < len(calls):
            name, args = calls[step["i"]]
            step["i"] += 1
            return ModelResponse(parts=[ToolCallPart(name, args)])
        return ModelResponse(parts=[TextPart("done")])

    agent = PydanticAgent(
        FunctionModel(respond),
        deps_type=Deps,
        toolsets=[create_console_toolset(edit_format="hashline", include_execute=False)],
        capabilities=[FileEditingGuards(), EditSyntaxCheck()],
    )
    result = agent.run_sync("go", deps=Deps(backend=backend))
    outputs = [
        str(part.content)
        for message in result.all_messages()
        for part in message.parts
        if type(part).__name__ == "ToolReturnPart"
    ]

    assert len(_syntax_notes(outputs)) == 1


# --- JS/TS: the workspace's own tooling, or nothing ------------------------------


def _stub_esbuild(workspace: Path, *, exit_code: int, message: str = "") -> Path:
    """A fake ``esbuild`` with the real one's exit-code contract."""
    binary = workspace / "node_modules" / ".bin" / "esbuild"
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_text(
        "#!/bin/sh\n" + (f'echo "{message}" >&2\n' if message else "") + f"exit {exit_code}\n"
    )
    binary.chmod(0o755)
    return binary


def test_no_checker_in_the_workspace_means_no_check(backend, workspace, monkeypatch):
    """A workspace with no usable parser is skipped silently, not installed into."""
    monkeypatch.setattr("shutil.which", lambda _name: None)
    assert _find_js_checker(workspace) is None
    assert _syntax_notes(_write(backend, "app.ts", "const a: number = (1 +;\n")) == []


def test_esbuild_is_preferred_when_present(workspace):
    _stub_esbuild(workspace, exit_code=0)
    checker = _find_js_checker(workspace)
    assert checker is not None and checker.kind == "esbuild"


def test_typescript_is_the_fallback(workspace, monkeypatch):
    (workspace / "node_modules" / "typescript").mkdir(parents=True)
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/node" if name == "node" else None)

    checker = _find_js_checker(workspace)
    assert checker is not None and checker.kind == "typescript"


@pytest.mark.skipif(sys.platform == "win32", reason="stub checker is a shell script")
def test_ts_breakage_is_reported_via_the_workspace_checker(backend, workspace):
    _stub_esbuild(workspace, exit_code=1, message="app.ts:1:22: ERROR: Unexpected token")

    notes = _syntax_notes(_write(backend, "app.ts", "const a: number = (1 +;\n"))

    assert len(notes) == 1
    assert "app.ts unparseable" in notes[0]
    assert "Unexpected" in notes[0]


@pytest.mark.skipif(sys.platform == "win32", reason="stub checker is a shell script")
def test_a_parsing_ts_file_is_not_annotated(backend, workspace):
    _stub_esbuild(workspace, exit_code=0)

    assert _syntax_notes(_write(backend, "app.ts", "export const a = 1\n")) == []


@pytest.mark.skipif(sys.platform == "win32", reason="stub checker is a shell script")
def test_a_broken_checker_is_disabled_rather_than_blamed(backend, workspace):
    """Exit 3 is "the checker failed", e.g. TypeScript 7 with no single-file API."""
    _stub_esbuild(workspace, exit_code=3, message="Cannot find module 'typescript'")
    capability = EditSyntaxCheck()

    step = {"i": 0}
    calls = [("write_file", {"path": "app.ts", "content": "const a: number = (1 +;\n"})]

    def respond(messages, info: AgentInfo):
        if step["i"] < len(calls):
            name, args = calls[step["i"]]
            step["i"] += 1
            return ModelResponse(parts=[ToolCallPart(name, args)])
        return ModelResponse(parts=[TextPart("done")])

    agent = PydanticAgent(
        FunctionModel(respond),
        deps_type=Deps,
        toolsets=[create_console_toolset(edit_format="hashline", include_execute=False)],
        capabilities=[capability],
    )
    result = agent.run_sync("go", deps=Deps(backend=backend))
    outputs = [
        str(part.content)
        for message in result.all_messages()
        for part in message.parts
        if type(part).__name__ == "ToolReturnPart"
    ]

    assert _syntax_notes(outputs) == []
    # And it is not re-probed on the next edit in that workspace.
    assert capability._js_checkers[str(workspace)] is None


def test_oversized_files_are_skipped(backend, workspace, monkeypatch):
    """A minified bundle is not what this check is for."""
    monkeypatch.setattr("app.agents.edit_syntax.MAX_CHECK_BYTES", 64)

    assert _syntax_notes(_write(backend, "big.py", "def f(:\n" + "# pad\n" * 50)) == []


def test_the_check_survives_a_workspace_with_no_root(backend, workspace):
    """``_root_of`` returning None must skip the JS path, not raise."""
    from app.agents.edit_syntax import _root_of

    assert _root_of(object()) is None


def test_stub_checker_is_executable(workspace):
    """Guard the test's own premise: the stub has to actually be runnable."""
    binary = _stub_esbuild(workspace, exit_code=1)
    assert os.access(binary, os.X_OK)
