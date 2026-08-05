"""Remote directory browsing (``app/api/fs.py``) and ``GET /api/server-info``.

These back the workspace picker on a headless backend, where the native OS dialog
route can't run.
"""

from __future__ import annotations

import sys

import pytest
from httpx import AsyncClient

from app import __version__


async def _dirs(client: AsyncClient, **params) -> dict:
    res = await client.get("/fs/dirs", params=params)
    assert res.status_code == 200, res.text
    return res.json()


async def test_lists_subdirectories(client: AsyncClient, tmp_path) -> None:
    (tmp_path / "alpha").mkdir()
    (tmp_path / "beta").mkdir()
    (tmp_path / "a-file.txt").write_text("not a directory")

    body = await _dirs(client, path=str(tmp_path))

    assert [e["name"] for e in body["entries"]] == ["alpha", "beta"]
    assert body["path"] == str(tmp_path.resolve())
    assert body["parent"] == str(tmp_path.resolve().parent)
    assert body["truncated"] is False


async def test_flags_repositories(client: AsyncClient, tmp_path) -> None:
    """What you are usually looking for when choosing a workspace."""
    (tmp_path / "plain").mkdir()
    repo = tmp_path / "checkout"
    (repo / ".git").mkdir(parents=True)

    body = await _dirs(client, path=str(tmp_path))
    entries = {e["name"]: e["is_repo"] for e in body["entries"]}

    assert entries == {"plain": False, "checkout": True}


async def test_hidden_directories_are_opt_in(client: AsyncClient, tmp_path) -> None:
    (tmp_path / ".config").mkdir()
    (tmp_path / "visible").mkdir()

    assert [e["name"] for e in (await _dirs(client, path=str(tmp_path)))["entries"]] == [
        "visible"
    ]

    shown = await _dirs(client, path=str(tmp_path), show_hidden=True)
    assert [e["name"] for e in shown["entries"]] == [".config", "visible"]


async def test_defaults_to_home(client: AsyncClient) -> None:
    """An empty path is the picker's opening state."""
    body = await _dirs(client)
    assert body["path"] == body["home"]


async def test_expands_tilde(client: AsyncClient) -> None:
    body = await _dirs(client, path="~")
    assert body["path"] == body["home"]


async def test_root_has_no_parent(client: AsyncClient) -> None:
    """What stops the picker's "up" control at the top."""
    body = await _dirs(client, path="/")
    assert body["parent"] is None


async def test_relative_traversal_is_resolved(client: AsyncClient, tmp_path) -> None:
    (tmp_path / "child").mkdir()
    body = await _dirs(client, path=str(tmp_path / "child" / ".."))
    assert body["path"] == str(tmp_path.resolve())


async def test_missing_directory_is_404(client: AsyncClient, tmp_path) -> None:
    res = await client.get("/fs/dirs", params={"path": str(tmp_path / "nope")})
    assert res.status_code == 404


async def test_file_path_is_400(client: AsyncClient, tmp_path) -> None:
    target = tmp_path / "file.txt"
    target.write_text("x")
    res = await client.get("/fs/dirs", params={"path": str(target)})
    assert res.status_code == 400


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits")
async def test_unreadable_directory_is_403(client: AsyncClient, tmp_path) -> None:
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o000)
    try:
        res = await client.get("/fs/dirs", params={"path": str(locked)})
        # Running as root defeats the permission bit entirely, which is a plausible
        # way to run a VPS backend — accept either outcome rather than asserting
        # something that depends on who ran the suite.
        assert res.status_code in (200, 403)
    finally:
        locked.chmod(0o700)


async def test_server_info_reports_capabilities(client: AsyncClient) -> None:
    res = await client.get("/server-info")
    assert res.status_code == 200
    body = res.json()
    assert body["platform"] == sys.platform
    assert isinstance(body["can_pick_folder"], bool)
    # The suite runs without a token, which is the default posture.
    assert body["auth_required"] is False

    # The frontend/backend version handshake. This endpoint carries it because the
    # client needs it on connect: a remote backend is the one configuration where the
    # two halves can drift, and the UI has to be able to say so before anyone asks it
    # to check for updates.
    assert body["version"] == __version__
    assert body["install_kind"] in ("checkout", "bundled")
    assert body["managed_by"] in ("desktop", "service", "none")
    # No token in the suite, so self-update can never be offered here.
    assert body["self_updatable"] is False
    assert body["self_update_blocked_reason"]
