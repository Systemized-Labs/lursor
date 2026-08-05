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
        capture_output=True, text=True, cwd=str(tmp_path / "cwd"), env=env,
    )
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def test_data_dir_env_file_is_read(tmp_path):
    (tmp_path / "cwd").mkdir()
    got = _probe(tmp_path, str(tmp_path / "data"),
                 {"data/.env": "OPENROUTER_API_KEY=from-data-dir\n"})
    assert got == "from-data-dir"


def test_local_env_file_still_wins(tmp_path):
    got = _probe(tmp_path, str(tmp_path / "data"), {
        "data/.env": "OPENROUTER_API_KEY=from-data-dir\n",
        "cwd/.env": "OPENROUTER_API_KEY=from-cwd\n",
    })
    assert got == "from-cwd", "a developer's backend/.env must stay the last word"


def test_no_env_files_is_fine(tmp_path):
    (tmp_path / "cwd").mkdir()
    assert _probe(tmp_path, str(tmp_path / "data"), {}) == ""
