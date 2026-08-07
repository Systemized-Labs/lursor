"""The service installer (``app/service.py``).

The rendering functions are pure, which is the point: a unit file is only ever wrong
on a real host, at which time you are debugging over SSH. Asserting the text here is
much cheaper than discovering a missing `WantedBy` after a reboot.

Nothing here touches systemd or launchd — the subprocess calls are the thin part and
are exercised by actually installing on a server.
"""

from __future__ import annotations

import plistlib
import stat
from pathlib import Path

import pytest

from app import service


@pytest.fixture
def home(tmp_path, monkeypatch) -> Path:
    """Point ``Path.home()`` at a temp dir so nothing writes to the real one."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    return tmp_path


# --- systemd ---------------------------------------------------------------


def test_systemd_unit_shape() -> None:
    unit = service.render_systemd_unit(
        Path("/opt/lursor/backend/.venv/bin/uvicorn"),
        Path("/opt/lursor/backend"),
        Path("/home/jon/.lursor/service.env"),
        "127.0.0.1",
        8791,
        Path("/home/jon/.lursor"),
    )
    assert "ExecStart=/opt/lursor/backend/.venv/bin/uvicorn app.main:app" in unit
    assert "--host 127.0.0.1 --port 8791" in unit
    assert "WorkingDirectory=/opt/lursor/backend" in unit
    assert "EnvironmentFile=/home/jon/.lursor/service.env" in unit
    # Without this the unit never starts on its own.
    assert "[Install]" in unit and "WantedBy=default.target" in unit
    assert "Restart=always" in unit


def test_systemd_unit_never_embeds_the_token() -> None:
    """The token belongs in the EnvironmentFile, not somewhere `systemctl cat` shows it."""
    unit = service.render_systemd_unit(
        Path("/v/bin/uvicorn"), Path("/w"), Path("/e.env"), "127.0.0.1", 8791, Path("/d")
    )
    assert "LURSOR_AUTH_TOKEN" not in unit


def test_systemd_unit_kills_the_control_group() -> None:
    """Agent runs spawn dev servers; a restart that orphans them leaves the ports the
    next run wants held by a process nobody owns."""
    unit = service.render_systemd_unit(
        Path("/v/bin/uvicorn"), Path("/w"), Path("/e.env"), "127.0.0.1", 8791, Path("/d")
    )
    assert "KillMode=control-group" in unit


@pytest.mark.parametrize("host,port", [("127.0.0.1", 8791), ("0.0.0.0", 9000)])
def test_systemd_unit_honours_bind_arguments(host: str, port: int) -> None:
    unit = service.render_systemd_unit(
        Path("/v/bin/uvicorn"), Path("/w"), Path("/e.env"), host, port, Path("/d")
    )
    assert f"--host {host} --port {port}" in unit


# --- launchd ---------------------------------------------------------------


def test_launchd_plist_shape(home: Path) -> None:
    raw = service.render_launchd_plist(
        Path("/opt/lursor/backend/.venv/bin/uvicorn"),
        Path("/opt/lursor/backend"),
        "tok-abc",
        "127.0.0.1",
        8791,
        Path("/home/jon/.lursor"),
    )
    job = plistlib.loads(raw)
    assert job["Label"] == service.LAUNCHD_LABEL
    assert job["ProgramArguments"][0] == "/opt/lursor/backend/.venv/bin/uvicorn"
    assert job["ProgramArguments"][1] == "app.main:app"
    assert "--host" in job["ProgramArguments"] and "127.0.0.1" in job["ProgramArguments"]
    assert job["WorkingDirectory"] == "/opt/lursor/backend"
    # launchd has no EnvironmentFile, so the token has to ride in the plist; the
    # installer compensates by writing it 0600.
    assert job["EnvironmentVariables"]["LURSOR_AUTH_TOKEN"] == "tok-abc"
    # KeepAlive is the whole reason this file exists.
    assert job["KeepAlive"] is True
    assert job["RunAtLoad"] is True


def test_launchd_plist_is_valid_plist(home: Path) -> None:
    """Rendered through plistlib rather than string-formatted, so a token containing
    XML-special characters cannot corrupt the file."""
    raw = service.render_launchd_plist(
        Path("/v/bin/uvicorn"), Path("/w"), "tok&<>\"'", "127.0.0.1", 8791, Path("/d")
    )
    assert plistlib.loads(raw)["EnvironmentVariables"]["LURSOR_AUTH_TOKEN"] == "tok&<>\"'"


# --- token -----------------------------------------------------------------


def test_token_is_created_once_and_reused(home: Path) -> None:
    first = service.ensure_token()
    second = service.ensure_token()
    assert first == second, "a new token on every install would log out every client"
    assert service.token_file().read_text().strip() == first


def test_token_is_owner_only(home: Path) -> None:
    service.ensure_token()
    mode = stat.S_IMODE(service.token_file().stat().st_mode)
    assert mode == 0o600, f"token file is {oct(mode)}"


def test_token_rotation_is_explicit(home: Path) -> None:
    first = service.ensure_token()
    rotated = service.ensure_token(rotate=True)
    assert rotated != first
    assert service.ensure_token() == rotated


def test_token_is_websocket_subprotocol_safe(home: Path) -> None:
    """The token travels as a WebSocket subprotocol (see app/auth.py), which is an
    HTTP token: no spaces and no separator characters."""
    token = service.ensure_token()
    assert token
    forbidden = set(' \t"(),/:;<=>?@[\\]{}')
    assert not (set(token) & forbidden), token


def test_env_file_holds_the_token_and_is_owner_only(home: Path) -> None:
    token = service.ensure_token()
    path = service.write_env_file(token)
    assert path.read_text().strip() == f"LURSOR_AUTH_TOKEN={token}"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_empty_token_file_is_replaced(home: Path) -> None:
    """A truncated write (disk full, killed mid-install) must not authenticate as ''."""
    service.config_dir().mkdir(parents=True, exist_ok=True)
    service.token_file().write_text("\n")
    assert service.ensure_token()


# --- path resolution -------------------------------------------------------


def test_resolve_paths_points_at_this_environment() -> None:
    """The unit is derived from the interpreter running the installer, so it cannot
    reference a virtualenv that isn't the one the code was synced into."""
    uvicorn, workdir = service.resolve_paths()
    assert uvicorn.exists(), uvicorn
    assert (workdir / "app" / "main.py").exists(), workdir


def test_config_paths_live_under_the_data_dir(home: Path) -> None:
    assert service.token_file().parent == home / ".lursor"
    assert service.env_file().parent == home / ".lursor"


# --- CLI -------------------------------------------------------------------


def test_parser_requires_a_subcommand() -> None:
    with pytest.raises(SystemExit):
        service.build_parser().parse_args([])


def test_parser_leaves_bind_unset_when_not_given() -> None:
    """None, not the default value — `resolve_bind` needs to tell those apart.

    An omitted ``--host`` means "keep whatever is installed", and it can only mean
    that if argparse does not helpfully fill in a default first.
    """
    args = service.build_parser().parse_args(["install"])
    assert args.host is None
    assert args.port is None
    assert args.rotate_token is False


# --- which interface the service is bound to -------------------------------


def test_resolve_bind_falls_back_to_the_conservative_defaults(home: Path, monkeypatch) -> None:
    """Nothing installed: loopback, because the CLI alone should not publish an API."""
    monkeypatch.setattr(service, "_is_linux", lambda: True)
    args = service.build_parser().parse_args(["install"])
    assert service.resolve_bind(args) == ("127.0.0.1", 8791)


def test_resolve_bind_inherits_the_installed_systemd_bind(home: Path, monkeypatch) -> None:
    """Re-running install to pick up new code must not silently un-expose a service.

    This is the regression that mattered: ``install-server.sh`` binds 0.0.0.0, and a
    hand-run ``lursor-service install`` afterwards used to rebind to loopback and
    leave a server nobody could reach — while ``status`` still reported 200.
    """
    monkeypatch.setattr(service, "_is_linux", lambda: True)
    unit = service.systemd_unit_path()
    unit.parent.mkdir(parents=True, exist_ok=True)
    unit.write_text(
        service.render_systemd_unit(
            Path("/v/bin/uvicorn"), Path("/w"), Path("/e.env"), "0.0.0.0", 9000, Path("/d")
        )
    )

    args = service.build_parser().parse_args(["install"])
    assert service.resolve_bind(args) == ("0.0.0.0", 9000)

    # An explicit flag still wins — inheriting must not make the bind unchangeable.
    args = service.build_parser().parse_args(["install", "--host", "127.0.0.1"])
    assert service.resolve_bind(args) == ("127.0.0.1", 9000)


def test_resolve_bind_inherits_the_installed_launchd_bind(home: Path, monkeypatch) -> None:
    monkeypatch.setattr(service, "_is_linux", lambda: False)
    plist = service.launchd_plist_path()
    plist.parent.mkdir(parents=True, exist_ok=True)
    plist.write_bytes(
        service.render_launchd_plist(
            Path("/v/bin/uvicorn"), Path("/w"), "tok", "0.0.0.0", 9100, Path("/d")
        )
    )

    args = service.build_parser().parse_args(["status"])
    assert service.resolve_bind(args) == ("0.0.0.0", 9100)


def test_installed_bind_ignores_a_unit_it_did_not_write(home: Path, monkeypatch) -> None:
    """A hand-edited unit is the owner's business; guessing at it is worse than not."""
    monkeypatch.setattr(service, "_is_linux", lambda: True)
    unit = service.systemd_unit_path()
    unit.parent.mkdir(parents=True, exist_ok=True)
    unit.write_text("[Service]\nExecStart=/usr/bin/something-else\n")
    assert service.installed_bind() is None


def test_token_command_without_a_token_is_an_error(home: Path, capsys) -> None:
    assert service.main(["token"]) == 1
    assert "install" in capsys.readouterr().err


def test_token_command_prints_the_token(home: Path, capsys) -> None:
    token = service.ensure_token()
    assert service.main(["token"]) == 0
    assert capsys.readouterr().out.strip() == token


# --- state location (regression) -------------------------------------------


def test_systemd_unit_keeps_state_out_of_the_checkout() -> None:
    """Regression: the first shipped version omitted this, so the database defaulted
    to ``<backend>/lursor.db`` — inside the tree the installer resets and a user may
    re-clone. Moving that directory lost every thread, agent and schedule."""
    unit = service.render_systemd_unit(
        Path("/v/bin/uvicorn"),
        Path("/home/jon/lursor/backend"),
        Path("/e.env"),
        "127.0.0.1",
        8791,
        Path("/home/jon/.lursor"),
    )
    assert "Environment=LURSOR_DATA_DIR=/home/jon/.lursor" in unit


def test_launchd_plist_keeps_state_out_of_the_checkout(home: Path) -> None:
    job = plistlib.loads(
        service.render_launchd_plist(
            Path("/v/bin/uvicorn"), Path("/w"), "tok", "127.0.0.1", 8791, Path("/d")
        )
    )
    assert job["EnvironmentVariables"]["LURSOR_DATA_DIR"] == "/d"


# --- database migration ----------------------------------------------------


def test_migration_moves_a_database_out_of_the_checkout(tmp_path) -> None:
    workdir, data = tmp_path / "backend", tmp_path / "data"
    workdir.mkdir()
    (workdir / "lursor.db").write_text("rows")
    (workdir / "lursor.db-wal").write_text("pending")
    (workdir / "lursor.db-shm").write_text("shm")

    moved = service.migrate_checkout_database(workdir, data)

    assert moved == data / "lursor.db"
    assert (data / "lursor.db").read_text() == "rows"
    # The -wal can hold committed transactions; leaving it behind strands them.
    assert (data / "lursor.db-wal").read_text() == "pending"
    assert (data / "lursor.db-shm").exists()
    assert not (workdir / "lursor.db").exists()


def test_migration_never_clobbers_the_live_database(tmp_path) -> None:
    """If both exist, the one already in the data directory is the live one."""
    workdir, data = tmp_path / "backend", tmp_path / "data"
    workdir.mkdir()
    data.mkdir()
    (workdir / "lursor.db").write_text("stale")
    (data / "lursor.db").write_text("live")

    assert service.migrate_checkout_database(workdir, data) is None
    assert (data / "lursor.db").read_text() == "live"
    assert (workdir / "lursor.db").read_text() == "stale"


def test_migration_is_a_noop_on_a_fresh_install(tmp_path) -> None:
    workdir, data = tmp_path / "backend", tmp_path / "data"
    workdir.mkdir()
    assert service.migrate_checkout_database(workdir, data) is None


# --- the pairing summary ---------------------------------------------------


def test_summary_contains_the_address_and_token(capsys) -> None:
    service.print_summary("127.0.0.1", 8791, "tok-xyz", created=True)
    out = capsys.readouterr().out
    assert "http://127.0.0.1:8791" in out
    assert "tok-xyz" in out


def test_summary_says_when_a_token_is_new(capsys) -> None:
    service.print_summary("127.0.0.1", 8791, "tok", created=True)
    assert "newly generated" in capsys.readouterr().out


def test_summary_says_when_a_token_is_reused(capsys) -> None:
    """Re-running the installer must not look like the token just changed."""
    service.print_summary("127.0.0.1", 8791, "tok", created=False)
    out = capsys.readouterr().out
    assert "existing" in out and "unchanged" in out


def test_summary_never_prints_a_wildcard_as_the_address(capsys, monkeypatch) -> None:
    """`http://0.0.0.0:8791` is not connectable, and the label says to paste it."""
    monkeypatch.setattr(service, "lan_address", lambda: "192.168.1.40")
    service.print_summary("0.0.0.0", 8791, "tok", created=True)
    out = capsys.readouterr().out
    assert "http://192.168.1.40:8791" in out
    assert "0.0.0.0:8791" not in out


def test_summary_says_so_when_the_lan_address_is_unknown(capsys, monkeypatch) -> None:
    """Better to admit it than to print an address that cannot be reached."""
    monkeypatch.setattr(service, "lan_address", lambda: None)
    service.print_summary("0.0.0.0", 8791, "tok", created=True)
    out = capsys.readouterr().out
    assert "could not be determined" in out


def test_lan_address_is_never_loopback(monkeypatch) -> None:
    """No default route hands back 127.0.0.1, which is not an answer to the question."""
    import socket

    class FakeSocket:
        def connect(self, _address) -> None: ...
        def getsockname(self):
            return ("127.0.0.1", 0)

        def close(self) -> None: ...

    monkeypatch.setattr(socket, "socket", lambda *a, **k: FakeSocket())
    assert service.lan_address() is None


def test_token_is_on_its_own_line_for_copy_paste(capsys) -> None:
    """A 43-character random string has to be selectable without catching prose."""
    token = "abcDEF123_-xyz"
    service.print_summary("127.0.0.1", 8791, token, created=True)
    lines = [line for line in capsys.readouterr().out.splitlines() if token in line]
    assert len(lines) == 1
    # Only the label and the value on that line, nothing to select around.
    assert lines[0].split() == ["Token", token]


# --- per-backend token uniqueness -----------------------------------------


def test_each_backend_generates_its_own_token(tmp_path, monkeypatch) -> None:
    """Two installs must never share a credential.

    There is no default token anywhere in the tree — `.env.example` ships the name
    commented out with no value — so this asserts the only source is CSPRNG output per
    machine.
    """
    tokens = set()
    for name in ("box-a", "box-b", "box-c"):
        home = tmp_path / name
        home.mkdir()
        monkeypatch.setattr(Path, "home", lambda home=home: home)
        tokens.add(service.ensure_token())
    assert len(tokens) == 3, "tokens collided across backends"


def test_token_has_full_entropy(home: Path) -> None:
    """32 bytes, url-safe base64 -> 43 characters. A shorter token means someone
    reduced the entropy of the only credential guarding a remote shell."""
    assert len(service.ensure_token()) == 43


# --- restart ---------------------------------------------------------------


def test_restart_command_per_platform(monkeypatch) -> None:
    """Restart must never carry a port, a unit render or a token.

    ``scripts/self-update.sh`` calls this instead of re-running ``install`` for
    exactly that reason: the updater does not know which port the service was
    installed on, and ``install`` finishes by printing the token — which would then
    land in the update log that ``GET /api/update/log`` serves back.
    """
    monkeypatch.setattr(service, "_require_supported_platform", lambda: None)

    monkeypatch.setattr(service, "_is_linux", lambda: True)
    assert service.restart_command() == [
        "systemctl",
        "--user",
        "restart",
        service.SYSTEMD_UNIT,
    ]

    monkeypatch.setattr(service, "_is_linux", lambda: False)
    cmd = service.restart_command()
    # kickstart -k, not bootout+bootstrap: it cannot leave the job unloaded if the
    # second half fails.
    assert cmd[:3] == ["launchctl", "kickstart", "-k"]
    assert cmd[3].endswith(f"/{service.LAUNCHD_LABEL}")

    for argv in (["systemctl"], cmd):
        assert not any("--port" in a for a in argv)


def test_restart_is_registered_without_host_or_port() -> None:
    """A restart that could move the service would defeat the point of having it."""
    args = service.build_parser().parse_args(["restart"])
    assert args.func is service.cmd_restart
    assert not hasattr(args, "port")
