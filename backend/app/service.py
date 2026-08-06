"""Install the backend as a supervised background service.

    uv run lursor-service install     # write, enable and start the service
    uv run lursor-service status      # is it running, is it enabled, does it answer
    uv run lursor-service uninstall   # stop and remove it (keeps your data)
    uv run lursor-service token       # print the token, for pairing a client

This exists because a remote backend is only useful if it outlives the shell that
started it. ``nohup uvicorn …`` survives a logout and nothing else: not a reboot, not
a crash, not an OOM kill. The point of running the backend on another machine is that
it keeps working while your laptop doesn't, and an unsupervised process quietly
undoes that.

**What this does not do:** resume a turn that was in flight when the service
restarted. Run state lives in memory (``agents/chat_run_manager``), so a restart
brings the API back and marks any interrupted thread ``stopped`` — see
``reconcile_interrupted_runs``. Supervision means "the backend comes back", not "the
work continues". Scheduled runs and anything started afterwards are unaffected.

Two platforms, because those are the two the rest of the project targets:

- **Linux** — a systemd ``--user`` unit. A user unit, not a system one, because the
  backend is an ordinary program running as you, with your keys, your dotfiles and
  your repos; nothing about it wants root. The one thing that does need root is
  ``loginctl enable-linger``, without which your systemd instance only exists while
  you are logged in and the service would not start until someone signed in after a
  reboot.
- **macOS** — a LaunchAgent. Note the platform difference, which is not something
  this tool can paper over: an agent starts at *login*, not at boot. A Mac that should
  serve headlessly from cold needs a LaunchDaemon, which is root-owned and out of
  scope here.

The rendering functions are pure and take every path as an argument, so the unit and
plist text is asserted in ``tests/test_service.py`` rather than discovered on a
server. That is deliberate: the manual version of this file was written twice and
both attempts had a bug that only showed up on a real host.
"""

from __future__ import annotations

import argparse
import os
import plistlib
import secrets
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Unit / job identifiers. Stable, because uninstall finds the service by them.
SYSTEMD_UNIT = "lursor-backend.service"
LAUNCHD_LABEL = "local.lursor.backend"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8791


class ServiceError(RuntimeError):
    """Something the user needs to fix, reported without a traceback."""


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def config_dir() -> Path:
    """Where the token and env file live — the same root as the rest of our state."""
    return Path.home() / ".lursor"


def env_file() -> Path:
    return config_dir() / "service.env"


def token_file() -> Path:
    return config_dir() / "token"


def resolve_paths() -> tuple[Path, Path]:
    """The uvicorn binary to run and the directory to run it from.

    Derived from the environment the installer is running in, so the unit points at
    whichever virtualenv the code was synced into and cannot drift from it. A unit
    hardcoding ``~/.venv`` breaks the moment someone syncs somewhere else.

    ``sys.prefix`` rather than ``sys.executable``: in a uv-managed venv the ``python``
    entry is a symlink to an interpreter *outside* it, so resolving the executable
    walks out of the environment and lands in a bin directory with no uvicorn in it.
    ``sys.prefix`` is the environment root whether or not symlinks are involved.
    """
    bin_dir = Path(sys.prefix) / ("Scripts" if os.name == "nt" else "bin")
    uvicorn = bin_dir / ("uvicorn.exe" if os.name == "nt" else "uvicorn")
    if not uvicorn.exists():
        raise ServiceError(
            f"No uvicorn in {bin_dir}. Run this through the project's environment: "
            "`uv run lursor-service install`."
        )
    # app/service.py -> app -> backend/, the directory `app.main:app` resolves from.
    workdir = Path(__file__).resolve().parent.parent
    return uvicorn, workdir


# ---------------------------------------------------------------------------
# Token
# ---------------------------------------------------------------------------


def ensure_token(*, rotate: bool = False) -> str:
    """Return the service token, creating it on first install.

    Never regenerated silently: the token is what every saved client authenticates
    with, so a fresh one on every install would log you out of your own backend with
    no explanation. ``--rotate-token`` is the way to change it on purpose.

    URL-safe by construction, which also makes it a valid WebSocket subprotocol
    token — see ``app/auth.py`` for why that matters.
    """
    path = token_file()
    if path.exists() and not rotate:
        existing = path.read_text().strip()
        if existing:
            return existing

    token = secrets.token_urlsafe(32)
    config_dir().mkdir(parents=True, exist_ok=True)
    path.write_text(token + "\n")
    path.chmod(0o600)
    return token


def migrate_checkout_database(workdir: Path, data_dir: Path) -> Path | None:
    """Move a database left inside the checkout into the data directory.

    Early installs ran without ``LURSOR_DATA_DIR``, so the database defaulted to
    ``<backend>/lursor.db`` — inside the tree the installer ``git reset --hard``s and
    that a user may reasonably re-clone or move. This relocates it once, on the next
    install, rather than letting the service quietly come up on an empty database and
    look like every thread was lost.

    Returns the new path when something moved, else None. Never overwrites a database
    already in the data directory: if both exist the one already in the right place is
    the live one, and clobbering it would be the very data loss this prevents.
    """
    stale = workdir / "lursor.db"
    target = data_dir / "lursor.db"
    if not stale.exists() or target.exists():
        return None

    data_dir.mkdir(parents=True, exist_ok=True)
    stale.replace(target)
    # SQLite's WAL and shared-memory files belong with it; leaving them behind can
    # strand committed transactions that were still only in the -wal.
    for suffix in ("-wal", "-shm"):
        sidecar = stale.with_name(stale.name + suffix)
        if sidecar.exists():
            sidecar.replace(target.with_name(target.name + suffix))
    return target


def write_env_file(token: str) -> Path:
    """Put the token in a file systemd reads, rather than in the unit itself.

    Keeps it out of ``systemctl cat``, out of ``ps`` output, and out of the shell
    history of whoever installed this.
    """
    path = env_file()
    config_dir().mkdir(parents=True, exist_ok=True)
    path.write_text(f"LURSOR_AUTH_TOKEN={token}\n")
    path.chmod(0o600)
    return path


# ---------------------------------------------------------------------------
# Unit rendering (pure)
# ---------------------------------------------------------------------------


def render_systemd_unit(
    uvicorn: Path, workdir: Path, env: Path, host: str, port: int, data_dir: Path
) -> str:
    return f"""\
[Unit]
Description=Lursor backend (agent harness API)
Documentation=https://github.com/Systemized-Labs/lursor
# The API talks to model providers, so wait for configured networking rather than
# racing DHCP on a cold boot.
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
WorkingDirectory={workdir}
ExecStart={uvicorn} app.main:app --host {host} --port {port}
EnvironmentFile={env}
Environment=PYTHONUNBUFFERED=1
# Keep every byte of state out of the checkout, which is disposable by design — the
# installer runs `git reset --hard` on it, and a re-clone or a moved directory would
# take your threads, agents and schedules with it. Written into the unit explicitly
# rather than left to ``config.DEFAULT_DATA_ROOT``, even though the two now agree: a
# unit should state where its state is, so reading `systemctl cat` answers the question
# and a future change to the default cannot silently move a running deployment's data.
Environment=LURSOR_DATA_DIR={data_dir}

Restart=always
RestartSec=3
# Back off a crash loop instead of pinning a core, while still recovering from a
# transient failure fast enough that nobody notices.
StartLimitIntervalSec=60
StartLimitBurst=5

# Agent runs spawn shells, dev servers and browsers as children. Killing the whole
# control group on stop means a restart does not leave orphaned dev servers holding
# the ports the next run wants.
KillMode=control-group
TimeoutStopSec=20

[Install]
WantedBy=default.target
"""


def render_launchd_plist(
    uvicorn: Path, workdir: Path, token: str, host: str, port: int, data_dir: Path
) -> bytes:
    """A LaunchAgent for macOS.

    The token goes in ``EnvironmentVariables`` because launchd has no equivalent of
    systemd's ``EnvironmentFile``; the plist is written 0600 to compensate.
    """
    job = {
        "Label": LAUNCHD_LABEL,
        "ProgramArguments": [
            str(uvicorn),
            "app.main:app",
            "--host",
            host,
            "--port",
            str(port),
        ],
        "WorkingDirectory": str(workdir),
        "EnvironmentVariables": {
            "LURSOR_AUTH_TOKEN": token,
            "PYTHONUNBUFFERED": "1",
            # See the systemd unit: state must not live in the disposable checkout.
            "LURSOR_DATA_DIR": str(data_dir),
        },
        "RunAtLoad": True,
        "KeepAlive": True,
        # Floor on relaunches, so a backend that cannot start does not spin.
        "ThrottleInterval": 10,
        "StandardOutPath": str(Path.home() / "Library" / "Logs" / "lursor-backend.log"),
        "StandardErrorPath": str(Path.home() / "Library" / "Logs" / "lursor-backend.log"),
    }
    return plistlib.dumps(job)


def systemd_unit_path() -> Path:
    return Path.home() / ".config" / "systemd" / "user" / SYSTEMD_UNIT


def launchd_plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist"


# ---------------------------------------------------------------------------
# Platform plumbing
# ---------------------------------------------------------------------------


def _run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise ServiceError(f"`{' '.join(cmd)}` failed: {detail}")
    return result


def _is_linux() -> bool:
    return sys.platform.startswith("linux")


def _is_macos() -> bool:
    return sys.platform == "darwin"


def _require_supported_platform() -> None:
    if not (_is_linux() or _is_macos()):
        raise ServiceError(
            f"No service integration for {sys.platform!r}. Run uvicorn under whatever "
            "supervisor this platform uses; see docs/REMOTE.md."
        )
    if _is_linux() and not shutil.which("systemctl"):
        raise ServiceError(
            "systemctl not found. This installs a systemd user unit; on a system "
            "without systemd, supervise uvicorn yourself (see docs/REMOTE.md)."
        )


def _linger_state() -> str | None:
    """``yes``/``no``, or None when it can't be determined."""
    if not shutil.which("loginctl"):
        return None
    user = os.environ.get("USER") or Path.home().name
    result = _run(["loginctl", "show-user", user, "-p", "Linger", "--value"], check=False)
    return result.stdout.strip() or None


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_install(args: argparse.Namespace) -> int:
    _require_supported_platform()
    if os.geteuid() == 0:
        raise ServiceError(
            "Don't install this as root. The backend runs as you and needs your home "
            "directory; a root service would put its data and keys in /root."
        )

    uvicorn, workdir = resolve_paths()
    # Whether this machine is getting its first token matters to the person reading the
    # output: re-running the installer prints an existing token, and without being told
    # so it looks like it just changed and invalidated their saved connection.
    had_token = token_file().exists()
    token = ensure_token(rotate=args.rotate_token)
    created = args.rotate_token or not had_token
    data_dir = config_dir()

    moved = migrate_checkout_database(workdir, data_dir)
    if moved:
        print(f"moved your database out of the checkout to {moved}")

    if _is_linux():
        env = write_env_file(token)
        unit_path = systemd_unit_path()
        unit_path.parent.mkdir(parents=True, exist_ok=True)
        unit_path.write_text(
            render_systemd_unit(uvicorn, workdir, env, args.host, args.port, data_dir)
        )
        print(f"wrote {unit_path}")

        _run(["systemctl", "--user", "daemon-reload"])
        _run(["systemctl", "--user", "enable", SYSTEMD_UNIT])
        # Restart rather than start: re-running the installer after an upgrade should
        # pick up the new code, and starting an already-running unit is a no-op.
        _run(["systemctl", "--user", "restart", SYSTEMD_UNIT])
        print(f"enabled and started {SYSTEMD_UNIT}")

        if _linger_state() != "yes":
            user = os.environ.get("USER") or Path.home().name
            print(
                "\nOne more step, and it needs root:\n"
                f"    sudo loginctl enable-linger {user}\n"
                "Without it your systemd instance only exists while you are logged in, "
                "so the backend will not start after a reboot until someone signs in."
            )
    else:
        plist_path = launchd_plist_path()
        plist_path.parent.mkdir(parents=True, exist_ok=True)
        plist_path.write_bytes(
            render_launchd_plist(
                uvicorn, workdir, token, args.host, args.port, data_dir
            )
        )
        plist_path.chmod(0o600)
        print(f"wrote {plist_path}")

        domain = f"gui/{os.getuid()}"
        _run(["launchctl", "bootout", f"{domain}/{LAUNCHD_LABEL}"], check=False)
        _run(["launchctl", "bootstrap", domain, str(plist_path)])
        print(f"loaded {LAUNCHD_LABEL}")
        print(
            "\nNote: a LaunchAgent starts at login, not at boot. For a Mac that should "
            "serve from cold with nobody signed in, you need a root-owned LaunchDaemon "
            "— see docs/REMOTE.md."
        )

    print_summary(args.host, args.port, token, created=created)
    return 0


def cmd_uninstall(args: argparse.Namespace) -> int:
    _require_supported_platform()

    if _is_linux():
        _run(["systemctl", "--user", "stop", SYSTEMD_UNIT], check=False)
        _run(["systemctl", "--user", "disable", SYSTEMD_UNIT], check=False)
        unit_path = systemd_unit_path()
        if unit_path.exists():
            unit_path.unlink()
            print(f"removed {unit_path}")
        _run(["systemctl", "--user", "daemon-reload"], check=False)
    else:
        _run(
            ["launchctl", "bootout", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"], check=False
        )
        plist_path = launchd_plist_path()
        if plist_path.exists():
            plist_path.unlink()
            print(f"removed {plist_path}")

    print(
        "Service removed. Your database, workspaces and token are untouched — delete "
        f"{config_dir()} by hand if you meant to remove those too."
    )
    return 0


def restart_command() -> list[str]:
    """The argv that restarts the service, per platform.

    Split out from ``cmd_restart`` so it can be asserted without a supervisor
    present, the way the unit renderers are.

    ``launchctl kickstart -k`` rather than ``bootout`` + ``bootstrap``: it keeps the
    job loaded and stops the old process first, so a restart cannot land in the state
    where bootout succeeded and bootstrap didn't and the backend is simply gone.
    """
    _require_supported_platform()
    if _is_linux():
        return ["systemctl", "--user", "restart", SYSTEMD_UNIT]
    return ["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"]


def cmd_restart(args: argparse.Namespace) -> int:
    """Restart the service without touching the unit, the port or the token.

    Exists for ``scripts/self-update.sh``, which needs to restart into new code and
    must not re-run ``install``: that would re-render the unit from whatever port it
    was given (the updater doesn't know the real one) and print the token, which then
    ends up in the update log the API serves back. See the header of that script.
    """
    _run(restart_command())
    print("Restarted. Check it came back with `lursor-service status`.")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    _require_supported_platform()

    if _is_linux():
        active = _run(
            ["systemctl", "--user", "is-active", SYSTEMD_UNIT], check=False
        ).stdout.strip()
        enabled = _run(
            ["systemctl", "--user", "is-enabled", SYSTEMD_UNIT], check=False
        ).stdout.strip()
        print(f"unit:    {SYSTEMD_UNIT}")
        print(f"active:  {active or 'unknown'}")
        print(f"enabled: {enabled or 'unknown'}")
        print(f"linger:  {_linger_state() or 'unknown'} (needed to start at boot)")
        print("logs:    journalctl --user -u lursor-backend -f")
    else:
        listed = _run(["launchctl", "list"], check=False).stdout
        loaded = LAUNCHD_LABEL in listed
        print(f"job:    {LAUNCHD_LABEL}")
        print(f"loaded: {'yes' if loaded else 'no'}")
        print(f"logs:   {Path.home() / 'Library' / 'Logs' / 'lursor-backend.log'}")

    # Whether it is *reachable* is the question the user actually has, and it is not
    # the same question as whether the supervisor thinks it is running.
    url = f"http://{args.host}:{args.port}/api/health"
    token = token_file().read_text().strip() if token_file().exists() else ""
    request = urllib.request.Request(url)
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            print(f"health:  {response.status} at {url}")
    except urllib.error.HTTPError as exc:
        hint = " (token mismatch — try `lursor-service token`)" if exc.code == 401 else ""
        print(f"health:  {exc.code} at {url}{hint}")
    except OSError as exc:
        print(f"health:  unreachable at {url} ({exc})")
    return 0


def cmd_token(args: argparse.Namespace) -> int:
    path = token_file()
    if not path.exists():
        raise ServiceError(
            f"No token at {path}. Run `lursor-service install` to create one."
        )
    print(path.read_text().strip())
    return 0


def print_summary(host: str, port: int, token: str, *, created: bool) -> None:
    """The last thing the installer prints: the two values needed to pair a client.

    Framed and last on purpose. The install scrolls a few hundred lines of dependency
    resolution past before reaching here, and the token is a 43-character random string
    someone has to select with a mouse — burying it in a paragraph is how you end up
    running `lursor-service token` to find it again. Nothing may print after this.

    Also states whether the token is new. Re-running the installer prints the *existing*
    token, and silence there reads as "it changed", which would send someone off to
    update a connection that was working fine.
    """
    rule = "-" * 68
    origin = f"http://{host}:{port}"
    provenance = (
        "newly generated for this machine"
        if created
        else "existing — unchanged, saved clients keep working"
    )

    print()
    print(rule)
    print("  Lursor backend is running.")
    print()
    print(f"    Address    {origin}")
    print(f"    Token      {token}")
    print(f"               ({provenance})")
    print()
    print("  Add both in the desktop app: Switch Connection -> Add a remote")
    print("  backend. To print the token again later:")
    print()
    print("    uv run lursor-service token")
    print()
    print("  The token grants a shell on this host. Put TLS or an SSH tunnel in")
    print("  front of it; never send it over plain http across a network.")
    print(rule)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lursor-service",
        description="Install the Lursor backend as a supervised service.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(p: argparse.ArgumentParser) -> None:
        p.add_argument(
            "--host",
            default=DEFAULT_HOST,
            help="Interface to bind (default %(default)s — loopback only; anything "
            "wider publishes an API that grants a shell on this host).",
        )
        p.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port (default %(default)s).")

    install = sub.add_parser("install", help="write, enable and start the service")
    add_common(install)
    install.add_argument(
        "--rotate-token",
        action="store_true",
        help="Generate a new token, invalidating every saved client.",
    )
    install.set_defaults(func=cmd_install)

    uninstall = sub.add_parser("uninstall", help="stop and remove the service")
    uninstall.set_defaults(func=cmd_uninstall)

    # No --host/--port: a restart must not be able to move the service. That is the
    # whole reason this exists rather than self-update re-running `install`.
    restart = sub.add_parser("restart", help="restart the service into current code")
    restart.set_defaults(func=cmd_restart)

    status = sub.add_parser("status", help="report supervisor state and reachability")
    add_common(status)
    status.set_defaults(func=cmd_status)

    token = sub.add_parser("token", help="print the service token")
    token.set_defaults(func=cmd_token)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except ServiceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
