"""Regression tests for :class:`DedupingLocalBackend`.

The reported bug was three identical ``npm run dev`` terminals running at once.
Two gaps let duplicates slip past the dedup guard: a check-and-spawn race when a
turn fires several ``run_in_background`` calls concurrently, and fd redirections
(``2>&1``) making otherwise-identical commands compare as different.
"""

from __future__ import annotations

import tempfile
import threading

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
