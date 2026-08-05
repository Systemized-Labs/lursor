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
        Path("/v/bin/uvicorn"), Path("/w"), Path("/e.env"), "127.0.0.1", 8791
    )
    assert "LURSOR_AUTH_TOKEN" not in unit


def test_systemd_unit_kills_the_control_group() -> None:
    """Agent runs spawn dev servers; a restart that orphans them leaves the ports the
    next run wants held by a process nobody owns."""
    unit = service.render_systemd_unit(
        Path("/v/bin/uvicorn"), Path("/w"), Path("/e.env"), "127.0.0.1", 8791
    )
    assert "KillMode=control-group" in unit


@pytest.mark.parametrize("host,port", [("127.0.0.1", 8791), ("0.0.0.0", 9000)])
def test_systemd_unit_honours_bind_arguments(host: str, port: int) -> None:
    unit = service.render_systemd_unit(
        Path("/v/bin/uvicorn"), Path("/w"), Path("/e.env"), host, port
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
        Path("/v/bin/uvicorn"), Path("/w"), "tok&<>\"'", "127.0.0.1", 8791
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


def test_parser_defaults_to_loopback() -> None:
    args = service.build_parser().parse_args(["install"])
    assert args.host == "127.0.0.1"
    assert args.port == 8791
    assert args.rotate_token is False


def test_token_command_without_a_token_is_an_error(home: Path, capsys) -> None:
    assert service.main(["token"]) == 1
    assert "install" in capsys.readouterr().err


def test_token_command_prints_the_token(home: Path, capsys) -> None:
    token = service.ensure_token()
    assert service.main(["token"]) == 0
    assert capsys.readouterr().out.strip() == token
