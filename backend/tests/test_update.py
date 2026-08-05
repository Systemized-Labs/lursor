"""Self-update detection, gating and job bookkeeping (``app/updater.py``).

Nothing here spawns the updater. What is worth asserting is the part that decides
*whether* to spawn it and what it reports afterwards: every one of those branches ends
in either a refused button or a host that restarts into new code, and the ones that
matter most (a frozen bundle, a tokenless backend) are exactly the ones a developer on
a checkout never hits by accident.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import updater
from app.api import update as update_api
from app.main import app


@pytest.fixture
def data_dir(tmp_path, monkeypatch) -> Path:
    """Point the data root at a temp dir so no test writes to ``~/.lursor``."""
    monkeypatch.setenv("LURSOR_DATA_DIR", str(tmp_path))
    return tmp_path


@pytest.fixture
def updatable(monkeypatch, data_dir) -> None:
    """Force the one configuration where self-update is allowed.

    Assembled by hand rather than by installing a service, because "would this host
    let itself be updated" is a decision made from four independent facts and each
    needs to be flipped on its own below.
    """
    monkeypatch.delenv("LURSOR_MANAGED_BY", raising=False)
    monkeypatch.delenv("LURSOR_DISABLE_SELF_UPDATE", raising=False)
    monkeypatch.setattr(updater, "install_kind", lambda: "checkout")
    monkeypatch.setattr(updater, "managed_by", lambda: "service")
    monkeypatch.setattr(updater, "update_script", lambda: Path(__file__))
    monkeypatch.setenv("LURSOR_AUTH_TOKEN", "test-token")
    from app.config import get_settings

    get_settings.cache_clear()


# --- What kind of install is this ------------------------------------------


def test_checkout_is_detected_from_git_dir() -> None:
    """The suite runs from a checkout, so this is the honest answer here."""
    assert updater.install_kind() == "checkout"
    assert (updater.repo_root() / ".git").exists()


def test_electron_declares_ownership(monkeypatch) -> None:
    """A dev backend is a checkout Electron happens to own — not a bundle.

    This is the case that path-sniffing gets wrong, which is why ownership is
    declared through the environment instead.
    """
    monkeypatch.setenv("LURSOR_MANAGED_BY", "desktop")
    assert updater.managed_by() == "desktop"
    assert updater.install_kind() == "checkout"


def test_no_service_means_unmanaged(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("LURSOR_MANAGED_BY", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert updater.managed_by() == "none"


# --- The gates --------------------------------------------------------------


def test_gates_open_only_for_a_supervised_checkout_with_a_token(updatable) -> None:
    assert updater.self_update_blocker() is None
    assert updater.describe()["self_updatable"] is True


def test_bundle_defers_to_the_desktop_updater(updatable, monkeypatch) -> None:
    monkeypatch.setattr(updater, "install_kind", lambda: "bundled")
    assert "desktop app" in (updater.self_update_blocker() or "")


def test_desktop_managed_backend_is_never_self_updatable(updatable, monkeypatch) -> None:
    """Electron would respawn the old code, so updating here achieves nothing.

    Note this holds even though the install is a checkout — which is the whole reason
    ``install_kind`` and ``managed_by`` are separate fields.
    """
    monkeypatch.setattr(updater, "managed_by", lambda: "desktop")
    assert "desktop app" in (updater.self_update_blocker() or "")


def test_tokenless_backend_cannot_be_told_to_update(updatable, monkeypatch) -> None:
    """The gate that closes a real hole, not a theoretical one.

    CORS reflects any origin and ``TokenAuthMiddleware`` is only installed when a
    token is set, so without this a page in the user's browser could POST to a
    loopback backend and run this script. See SECURITY.md.
    """
    monkeypatch.delenv("LURSOR_AUTH_TOKEN", raising=False)
    from app.config import get_settings

    get_settings.cache_clear()
    assert "LURSOR_AUTH_TOKEN" in (updater.self_update_blocker() or "")


def test_env_kill_switch_wins(updatable, monkeypatch) -> None:
    monkeypatch.setenv("LURSOR_DISABLE_SELF_UPDATE", "1")
    assert "disabled" in (updater.self_update_blocker() or "").lower()


@pytest.mark.parametrize("value", ["", "0", "false"])
def test_kill_switch_ignores_falsey_values(updatable, monkeypatch, value) -> None:
    """An unset-looking value must not disable a working host."""
    monkeypatch.setenv("LURSOR_DISABLE_SELF_UPDATE", value)
    assert updater.self_update_blocker() is None


def test_start_update_refuses_when_blocked(monkeypatch, data_dir) -> None:
    monkeypatch.setattr(updater, "install_kind", lambda: "bundled")
    with pytest.raises(RuntimeError):
        updater.start_update("v9.9.9")


# --- Version comparison ----------------------------------------------------
#
# Has to agree with ``isNewerVersion`` in frontend/electron/main.cjs, or the client
# and the backend disagree about whether an update exists.


@pytest.mark.parametrize(
    ("candidate", "current", "expected"),
    [
        ("0.1.8", "0.1.7", True),
        ("0.1.7", "0.1.7", False),
        ("0.1.6", "0.1.7", False),
        ("0.2.0", "0.1.99", True),
        ("1.0.0", "0.9.9", True),
        # A prerelease ranks below the release it leads to.
        ("0.1.8-rc.1", "0.1.8", False),
        ("0.1.8", "0.1.8-rc.1", True),
        # Unparseable input compares as zero rather than raising: a malformed tag
        # upstream must not break the check.
        ("garbage", "0.1.7", False),
        ("0.1.8", "", True),
    ],
)
def test_is_newer(candidate, current, expected) -> None:
    assert update_api._is_newer(candidate, current) is expected


# --- Job bookkeeping -------------------------------------------------------


def test_state_is_reconciled_from_the_exit_file(data_dir) -> None:
    """The job outlives the process that started it.

    Nothing is watching when the script finishes, so "did it work" has to be
    recoverable from disk alone after the restart.
    """
    updater.state_path().write_text(json.dumps({"state": "running"}))
    updater.exit_path().write_text("0\n")
    assert updater.read_state()["state"] == "ok"

    updater.exit_path().write_text("1\n")
    state = updater.read_state()
    assert state["state"] == "failed"
    assert state["returncode"] == 1


def test_state_stays_running_until_the_job_reports(data_dir) -> None:
    updater.state_path().write_text(json.dumps({"state": "running"}))
    assert updater.read_state()["state"] == "running"
    assert updater.is_update_running() is True


def test_missing_or_corrupt_state_reads_as_no_job(data_dir) -> None:
    assert updater.read_state() is None
    updater.state_path().write_text("{not json")
    assert updater.read_state() is None
    assert updater.is_update_running() is False


def test_log_tail_is_bounded(data_dir) -> None:
    updater.log_path().write_text("\n".join(str(i) for i in range(500)))
    assert updater.read_log(tail=3).splitlines() == ["497", "498", "499"]
    assert updater.read_log(tail=1000).splitlines()[0] == "0"


def test_missing_log_is_empty_not_an_error(data_dir) -> None:
    assert updater.read_log() == ""


# --- The routes ------------------------------------------------------------


def test_status_route_needs_no_network(data_dir) -> None:
    with TestClient(app) as client:
        body = client.get("/api/update/status").json()
    assert body["version"] == updater.__version__
    assert body["install_kind"] in ("checkout", "bundled")
    assert body["last_update"] is None


def test_post_update_is_refused_with_the_reason(data_dir, monkeypatch) -> None:
    """409 rather than 403: the caller is fine, the host isn't in a state to do it."""
    monkeypatch.setattr(updater, "install_kind", lambda: "bundled")
    with TestClient(app) as client:
        res = client.post("/api/update")
    assert res.status_code == 409
    assert "desktop app" in res.json()["detail"]


def test_single_flight(updatable, monkeypatch) -> None:
    """Two concurrent resets over one checkout is a corrupted deployment."""
    updater.state_path().write_text(json.dumps({"state": "running"}))
    monkeypatch.setattr(updater, "pinned_ref", lambda: "main")
    with TestClient(app) as client:
        res = client.post("/api/update")
    assert res.status_code == 409
    assert "already running" in res.json()["detail"]


def test_check_reports_an_unreachable_github_without_failing(monkeypatch, data_dir) -> None:
    """No outbound network is a normal state for a backend, not a 500.

    The UI has to keep showing the version it already knows rather than an error.
    """
    monkeypatch.setattr(update_api, "_latest_cache", None)

    async def boom(repo: str) -> str:
        raise update_api.httpx.ConnectError("no route to host")

    monkeypatch.setattr(update_api, "_latest_release", boom)
    with TestClient(app) as client:
        body = client.get("/api/update/check").json()
    assert body["update_available"] is False
    assert "Could not reach GitHub" in body["error"]
    assert body["current"] == updater.__version__


def test_check_flags_a_newer_release(monkeypatch, data_dir) -> None:
    monkeypatch.setattr(update_api, "_latest_cache", None)

    async def latest(repo: str) -> str:
        return "99.0.0"

    monkeypatch.setattr(update_api, "_latest_release", latest)
    with TestClient(app) as client:
        body = client.get("/api/update/check").json()
    assert body["latest"] == "99.0.0"
    assert body["update_available"] is True
