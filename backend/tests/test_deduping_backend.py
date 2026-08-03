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


# --- Environment injection + secret redaction ----------------------------------
#
# ``execute`` is reimplemented (the base method takes no ``env=``), so these pin
# both the new behaviour and parity with the base backend's contract.


def test_execute_parity_without_env(backend):
    """With no env set, ``execute`` behaves exactly like the base implementation."""
    ok = backend.execute("echo hi")
    assert ok.output.strip() == "hi" and ok.exit_code == 0 and ok.truncated is False

    failed = backend.execute("exit 7")
    assert failed.exit_code == 7

    # Timeout maps to the base backend's sentinel rather than raising.
    timed_out = backend.execute("sleep 2", timeout=1)
    assert timed_out.exit_code == 124 and "timed out" in timed_out.output

    # cwd is the backend root, as before.
    assert backend.execute("pwd").output.strip().endswith(backend.root_dir.name)


def test_execute_truncates_long_output(backend):
    from app.agents.deduping_backend import MAX_EXECUTE_OUTPUT

    r = backend.execute(f"python3 -c \"print('x' * {MAX_EXECUTE_OUTPUT + 500})\"")
    assert r.truncated is True and len(r.output) == MAX_EXECUTE_OUTPUT


def test_run_env_is_injected_and_redacted(backend):
    from app.agents.deduping_backend import set_run_env

    set_run_env({"MY_TOKEN": "tok-abcdefghij"}, ("tok-abcdefghij",))
    try:
        # The variable reaches the child process...
        present = backend.execute('test -n "$MY_TOKEN" && echo present')
        assert present.output.strip() == "present"
        # ...but echoing it back never puts the value in tool output.
        assert backend.execute("echo $MY_TOKEN").output.strip() == "***REDACTED***"
    finally:
        set_run_env({}, ())


def test_run_env_does_not_leak_across_contexts(backend):
    """A second run in the same workspace must not inherit the first one's env."""
    import contextvars

    from app.agents.deduping_backend import set_run_env

    def with_secret() -> str:
        set_run_env({"SCOPED": "scoped-value-1"}, ("scoped-value-1",))
        return backend.execute("echo ${SCOPED:-unset}").output.strip()

    def without_secret() -> str:
        return backend.execute("echo ${SCOPED:-unset}").output.strip()

    assert contextvars.copy_context().run(with_secret) == "***REDACTED***"
    # A sibling context (another run) never saw the set().
    assert contextvars.copy_context().run(without_secret) == "unset"


def test_default_env_covers_spawns_outside_a_run(backend):
    """``set_default_env`` is the fallback for out-of-run processes."""
    backend.set_default_env({"WS_VAR": "workspace-value"})
    assert backend.execute("echo $WS_VAR").output.strip() == "workspace-value"


def test_background_process_inherits_run_env(backend):
    import time

    from app.agents.deduping_backend import set_run_env

    set_run_env({"BG_TOKEN": "bg-secret-value"}, ("bg-secret-value",))
    try:
        out_file = backend.root_dir / "bg.txt"
        backend.execute_background(f'echo "$BG_TOKEN" > {out_file}')
        for _ in range(50):
            if out_file.exists() and out_file.read_text().strip():
                break
            time.sleep(0.05)
        assert out_file.read_text().strip() == "bg-secret-value"
        # os.environ is restored after the spawn, so nothing leaks process-wide.
        import os

        assert "BG_TOKEN" not in os.environ
    finally:
        set_run_env({}, ())


# --- async_execute -------------------------------------------------------------
#
# From pydantic-ai-backend 0.2.24 the async adapter prefers ``async_execute``
# whenever the backend defines it, so this — not ``execute`` — is the method the
# agent's shell tool actually reaches. These pin that the env injection and the
# redaction survive on that path; without the override both silently stop.


async def test_async_execute_is_the_path_the_adapter_takes(backend):
    """The adapter picks ``async_execute``, and ours is the one it finds."""
    import inspect

    from pydantic_ai_backends import ensure_async

    from app.agents.deduping_backend import set_run_env

    assert inspect.iscoroutinefunction(backend.async_execute)
    assert backend.async_execute.__qualname__.startswith("DedupingLocalBackend")

    # ``ensure_async`` is what the console toolset wraps the backend in, so this
    # is the dispatch the agent's ``execute`` tool goes through.
    adapter = ensure_async(backend)
    set_run_env({"ROUTED": "routed-secret"}, ("routed-secret",))
    try:
        result = await adapter.execute("echo $ROUTED")
        assert result.output.strip() == "***REDACTED***"
    finally:
        set_run_env({}, ())


async def test_async_execute_parity_without_env(backend):
    ok = await backend.async_execute("echo hi")
    assert ok.output.strip() == "hi" and ok.exit_code == 0 and ok.truncated is False

    failed = await backend.async_execute("exit 7")
    assert failed.exit_code == 7

    timed_out = await backend.async_execute("sleep 2", timeout=1)
    assert timed_out.exit_code == 124 and "timed out" in timed_out.output

    pwd = await backend.async_execute("pwd")
    assert pwd.output.strip().endswith(backend.root_dir.name)


async def test_async_execute_injects_env_and_redacts_secrets(backend):
    from app.agents.deduping_backend import set_run_env

    set_run_env({"MY_TOKEN": "tok-abcdefghij"}, ("tok-abcdefghij",))
    try:
        present = await backend.async_execute('test -n "$MY_TOKEN" && echo present')
        assert present.output.strip() == "present"
        leaked = await backend.async_execute("echo $MY_TOKEN")
        assert leaked.output.strip() == "***REDACTED***"
    finally:
        set_run_env({}, ())


async def test_async_execute_truncates_long_output(backend):
    from app.agents.deduping_backend import MAX_EXECUTE_OUTPUT

    r = await backend.async_execute(f"python3 -c \"print('x' * {MAX_EXECUTE_OUTPUT + 500})\"")
    assert r.truncated is True and len(r.output) == MAX_EXECUTE_OUTPUT


async def test_async_execute_cancellation_reaps_the_process_tree(backend):
    """Stopping a turn must not orphan the command's children."""
    import asyncio

    marker = backend.root_dir / "orphan.txt"
    task = asyncio.create_task(
        backend.async_execute(f"sh -c 'sleep 5; echo alive > {marker}' & wait")
    )
    await asyncio.sleep(0.3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # The grandchild died with its session rather than finishing the write.
    await asyncio.sleep(0.5)
    assert not marker.exists()


def test_read_background_redacts_secrets(backend):
    import time

    from app.agents.deduping_backend import set_run_env

    set_run_env({"LOG_TOKEN": "log-secret-value"}, ("log-secret-value",))
    try:
        backend.execute_background('echo "starting with $LOG_TOKEN"')
        drained = ""
        for _ in range(50):
            drained += backend.read_background("bg_1").stdout
            if drained.strip():
                break
            time.sleep(0.05)
        assert "log-secret-value" not in drained
        assert "***REDACTED***" in drained
    finally:
        set_run_env({}, ())
