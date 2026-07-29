"""``GET /workspaces/{id}/git/status`` — the states that decorate the file tree.

The tree draws VS Code's letters, so the states have to be distinguishable at the
granularity VS Code shows them at: an untracked file is not a staged addition, and
a wholly-ignored directory must arrive as *one* entry (the guarantee that keeps a
`node_modules` from turning a tree render into 40,000 rows of payload).
"""

from __future__ import annotations

import shutil
import subprocess

import pytest

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")


def _git(cwd, *args: str) -> None:
    subprocess.run(
        [
            "git",
            # Identity on the command line: the suite must not depend on (or write
            # to) whatever git config the machine running it happens to have.
            "-c",
            "user.email=tests@example.invalid",
            "-c",
            "user.name=Tests",
            "-c",
            "commit.gpgsign=false",
            *args,
        ],
        cwd=str(cwd),
        check=True,
        capture_output=True,
    )


@pytest.fixture
def repo(tmp_path):
    """A repo with one commit, then one of every working-tree state we report."""
    root = tmp_path / "repo"
    root.mkdir()
    (root / ".gitignore").write_text("secrets.env\nbuilt/\n")
    (root / "tracked.txt").write_text("one\n")
    (root / "untouched.txt").write_text("stays\n")
    _git(root, "init", "-q")
    _git(root, "add", ".")
    _git(root, "commit", "-q", "-m", "init")

    (root / "tracked.txt").write_text("two\n")  # modified, unstaged
    (root / "fresh.txt").write_text("new\n")  # untracked
    (root / "staged.txt").write_text("new\n")
    _git(root, "add", "staged.txt")  # added, staged
    (root / "untouched.txt").unlink()  # deleted
    (root / "secrets.env").write_text("KEY=1\n")  # ignored file
    built = root / "built"
    built.mkdir()
    for i in range(3):
        (built / f"out{i}.js").write_text("x\n")  # ignored directory
    return root


async def _status(client, path) -> dict:
    ws = (
        await client.post("/workspaces", json={"name": "Repo", "path": str(path)})
    ).json()
    r = await client.get(f"/workspaces/{ws['id']}/git/status")
    assert r.status_code == 200, r.text
    return r.json()


async def test_status_reports_each_working_tree_state(client, repo):
    body = await _status(client, repo)
    assert body["is_repo"] is True

    states = {f["path"]: f["status"] for f in body["files"]}
    assert states["tracked.txt"] == "modified"
    assert states["fresh.txt"] == "untracked"
    assert states["staged.txt"] == "added"
    assert states["untouched.txt"] == "deleted"
    # Ignored paths are reported apart from changes, never as a status.
    assert "secrets.env" not in states and "built/out0.js" not in states

    staged = {f["path"]: f["staged"] for f in body["files"]}
    assert staged["staged.txt"] is True
    assert staged["tracked.txt"] is False
    assert staged["fresh.txt"] is False


async def test_ignored_directory_collapses_to_one_entry(client, repo):
    body = await _status(client, repo)
    # The whole point of --ignored=matching: the directory, not its contents.
    assert "built/" in body["ignored"]
    assert not any(p.startswith("built/o") for p in body["ignored"])
    assert "secrets.env" in body["ignored"]


async def test_nested_repo_paths_are_workspace_relative(client, tmp_path):
    root = tmp_path / "space"
    inner = root / "nested"
    inner.mkdir(parents=True)
    (inner / "a.txt").write_text("a\n")
    _git(inner, "init", "-q")

    body = await _status(client, root)
    assert body["is_repo"] is True
    assert [f["path"] for f in body["files"]] == ["nested/a.txt"]


async def test_no_repo_reports_not_a_repo(client, tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / "notes.md").write_text("hi\n")

    body = await _status(client, plain)
    assert body == {"is_repo": False, "files": [], "ignored": []}
