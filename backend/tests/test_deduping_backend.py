"""Regression tests for :class:`DedupingLocalBackend`.

Background-process dedup: the reported bug was three identical ``npm run dev``
terminals running at once. Two gaps let duplicates slip past the dedup guard: a
check-and-spawn race when a turn fires several ``run_in_background`` calls
concurrently, and fd redirections (``2>&1``) making otherwise-identical commands
compare as different.

Globbing: ``LocalBackend.glob_info`` guards only ``(PermissionError, OSError)``,
so pathlib's other rejections — most often ``NotImplementedError`` on the
absolute pattern a local model hands the ``glob`` tool — escaped and aborted the
whole agent turn.
"""

from __future__ import annotations

import tempfile
import threading
from pathlib import Path

import pytest

from app.agents.deduping_backend import DedupingLocalBackend, _normalize


@pytest.fixture
def backend():
    with tempfile.TemporaryDirectory() as root:
        be = DedupingLocalBackend(root_dir=root)
        try:
            yield be
        finally:
            be.kill_all_background()


@pytest.fixture
def populated(backend):
    """A backend whose root holds ``a.py`` and ``pkg/b.py``."""
    root = backend.root_dir
    (root / "a.py").write_text("")
    (root / "pkg").mkdir()
    (root / "pkg" / "b.py").write_text("")
    return backend


def test_normalize_strips_fd_redirections():
    assert _normalize("npm run dev 2>&1") == _normalize("npm run dev") == "npm run dev"
    assert _normalize("npm  run   dev") == "npm run dev"


def test_identical_command_reuses_process(backend):
    first = backend.execute_background("sleep 30")
    second = backend.execute_background("sleep 30")
    assert first.shell_id == second.shell_id
    assert len(backend.list_background()) == 1


def test_fd_redirection_variants_dedupe(backend):
    first = backend.execute_background("sleep 30")
    second = backend.execute_background("sleep 30 2>&1")
    assert first.shell_id == second.shell_id
    assert len(backend.list_background()) == 1


def test_different_commands_spawn_separately(backend):
    backend.execute_background("sleep 30")
    backend.execute_background("sleep 31")
    assert len(backend.list_background()) == 2


def test_concurrent_calls_do_not_race(backend):
    """Fire many identical launches at once — the lock must collapse them to one."""
    barrier = threading.Barrier(8)

    def launch():
        barrier.wait()  # maximize overlap on the check-and-spawn
        backend.execute_background("sleep 30")

    threads = [threading.Thread(target=launch) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(backend.list_background()) == 1


# --- Globbing -----------------------------------------------------------------


def _names(infos) -> list[str]:
    return sorted(i["name"] for i in infos)  # FileInfo is a TypedDict


def test_base_class_crashes_on_an_absolute_pattern(populated):
    """Pin the upstream behaviour this override exists to contain.

    If pydantic-ai-backends ever fixes this, the override becomes dead weight and
    this test is the thing that says so.
    """
    pattern = f"{populated.root_dir}/*.py"
    with pytest.raises(NotImplementedError):
        super(DedupingLocalBackend, populated).glob_info(pattern)


def test_relative_pattern_is_untouched(populated):
    assert _names(populated.glob_info("*.py")) == ["a.py"]
    assert _names(populated.glob_info("**/*.py")) == ["a.py", "b.py"]


def test_absolute_pattern_matches_like_a_relative_one(populated):
    root = populated.root_dir
    assert _names(populated.glob_info(f"{root}/*.py")) == ["a.py"]
    assert _names(populated.glob_info(f"{root}/**/*.py")) == ["a.py", "b.py"]
    assert _names(populated.glob_info(f"{root}/pkg/*.py")) == ["b.py"]


def test_absolute_pattern_is_relative_to_the_glob_base_not_the_root(populated):
    """``path=`` moves the base, so the rewrite has to follow it."""
    root = populated.root_dir
    assert _names(populated.glob_info(f"{root}/pkg/*.py", path="pkg")) == ["b.py"]


def test_symlinked_absolute_pattern_still_matches():
    """The backend resolves its root; an unresolved pattern must still line up.

    On macOS a temp dir is handed out as ``/var/...`` but resolves to
    ``/private/var/...``, so a model echoing back the path it was given would
    otherwise fall through to the match-nothing branch.
    """
    with tempfile.TemporaryDirectory() as raw_root:
        (Path(raw_root) / "a.py").write_text("")
        be = DedupingLocalBackend(root_dir=raw_root)
        assert _names(be.glob_info(f"{raw_root}/*.py")) == ["a.py"]


def test_pattern_outside_the_root_matches_nothing(populated):
    assert populated.glob_info("/etc/*.conf") == []


@pytest.mark.parametrize("pattern", ["", ".", "/", "//"])
def test_degenerate_patterns_return_empty_instead_of_raising(populated, pattern):
    """``ValueError`` / ``IndexError`` out of pathlib must not reach the turn."""
    assert populated.glob_info(pattern) == []
