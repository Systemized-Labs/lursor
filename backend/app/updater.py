"""What this backend is, and whether it can replace itself.

Two jobs, deliberately kept apart from the routes in ``api/update.py``:

1. **Describe the install.** ``GET /api/server-info`` needs to tell a client that
   isn't on this host what version it reached and whether it can be updated from
   the UI. Everything here is local and cheap — no network, no ``git fetch`` — so
   it is safe on an endpoint the app already fetches on connect.

2. **Own the self-update job.** The awkward part: this process is what gets
   restarted, so it cannot supervise its own replacement. The job is therefore
   spawned into its own session and reports back through two files under the data
   directory rather than through a return value nobody would be alive to read.

Nothing here is async. The network half of the update check lives in
``api/update.py`` where there is an event loop and an httpx client to use.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Literal

from . import __version__
from .config import get_settings
from .service import launchd_plist_path, systemd_unit_path

InstallKind = Literal["bundled", "checkout"]
ManagedBy = Literal["desktop", "service", "none"]

# Defaults shared with scripts/install-server.sh and the Electron updater, so all
# three agree on where updates come from without a config file to keep in sync.
DEFAULT_REPO = "Systemized-Labs/lursor"
DEFAULT_REF = "main"

LOG_NAME = "update.log"
STATE_NAME = "update-state.json"
EXIT_NAME = "update-exit-code"

# How long a job may claim to be ``running`` before we stop believing it. Generous,
# because a cold ``uv sync`` on a slow box genuinely takes minutes — but finite, so a
# job that died without writing its exit status cannot block self-update permanently.
_STALE_AFTER = 60 * 60


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def data_root() -> Path:
    """The writable state directory.

    Resolved from the environment the same way ``config._env_files`` does it, not
    from ``settings.data_dir`` — that field is None for source runs, whereas this
    has to name a real directory in every mode. It matters *which* directory: the
    update log has to outlive a ``git reset --hard`` of the checkout, so it cannot
    live in the tree (see ``docs/REMOTE.md`` on ``~/lursor`` being disposable and
    ``~/.lursor`` not).
    """
    return Path(os.environ.get("LURSOR_DATA_DIR", "~/.lursor")).expanduser()


def backend_dir() -> Path:
    """The ``backend/`` directory — where ``app.main:app`` resolves from."""
    return Path(__file__).resolve().parent.parent


def repo_root() -> Path:
    """The checkout root, when there is one. Meaningless for a frozen bundle."""
    return backend_dir().parent


def log_path() -> Path:
    return data_root() / LOG_NAME


def state_path() -> Path:
    return data_root() / STATE_NAME


def exit_path() -> Path:
    return data_root() / EXIT_NAME


def update_script() -> Path:
    return repo_root() / "scripts" / "self-update.sh"


# ---------------------------------------------------------------------------
# What kind of install is this
# ---------------------------------------------------------------------------


def install_kind() -> InstallKind:
    """Whether the code came from git or from a frozen bundle.

    ``.git`` is checked with ``exists()`` rather than ``is_dir()`` on purpose: in a
    worktree or a submodule it is a file.
    """
    return "checkout" if (repo_root() / ".git").exists() else "bundled"


def managed_by() -> ManagedBy:
    """Who owns this process's lifecycle.

    ``desktop`` is declared by Electron (``LURSOR_MANAGED_BY``) rather than sniffed,
    because the honest answer isn't visible from in here — a ``bun run
    electron:dev`` backend is an ordinary checkout that happens to have a parent
    holding its process group. Guessing from ``sys.frozen`` or path shape gets that
    case wrong, and it is the case a developer hits first.
    """
    if os.environ.get("LURSOR_MANAGED_BY") == "desktop":
        return "desktop"
    if systemd_unit_path().exists() or launchd_plist_path().exists():
        return "service"
    return "none"


def update_repo() -> str:
    return os.environ.get("LURSOR_REPO") or DEFAULT_REPO


def pinned_ref() -> str | None:
    """The ref this host was told to track, if the operator named one.

    ``None`` means "follow stable releases", which is what an update targets by
    default: the channel is release-only, so moving the deployment to the newest
    release *tag* is the only thing consistent with it. Tracking ``main`` would put
    the host on commits that belong to no version, and then the version it reports
    means nothing. An operator who sets ``LURSOR_REF`` explicitly has chosen a
    branch and keeps it.
    """
    return os.environ.get("LURSOR_REF") or None


def self_update_blocker() -> str | None:
    """Why this backend can't update itself, or None when it can.

    Returned as prose rather than a bool because every one of these has a different
    correct next step for the operator, and a bare ``false`` in the UI would send
    them looking for a bug instead. Ordered most-specific first so the message
    names the actual obstacle.
    """
    if os.environ.get("LURSOR_DISABLE_SELF_UPDATE", "").strip() not in ("", "0", "false"):
        return "Self-update is disabled on this host (LURSOR_DISABLE_SELF_UPDATE)."
    if install_kind() == "bundled":
        return (
            "This backend is the frozen copy shipped inside the desktop app. "
            "Updating the app replaces it."
        )
    if managed_by() == "desktop":
        return (
            "The desktop app owns this backend's process and would respawn the old "
            "code. Update the app instead."
        )
    if managed_by() != "service":
        return (
            "No supervised service to restart. Install one with "
            "`uv run lursor-service install`, or upgrade with scripts/install-server.sh."
        )
    if not get_settings().auth_token:
        return (
            "Self-update needs an authenticated backend. Set LURSOR_AUTH_TOKEN "
            "(scripts/install-server.sh does this for you)."
        )
    if not update_script().exists():
        return f"{update_script()} is missing from this checkout."
    return None


def git_head() -> dict[str, str | None] | None:
    """``{ref, commit}`` for the checkout, or None when it can't be read.

    Best effort: a deployment whose ``.git`` is unreadable is still a working
    backend, and a version lookup must never be the thing that breaks it.
    """
    if install_kind() != "checkout":
        return None
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=repo_root(),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if commit.returncode != 0:
            return None
        return {"ref": pinned_ref(), "commit": commit.stdout.strip()}
    except (OSError, subprocess.SubprocessError):
        return None


def describe() -> dict[str, object]:
    """The handshake fields for ``GET /api/server-info``. Local and cheap."""
    blocker = self_update_blocker()
    return {
        "version": __version__,
        "install_kind": install_kind(),
        "managed_by": managed_by(),
        "self_updatable": blocker is None,
        "self_update_blocked_reason": blocker,
    }


# ---------------------------------------------------------------------------
# The update job
# ---------------------------------------------------------------------------


def read_state() -> dict[str, object] | None:
    """The last update job's state, reconciled against the exit-code file.

    The job outlives the process that started it, so "did it finish" cannot be
    answered from memory — the state file says ``running`` right up until the
    script's EXIT trap drops its status next to it. Reconcile on read so a status
    poll after the restart reports the truth even though nothing was watching.
    """
    try:
        state = json.loads(state_path().read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(state, dict):
        return None

    if state.get("state") == "running":
        try:
            code = int(exit_path().read_text().strip())
        except (OSError, ValueError):
            # No verdict yet. Either it is genuinely still working, or the exit file
            # never arrived — the job was SIGKILLed before its trap ran, the machine
            # lost power, someone deleted it. Without a deadline that second case
            # pins the state at ``running`` forever, and since the single-flight guard
            # reads this, self-update stays wedged with no way to clear it from the
            # UI. Time it out instead: the cost of being wrong is one concurrent run
            # after an hour, against a feature that never works again.
            started = state.get("started_at")
            if isinstance(started, (int, float)) and time.time() - started > _STALE_AFTER:
                state["state"] = "failed"
                state["error"] = (
                    "The update never reported back — it was interrupted, or its host "
                    "restarted. Check the log; it is safe to try again."
                )
            return state
        state["state"] = "ok" if code == 0 else "failed"
        state["returncode"] = code
        try:
            state["finished_at"] = exit_path().stat().st_mtime
        except OSError:
            pass
    return state


def _write_state(state: dict[str, object]) -> None:
    data_root().mkdir(parents=True, exist_ok=True)
    state_path().write_text(json.dumps(state, indent=2))


def read_log(tail: int = 200) -> str:
    """The last ``tail`` lines of the update log, or "" when there is none."""
    try:
        lines = log_path().read_text(errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(lines[-tail:]) if tail > 0 else ""


def _prepare_log() -> None:
    """Create the log with owner-only permissions before anything writes to it.

    0600 because it records git remotes, absolute paths and command output from a
    host the token holder may not otherwise have a shell on. ``chmod`` after the fact
    would leave a window where it is world-readable, so create it here and let the
    script append.
    """
    data_root().mkdir(parents=True, exist_ok=True)
    fd = os.open(log_path(), os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
    try:
        os.write(
            fd,
            f"\n=== lursor self-update from {__version__} at {time.ctime()} ===\n".encode(),
        )
    finally:
        os.close(fd)
    # An existing log from before this change may be 0644.
    try:
        log_path().chmod(0o600)
    except OSError:
        pass


def is_update_running() -> bool:
    """Whether a job is in flight, for a single-flight guard.

    Two concurrent ``git reset --hard`` + ``uv sync`` runs over one checkout is a
    corrupted deployment, and the button is easy to double-click.
    """
    state = read_state()
    return bool(state and state.get("state") == "running")


def start_update(target_ref: str) -> dict[str, object]:
    """Hand the update to a detached script and return without waiting.

    Escaping this process is the hard part, and it differs by platform:

    - **systemd.** ``render_systemd_unit`` sets ``KillMode=control-group`` so that a
      restart cannot orphan the dev servers an agent run spawned. That also means
      every descendant of this process is in the unit's cgroup and gets SIGKILLed
      when the service restarts — and ``start_new_session`` does *not* help, because
      it leaves the session and process group, not the cgroup. A job spawned the
      obvious way would be killed by the very restart it just triggered, halfway
      through ``uv sync``, leaving a half-synced checkout and a truncated log. So on
      Linux the job is handed to ``systemd-run --user``, which runs it in its own
      transient unit with its own cgroup, out of reach of our restart.
    - **launchd.** No cgroup equivalent; ``KeepAlive`` restarts the job and leaves
      descendants in a new session alone, so a plain detached spawn is enough.

    If ``systemd-run`` is missing or refuses (no user bus, systemd too old), fall
    back to the detached spawn and record it — the update still usually completes,
    but the log ends at the restart, and a reader has to be able to tell that from a
    crash.
    """
    blocker = self_update_blocker()
    if blocker is not None:
        raise RuntimeError(blocker)

    _prepare_log()
    exit_path().unlink(missing_ok=True)

    # The script owns its own redirection, so that wrapping it in systemd-run (whose
    # stdout goes to the journal) doesn't quietly move the log somewhere else.
    #
    # Kept as an explicit dict as well as an `env=` argument because the two spawn
    # paths need it delivered two different ways — see `_JOB_ENV` use below.
    job_env = {
        "LURSOR_UPDATE_LOG": str(log_path()),
        "LURSOR_UPDATE_EXIT": str(exit_path()),
        "LURSOR_UPDATE_REF": target_ref,
    }
    env = {**os.environ, **job_env}

    state: dict[str, object] = {
        "state": "running",
        "started_at": time.time(),
        "finished_at": None,
        "from_version": __version__,
        "target_ref": target_ref,
        "returncode": None,
    }
    # Written *before* the spawn: if the job wins the race to restart the service, a
    # status poll after reconnecting must still find a job to report on.
    _write_state(state)

    argv = ["/bin/sh", str(update_script())]
    try:
        if sys.platform.startswith("linux") and shutil.which("systemd-run"):
            job_env["LURSOR_UPDATE_RUNNER"] = "systemd-run"
            # Synchronous on purpose: systemd-run returns as soon as the transient
            # unit is started, so its exit code tells us whether the job is actually
            # running before we commit to reporting that it is.
            #
            # ``--setenv`` for every variable, and ``--working-directory``, because a
            # transient unit is started by *systemd* from systemd's own environment —
            # it does not inherit this process's env or cwd, so the ``env=`` below
            # configures only the short-lived systemd-run client and reaches the job
            # not at all. Measured on a real host, where this silently cost us the
            # target ref: the script's own `${LURSOR_UPDATE_REF:-main}` default took
            # over and the deployment tracked `main` instead of the release tag the
            # API had resolved and reported. The log and exit paths defaulted to the
            # right places, so nothing looked wrong.
            launched = subprocess.run(
                [
                    "systemd-run",
                    "--user",
                    "--collect",
                    "--quiet",
                    f"--unit=lursor-self-update-{int(state['started_at'])}",
                    f"--working-directory={repo_root()}",
                    *[f"--setenv={k}={v}" for k, v in job_env.items()],
                    *argv,
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if launched.returncode == 0:
                state["runner"] = "systemd-run"
            else:
                state["runner"] = "detached"
                state["runner_note"] = (
                    "systemd-run failed, so the job shares this service's cgroup and "
                    "the log will end at the restart: "
                    + (launched.stderr or launched.stdout).strip()
                )
                job_env["LURSOR_UPDATE_RUNNER"] = "detached"
                subprocess.Popen(
                    argv,
                    cwd=str(repo_root()),
                    env={**env, **job_env},
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    stdin=subprocess.DEVNULL,
                    start_new_session=True,
                )
        else:
            state["runner"] = "detached"
            job_env["LURSOR_UPDATE_RUNNER"] = "detached"
            subprocess.Popen(
                argv,
                cwd=str(repo_root()),
                env={**env, **job_env},
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
    except (OSError, subprocess.SubprocessError) as exc:
        state["state"] = "failed"
        state["error"] = str(exc)
        state["finished_at"] = time.time()
        _write_state(state)
        raise

    _write_state(state)
    return state


def status() -> dict[str, object]:
    """Everything ``GET /api/update/status`` reports. No network."""
    return {
        **describe(),
        "platform": sys.platform,
        "repo": update_repo(),
        "pinned_ref": pinned_ref(),
        "git": git_head(),
        "last_update": read_state(),
    }
