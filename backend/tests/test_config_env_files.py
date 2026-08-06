"""Data-dir .env support (config._env_files)."""

from __future__ import annotations

import subprocess
import sys
import textwrap


def _probe(tmp_path, data_dir_env: str | None, files: dict[str, str]) -> str:
    """Run a fresh interpreter so the lru_cache'd settings are built from scratch."""
    for name, body in files.items():
        p = tmp_path / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
    code = textwrap.dedent(
        """
        from app.config import Settings
        s = Settings()
        print(s.openrouter_api_key or "")
        """
    )
    env = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path)}
    if data_dir_env:
        env["LURSOR_DATA_DIR"] = data_dir_env
    r = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        cwd=str(tmp_path / "cwd"),
        env=env,
    )
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def test_data_dir_env_file_is_read(tmp_path):
    (tmp_path / "cwd").mkdir()
    got = _probe(
        tmp_path, str(tmp_path / "data"), {"data/.env": "OPENROUTER_API_KEY=from-data-dir\n"}
    )
    assert got == "from-data-dir"


def test_local_env_file_still_wins(tmp_path):
    got = _probe(
        tmp_path,
        str(tmp_path / "data"),
        {
            "data/.env": "OPENROUTER_API_KEY=from-data-dir\n",
            "cwd/.env": "OPENROUTER_API_KEY=from-cwd\n",
        },
    )
    assert got == "from-cwd", "a developer's backend/.env must stay the last word"


def test_no_env_files_is_fine(tmp_path):
    (tmp_path / "cwd").mkdir()
    assert _probe(tmp_path, str(tmp_path / "data"), {}) == ""


# --- One data root ---------------------------------------------------------
#
# ``conftest`` points DATABASE_URL / WORKSPACES_DIR / SKILLS_DIR at a temp dir for the
# whole session so no test can touch real data. These tests are about the *defaults*,
# so they have to clear those first.

_PATH_ENV = ("DATABASE_URL", "WORKSPACES_DIR", "SKILLS_DIR", "MEDIA_DIR")


def _clear_path_env(monkeypatch) -> None:
    for name in _PATH_ENV:
        monkeypatch.delenv(name, raising=False)


def test_all_writable_paths_default_to_the_data_root(monkeypatch):
    """One location for state, whatever launched the backend.

    Until 0.1.10 the database alone defaulted to ``BACKEND_DIR/lursor.db`` while the
    other three paths already used ``~/.lursor``. That split meant the installed app
    and a source run read *different databases*, so workspaces created in one were
    absent in the other and looked lost — and the checkout is disposable, so anything
    written there is one ``git clean`` from gone.
    """
    from app.config import DEFAULT_DATA_ROOT, Settings

    _clear_path_env(monkeypatch)
    monkeypatch.delenv("LURSOR_DATA_DIR", raising=False)
    s = Settings(_env_file=None)

    root = DEFAULT_DATA_ROOT.expanduser()
    assert s.database_url == f"sqlite+aiosqlite:///{root / 'lursor.db'}"
    assert s.workspaces_dir == root / "workspaces"
    assert s.skills_dir == root / "skills"
    assert s.media_dir == root / "media"
    # The one thing that must never be true again: state inside the checkout.
    assert "backend/lursor.db" not in s.database_url


def test_data_dir_override_rebases_everything(monkeypatch, tmp_path):
    """The override is how a second isolated backend is run (see docs/REMOTE.md)."""
    from app.config import Settings

    _clear_path_env(monkeypatch)
    monkeypatch.setenv("LURSOR_DATA_DIR", str(tmp_path))
    s = Settings(_env_file=None)

    assert s.database_url == f"sqlite+aiosqlite:///{tmp_path / 'lursor.db'}"
    assert s.workspaces_dir == tmp_path / "workspaces"


def test_explicit_database_url_still_wins(monkeypatch, tmp_path):
    """What the test suite itself relies on: conftest names a database and keeps it."""
    from app.config import Settings

    _clear_path_env(monkeypatch)
    monkeypatch.setenv("LURSOR_DATA_DIR", str(tmp_path))
    s = Settings(_env_file=None, database_url="sqlite+aiosqlite:////tmp/explicit.db")

    assert s.database_url == "sqlite+aiosqlite:////tmp/explicit.db"
    # Paths that were not overridden still follow the data root.
    assert s.workspaces_dir == tmp_path / "workspaces"
