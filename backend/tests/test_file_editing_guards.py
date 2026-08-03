"""The hashline anchors have to be load-bearing, and ``write_file`` has to stop
clobbering files the agent never read.

Every test drives the *real* console toolset in hashline mode over a real
``LocalBackend``, through a real agent run — so a guard that works only against a
hand-rolled fake would fail here. Each one also pins the premise it fixes (what
the unguarded library does), so the guard can't quietly stop mattering after an
upstream release.

Reproductions and severities: ``docs/FILE-EDITING-AUDIT.md``.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from pydantic_ai import Agent as PydanticAgent
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import AgentInfo
from pydantic_ai_backends import LocalBackend
from pydantic_ai_backends.hashline import apply_hashline_edit_with_summary, line_hash
from pydantic_ai_backends.toolsets.console import create_console_toolset

from app.agents.file_editing import FileEditingGuards, hashline_stats, reset_hashline_stats


@dataclass
class Deps:
    """Minimal ``ConsoleDeps``: the console tools only ever read ``.backend``."""

    backend: Any


@pytest.fixture(autouse=True)
def _clean_stats():
    reset_hashline_stats()
    yield
    reset_hashline_stats()


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    return tmp_path


@pytest.fixture
def backend(workspace: Path) -> LocalBackend:
    return LocalBackend(root_dir=str(workspace), enable_execute=False)


def _agent(backend: LocalBackend, calls: list[tuple[str, dict]], *, guards: bool):
    """An agent scripted to make ``calls`` in order, then answer with text."""
    from pydantic_ai.models.function import FunctionModel

    step = {"i": 0}

    def respond(messages, info: AgentInfo):
        if step["i"] < len(calls):
            name, args = calls[step["i"]]
            step["i"] += 1
            return ModelResponse(parts=[ToolCallPart(name, args)])
        return ModelResponse(parts=[TextPart("done")])

    return PydanticAgent(
        FunctionModel(respond),
        deps_type=Deps,
        toolsets=[create_console_toolset(edit_format="hashline", include_execute=False)],
        capabilities=[FileEditingGuards()] if guards else None,
    )


def _tool_outputs(result) -> list[str]:
    """The tool results as the model saw them, in order."""
    return [
        str(part.content)
        for message in result.all_messages()
        for part in message.parts
        if type(part).__name__ == "ToolReturnPart"
    ]


def _run(backend: LocalBackend, calls: list[tuple[str, dict]], *, guards: bool = True):
    """Run one agent turn that makes ``calls`` in order, returning the tool results."""
    agent = _agent(backend, calls, guards=guards)
    return _tool_outputs(agent.run_sync("go", deps=Deps(backend=backend)))


async def _arun(backend: LocalBackend, calls: list[tuple[str, dict]], *, guards: bool = True):
    """:func:`_run` for a test that already has a running event loop."""
    agent = _agent(backend, calls, guards=guards)
    return _tool_outputs(await agent.run("go", deps=Deps(backend=backend)))


# --- Finding 1: a range edit must validate both ends -----------------------------


def test_the_library_alone_destroys_drifted_content():
    """The premise. ``end_hash`` is optional, so the end anchor is never checked."""
    original = "".join(f"line{i}\n" for i in range(1, 8))
    drifted = original.replace("line4", "IMPORTANT_NEW_CODE")

    new_text, error, _summary = apply_hashline_edit_with_summary(
        drifted,
        start_line=2,
        start_hash=line_hash("line2"),
        new_content="replacement",
        end_line=4,
        end_hash=None,
    )

    assert error is None
    assert "IMPORTANT_NEW_CODE" not in new_text


def test_range_edit_without_end_hash_is_refused(backend, workspace):
    target = workspace / "app.py"
    target.write_text("".join(f"line{i}\n" for i in range(1, 8)))

    outputs = _run(
        backend,
        [
            (
                "hashline_edit",
                {
                    "path": "app.py",
                    "start_line": 2,
                    "start_hash": line_hash("line2"),
                    "new_content": "replacement",
                    "end_line": 4,
                },
            )
        ],
    )

    assert any("needs end_hash" in out for out in outputs)
    # The file is untouched: the guard runs before the edit, not after.
    assert target.read_text() == "".join(f"line{i}\n" for i in range(1, 8))
    assert hashline_stats().missing_end_hash == 1
    assert hashline_stats().edits == 0


def test_range_edit_with_both_anchors_still_works(backend, workspace):
    target = workspace / "app.py"
    target.write_text("".join(f"line{i}\n" for i in range(1, 8)))

    outputs = _run(
        backend,
        [
            (
                "hashline_edit",
                {
                    "path": "app.py",
                    "start_line": 2,
                    "start_hash": line_hash("line2"),
                    "new_content": "replacement",
                    "end_line": 4,
                    "end_hash": line_hash("line4"),
                },
            )
        ],
    )

    assert any("Replaced 3 line(s)" in out for out in outputs)
    assert target.read_text() == "line1\nreplacement\nline5\nline6\nline7\n"
    assert hashline_stats().edits == 1


def test_a_single_line_edit_needs_no_end_hash(backend, workspace):
    """Only *ranges* are affected — the common single-line edit is unchanged."""
    target = workspace / "app.py"
    target.write_text("alpha\nbeta\ngamma\n")

    _run(
        backend,
        [
            (
                "hashline_edit",
                {
                    "path": "app.py",
                    "start_line": 2,
                    "start_hash": line_hash("beta"),
                    "new_content": "BETA",
                },
            )
        ],
    )

    assert target.read_text() == "alpha\nBETA\ngamma\n"
    assert hashline_stats().missing_end_hash == 0


# --- Finding 6: an anchor miss returns fresh anchors -----------------------------


def test_mismatch_reports_where_the_anchor_moved_to(backend, workspace):
    """The formatter-on-save case: the line still exists, two lines further down."""
    target = workspace / "app.py"
    target.write_text("import os\nimport sys\n\n\ndef f():\n    return 1\n")

    outputs = _run(
        backend,
        [
            (
                "hashline_edit",
                {
                    # The model read this file before two imports were added, so it
                    # thinks `def f():` is at line 3.
                    "path": "app.py",
                    "start_line": 3,
                    "start_hash": line_hash("def f():"),
                    "new_content": "def f(x):",
                },
            )
        ],
    )

    enriched = next(out for out in outputs if "Hash mismatch" in out)
    assert "is now line 5" in enriched
    assert "+2" in enriched
    # Fresh anchors for the neighbourhood, in read_file's own tagging, so the
    # model can retry without spending a re-read.
    assert f"5:{line_hash('def f():')}|def f():" in enriched
    assert "retry from them without re-reading" in enriched

    stats = hashline_stats()
    assert stats.mismatches == 1 and stats.recovered_anchors == 1
    assert stats.mismatch_rate == 1.0


def test_mismatch_says_so_when_the_content_really_changed(backend, workspace):
    target = workspace / "app.py"
    target.write_text("alpha\ncompletely different\ngamma\n")

    outputs = _run(
        backend,
        [
            (
                "hashline_edit",
                {
                    "path": "app.py",
                    "start_line": 2,
                    "start_hash": line_hash("beta"),
                    "new_content": "BETA",
                },
            )
        ],
    )

    enriched = next(out for out in outputs if "Hash mismatch" in out)
    assert "content itself changed" in enriched
    # Still re-tagged, so the model can act without a re-read either way.
    assert f"2:{line_hash('completely different')}|" in enriched
    assert hashline_stats().recovered_anchors == 0


def test_a_clean_edit_is_not_annotated(backend, workspace):
    target = workspace / "app.py"
    target.write_text("alpha\nbeta\n")

    outputs = _run(
        backend,
        [
            (
                "hashline_edit",
                {
                    "path": "app.py",
                    "start_line": 1,
                    "start_hash": line_hash("alpha"),
                    "new_content": "ALPHA",
                },
            )
        ],
    )

    assert not any("Hash mismatch" in out for out in outputs)
    assert hashline_stats().mismatches == 0


# --- Finding 4: read before you overwrite ----------------------------------------


def test_write_file_over_an_unread_file_is_refused(backend, workspace):
    target = workspace / "important.py"
    target.write_text("VALUE = 1\n")

    outputs = _run(backend, [("write_file", {"path": "important.py", "content": "gone\n"})])

    assert any("has not read it" in out for out in outputs)
    assert target.read_text() == "VALUE = 1\n"
    assert hashline_stats().blocked_writes == 1


def test_write_file_is_allowed_after_a_read(backend, workspace):
    target = workspace / "important.py"
    target.write_text("VALUE = 1\n")

    _run(
        backend,
        [
            ("read_file", {"path": "important.py"}),
            ("write_file", {"path": "important.py", "content": "VALUE = 2\n"}),
        ],
    )

    assert target.read_text() == "VALUE = 2\n"
    assert hashline_stats().blocked_writes == 0


def test_creating_a_new_file_is_never_blocked(backend, workspace):
    outputs = _run(backend, [("write_file", {"path": "new.py", "content": "x = 1\n"})])

    assert (workspace / "new.py").read_text() == "x = 1\n"
    assert not any("has not read it" in out for out in outputs)
    assert hashline_stats().blocked_writes == 0


def test_rewriting_a_file_this_agent_just_wrote_is_allowed(backend, workspace):
    _run(
        backend,
        [
            ("write_file", {"path": "new.py", "content": "x = 1\n"}),
            ("write_file", {"path": "new.py", "content": "x = 2\n"}),
        ],
    )

    assert (workspace / "new.py").read_text() == "x = 2\n"
    assert hashline_stats().blocked_writes == 0


def test_a_relative_read_covers_an_absolute_write(backend, workspace):
    """The model mixes path spellings freely; the guard must not fire on that."""
    target = workspace / "sub" / "mod.py"
    target.parent.mkdir()
    target.write_text("A = 1\n")

    _run(
        backend,
        [
            ("read_file", {"path": "sub/mod.py"}),
            ("write_file", {"path": str(target), "content": "A = 2\n"}),
        ],
    )

    assert target.read_text() == "A = 2\n"
    assert hashline_stats().blocked_writes == 0


def test_an_edit_counts_as_knowing_the_file(backend, workspace):
    """A matching anchor proves the agent's picture of the file was current."""
    target = workspace / "app.py"
    target.write_text("alpha\nbeta\n")

    _run(
        backend,
        [
            (
                "hashline_edit",
                {
                    "path": "app.py",
                    "start_line": 1,
                    "start_hash": line_hash("alpha"),
                    "new_content": "ALPHA",
                },
            ),
            ("write_file", {"path": "app.py", "content": "rewritten\n"}),
        ],
    )

    assert target.read_text() == "rewritten\n"
    assert hashline_stats().blocked_writes == 0


def test_the_library_alone_allows_the_blind_overwrite(backend, workspace):
    """The premise: without the capability the destructive write goes through."""
    target = workspace / "important.py"
    target.write_text("VALUE = 1\n")

    _run(
        backend,
        [("write_file", {"path": "important.py", "content": "gone\n"})],
        guards=False,
    )

    assert target.read_text() == "gone\n"


# --- The write_file description has to name a tool that exists -------------------


async def test_write_file_description_is_retargeted_at_hashline_edit():
    """The library tells the model to prefer ``edit_file`` in *both* edit formats."""
    from dataclasses import dataclass as _dataclass

    from pydantic_ai.tools import ToolDefinition
    from pydantic_ai_backends.toolsets.descriptions import WRITE_FILE_DESCRIPTION

    assert "`edit_file`" in WRITE_FILE_DESCRIPTION  # the premise, at this version

    @_dataclass
    class _Ctx:
        deps: Any = None

    defs = [
        ToolDefinition(name="write_file", description=WRITE_FILE_DESCRIPTION),
        ToolDefinition(name="hashline_edit", description="edit by anchor"),
    ]
    prepared = await FileEditingGuards().prepare_tools(_Ctx(), defs)

    write = next(td for td in prepared if td.name == "write_file")
    assert "`edit_file`" not in (write.description or "")
    assert "`hashline_edit`" in (write.description or "")
    assert "read an existing file before overwriting" in (write.description or "")
    # The edit tool's own description is untouched.
    assert next(td for td in prepared if td.name == "hashline_edit").description == "edit by anchor"


async def test_str_replace_mode_descriptions_are_left_alone():
    """With ``edit_format="str_replace"`` the library's advice is already correct."""
    from dataclasses import dataclass as _dataclass

    from pydantic_ai.tools import ToolDefinition
    from pydantic_ai_backends.toolsets.descriptions import WRITE_FILE_DESCRIPTION

    @_dataclass
    class _Ctx:
        deps: Any = None

    defs = [
        ToolDefinition(name="write_file", description=WRITE_FILE_DESCRIPTION),
        ToolDefinition(name="edit_file", description="string replacement"),
    ]
    prepared = await FileEditingGuards().prepare_tools(_Ctx(), defs)

    assert prepared == defs


# --- Instrumentation -------------------------------------------------------------


async def test_stats_are_readable_over_the_api(client, backend, workspace):
    """The audit's open question needs the number to be retrievable, not just logged."""
    target = workspace / "app.py"
    target.write_text("alpha\n")

    await _arun(
        backend,
        [
            (
                "hashline_edit",
                {
                    "path": "app.py",
                    "start_line": 1,
                    "start_hash": line_hash("nope"),
                    "new_content": "x",
                },
            )
        ],
    )

    body = (await client.get("/analytics/file-editing")).json()
    assert body["edits"] == 1
    assert body["mismatches"] == 1
    assert body["mismatch_rate"] == 1.0


def test_stats_accumulate_across_calls(backend, workspace):
    target = workspace / "app.py"
    target.write_text("alpha\nbeta\ngamma\n")

    _run(
        backend,
        [
            # One clean edit...
            (
                "hashline_edit",
                {
                    "path": "app.py",
                    "start_line": 1,
                    "start_hash": line_hash("alpha"),
                    "new_content": "ALPHA",
                },
            ),
            # ...and one on a stale anchor.
            (
                "hashline_edit",
                {
                    "path": "app.py",
                    "start_line": 1,
                    "start_hash": line_hash("alpha"),
                    "new_content": "AGAIN",
                },
            ),
        ],
    )

    stats = hashline_stats()
    assert stats.edits == 2
    assert stats.mismatches == 1
    assert stats.mismatch_rate == 0.5
