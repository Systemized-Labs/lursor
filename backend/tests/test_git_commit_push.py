"""``POST /workspaces/{id}/git/commit-push`` — the Changes panel's commit button.

One click in the panel is ``git add -A && git commit && git push`` in every
repo under the workspace that has changes. The interesting failure modes are
the ones where only part of that lands: a failed push must not fail the commit
(it stands, and the response says the push failed), an empty staging area must
fail *before* a commit is ever attempted, and a workspace whose root is not a
repo but holds several subdirectory repos must commit *each* dirty one — not
just whichever sorts first.
"""

from __future__ import annotations

import shutil
import subprocess

import pytest

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")


def _git(cwd, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-c", "commit.gpgsign=false", *args],
        cwd=str(cwd),
        check=True,
        capture_output=True,
        text=True,
    )
    return proc.stdout


def _make_repo(parent, name="repo"):
    """A repo at ``parent/name`` with an identity and one commit — so
    ``_run_git`` (which injects Lursor's isolated config, not the machine's)
    still finds an author to commit as. Repo-local, so nothing is written to
    global config."""
    root = parent / name
    root.mkdir(parents=True)
    (root / "file.txt").write_text("one\n")
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "tests@example.invalid")
    _git(root, "config", "user.name", "Tests")
    _git(root, "add", ".")
    _git(root, "commit", "-q", "-m", "init")
    return root


async def _workspace(client, path) -> str:
    r = await client.post("/workspaces", json={"name": "Repo", "path": str(path)})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _sibling_workspace(client, tmp_path):
    """A workspace whose root is *not* a repo but holds two sibling repos in
    subdirectories — the layout where the commit button must commit each repo
    separately."""
    ws_root = tmp_path / "ws"
    ws_root.mkdir()
    repo_a = _make_repo(ws_root, "rA")
    repo_b = _make_repo(ws_root, "rB")
    ws_id = await _workspace(client, ws_root)
    return ws_id, repo_a, repo_b


async def _commit_push(client, ws_id, *, message="wip", push=True, repo=None):
    payload: dict = {"message": message, "push": push}
    if repo is not None:
        payload["repo"] = repo
    return await client.post(f"/workspaces/{ws_id}/git/commit-push", json=payload)


def _by_repo(body) -> dict:
    return {c["repo"]: c for c in body["commits"]}


async def test_commit_succeeds_stats_reported_and_failed_push_is_not_fatal(
    client, tmp_path
):
    repo = _make_repo(tmp_path)
    (repo / "file.txt").write_text("one\ntwo\n")  # modified: +1
    (repo / "new.txt").write_text("new\nmore\n")  # untracked: +2
    ws_id = await _workspace(client, repo)

    r = await _commit_push(client, ws_id, message="  wip commit  ")
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["commits"]) == 1
    commit = body["commits"][0]

    assert commit["repo"] == ""  # the workspace root itself is the repo
    assert commit["files_changed"] == 2
    assert commit["additions"] == 3
    assert commit["deletions"] == 0
    assert len(commit["commit_hash"]) >= 7
    assert commit["branch"] in ("master", "main")
    # No remote configured — the push fails, but the commit still stands.
    assert commit["pushed"] is False
    assert commit["push_error"]

    head = _git(repo, "log", "-1", "--format=%s")
    assert head.strip() == "wip commit"  # the stripped message
    # Nothing left to commit: staging swept everything.
    assert _git(repo, "status", "--porcelain").strip() == ""


async def test_push_succeeds_with_a_remote(client, tmp_path):
    repo = _make_repo(tmp_path)
    bare = tmp_path / "remote.git"
    _git(tmp_path, "init", "-q", "--bare", "remote.git")
    _git(repo, "remote", "add", "origin", str(bare))
    _git(repo, "push", "-q", "-u", "origin", "HEAD")

    (repo / "two.txt").write_text("two\n")
    ws_id = await _workspace(client, repo)

    r = await _commit_push(client, ws_id, message="push me")
    assert r.status_code == 200, r.text
    commit = r.json()["commits"][0]
    assert commit["pushed"] is True
    assert commit["push_error"] is None

    # The commit reached the bare repo.
    log = _git(bare, "log", "-1", "--format=%s")
    assert log.strip() == "push me"


async def test_push_false_skips_the_push(client, tmp_path):
    repo = _make_repo(tmp_path)
    (repo / "file.txt").write_text("changed\n")
    ws_id = await _workspace(client, repo)

    r = await _commit_push(client, ws_id, push=False)
    assert r.status_code == 200, r.text
    commit = r.json()["commits"][0]
    assert commit["pushed"] is False
    assert commit["push_error"] is None
    assert _git(repo, "log", "-1", "--format=%s").strip() == "wip"


async def test_nothing_to_commit_returns_400_and_commits_nothing(client, tmp_path):
    repo = _make_repo(tmp_path)
    ws_id = await _workspace(client, repo)

    r = await _commit_push(client, ws_id)
    assert r.status_code == 400, r.text
    assert "No changes" in r.json()["detail"]
    # Only the initial commit exists.
    assert _git(repo, "rev-list", "--count", "HEAD").strip() == "1"


async def test_empty_message_falls_through_to_generation(client, tmp_path, monkeypatch):
    """A blank message is not an error: the endpoint composes one."""
    repo = _make_repo(tmp_path)
    (repo / "file.txt").write_text("changed\n")
    ws_id = await _workspace(client, repo)

    composed = {"called": False}

    async def fake_generate(stat, patch, model_str, custom_providers=None):
        composed["called"] = True
        # The staged change itself is what the model is pointed at.
        assert "file.txt" in stat
        assert "+changed\n" in patch
        return "feat: generated subject"

    monkeypatch.setattr("app.api.git.generate_commit_message", fake_generate)

    r = await _commit_push(client, ws_id, message="   ")
    assert r.status_code == 200, r.text
    assert composed["called"] is True
    assert r.json()["commits"][0]["message"] == "feat: generated subject"
    assert _git(repo, "log", "-1", "--format=%s").strip() == "feat: generated subject"


async def test_message_generated_when_absent(client, tmp_path, monkeypatch):
    repo = _make_repo(tmp_path)
    (repo / "file.txt").write_text("changed\n")
    ws_id = await _workspace(client, repo)

    async def fake_generate(stat, patch, model_str, custom_providers=None):
        return "feat: no message sent at all"

    monkeypatch.setattr("app.api.git.generate_commit_message", fake_generate)

    r = await client.post(f"/workspaces/{ws_id}/git/commit-push", json={"push": False})
    assert r.status_code == 200, r.text
    assert r.json()["commits"][0]["message"] == "feat: no message sent at all"
    assert _git(repo, "log", "-1", "--format=%s").strip() == "feat: no message sent at all"


async def test_fallback_message_when_generation_returns_nothing(
    client, tmp_path, monkeypatch
):
    repo = _make_repo(tmp_path)
    (repo / "file.txt").write_text("changed\n")
    (repo / "other.txt").write_text("more\n")
    ws_id = await _workspace(client, repo)

    async def empty_generate(*args, **kwargs):
        return ""

    monkeypatch.setattr("app.api.git.generate_commit_message", empty_generate)

    r = await client.post(f"/workspaces/{ws_id}/git/commit-push", json={})
    assert r.status_code == 200, r.text
    message = r.json()["commits"][0]["message"]
    assert message.startswith("Update ")
    assert "and 1 other" in message
    assert _git(repo, "log", "-1", "--format=%s").strip() == message


async def test_fallback_message_when_generation_raises(client, tmp_path, monkeypatch):
    repo = _make_repo(tmp_path)
    (repo / "file.txt").write_text("changed\n")
    ws_id = await _workspace(client, repo)

    async def broken_generate(*args, **kwargs):
        raise RuntimeError("no model configured")

    monkeypatch.setattr("app.api.git.generate_commit_message", broken_generate)

    r = await client.post(f"/workspaces/{ws_id}/git/commit-push", json={})
    assert r.status_code == 200, r.text
    assert r.json()["commits"][0]["message"] == "Update file.txt"
    assert _git(repo, "log", "-1", "--format=%s").strip() == "Update file.txt"


async def test_no_repo_returns_409(client, tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / "notes.md").write_text("hi\n")
    ws_id = await _workspace(client, plain)

    r = await _commit_push(client, ws_id)
    assert r.status_code == 409, r.text


# --- Subdirectory repos: a workspace holding several repos -------------------


async def test_change_in_non_first_subdirectory_repo_commit_sits_in_that_repo(
    client, tmp_path
):
    """The regression: changes live in the *second* repo found under the
    workspace. Committing only the first (alphabetically) would report "No
    changes to commit" with a dirty repo right there."""
    ws_id, repo_a, repo_b = await _sibling_workspace(client, tmp_path)
    (repo_b / "file.txt").write_text("changed\n")

    r = await _commit_push(client, ws_id, push=False)
    assert r.status_code == 200, r.text
    commits = _by_repo(r.json())
    assert set(commits) == {"rB"}
    assert commits["rB"]["files_changed"] == 1

    assert _git(repo_b, "log", "-1", "--format=%s").strip() == "wip"
    # The clean repo was skipped — still only its initial commit.
    assert _git(repo_a, "rev-list", "--count", "HEAD").strip() == "1"


async def test_multi_repo_commits_each_dirty_repo(client, tmp_path):
    ws_id, repo_a, repo_b = await _sibling_workspace(client, tmp_path)
    (repo_a / "file.txt").write_text("one\ntwo\n")
    (repo_b / "extra.txt").write_text("new\n")

    r = await _commit_push(client, ws_id, push=False)
    assert r.status_code == 200, r.text
    commits = _by_repo(r.json())
    assert set(commits) == {"rA", "rB"}
    assert commits["rA"]["additions"] == 1
    assert commits["rB"]["additions"] == 1

    # One commit per repo, both trees clean afterwards.
    for repo in (repo_a, repo_b):
        assert _git(repo, "log", "-1", "--format=%s").strip() == "wip"
        assert _git(repo, "status", "--porcelain").strip() == ""


async def test_multi_repo_generated_message_describes_each_repo(
    client, tmp_path, monkeypatch
):
    """Each repo's message is composed from *its own* staged diff."""
    ws_id, repo_a, repo_b = await _sibling_workspace(client, tmp_path)
    (repo_a / "file.txt").write_text("apple\n")
    (repo_b / "file.txt").write_text("banana\n")

    async def fake_generate(stat, patch, model_str, custom_providers=None):
        if "+apple\n" in patch:
            return "Update rA"
        if "+banana\n" in patch:
            return "Update rB"
        raise AssertionError(f"unexpected patch: {patch!r}")

    monkeypatch.setattr("app.api.git.generate_commit_message", fake_generate)

    r = await _commit_push(client, ws_id, message=None, push=False)
    assert r.status_code == 200, r.text
    commits = _by_repo(r.json())
    assert commits["rA"]["message"] == "Update rA"
    assert commits["rB"]["message"] == "Update rB"
    assert _git(repo_a, "log", "-1", "--format=%s").strip() == "Update rA"
    assert _git(repo_b, "log", "-1", "--format=%s").strip() == "Update rB"


async def test_one_repo_failed_push_neither_fails_nor_blocks_the_other(
    client, tmp_path
):
    ws_id, repo_a, repo_b = await _sibling_workspace(client, tmp_path)
    # rA can push; rB has no remote, so its push fails.
    bare = tmp_path / "remote.git"
    _git(tmp_path, "init", "-q", "--bare", "remote.git")
    _git(repo_a, "remote", "add", "origin", str(bare))
    _git(repo_a, "push", "-q", "-u", "origin", "HEAD")
    (repo_a / "file.txt").write_text("one\ntwo\n")
    (repo_b / "file.txt").write_text("changed\n")

    r = await _commit_push(client, ws_id)
    assert r.status_code == 200, r.text
    commits = _by_repo(r.json())

    assert commits["rA"]["pushed"] is True
    assert commits["rA"]["push_error"] is None
    assert _git(bare, "log", "-1", "--format=%s").strip() == "wip"

    assert commits["rB"]["pushed"] is False
    assert commits["rB"]["push_error"]
    # …but rB's commit still stands.
    assert _git(repo_b, "log", "-1", "--format=%s").strip() == "wip"


async def test_repo_param_targets_one_subdirectory_repo(client, tmp_path):
    ws_id, repo_a, repo_b = await _sibling_workspace(client, tmp_path)
    (repo_a / "file.txt").write_text("changed\n")
    (repo_b / "file.txt").write_text("changed\n")

    r = await _commit_push(client, ws_id, push=False, repo="rB")
    assert r.status_code == 200, r.text
    assert set(_by_repo(r.json())) == {"rB"}
    assert _git(repo_b, "log", "-1", "--format=%s").strip() == "wip"
    # rA's change is staged neither committed — untouched by the targeted run.
    assert _git(repo_a, "log", "-1", "--format=%s").strip() == "init"


async def test_repo_param_unknown_path_returns_404(client, tmp_path):
    ws_id, repo_a, _ = await _sibling_workspace(client, tmp_path)
    (repo_a / "file.txt").write_text("changed\n")

    r = await _commit_push(client, ws_id, repo="nope")
    assert r.status_code == 404, r.text


async def test_repo_param_clean_target_returns_400(client, tmp_path):
    ws_id, repo_a, repo_b = await _sibling_workspace(client, tmp_path)
    (repo_b / "file.txt").write_text("changed\n")

    r = await _commit_push(client, ws_id, repo="rA")
    assert r.status_code == 400, r.text
    assert "No changes" in r.json()["detail"]


async def test_repo_in_nested_subdirectory(client, tmp_path):
    ws_root = tmp_path / "ws"
    ws_root.mkdir()
    repo = _make_repo(ws_root, "services/api")
    (repo / "file.txt").write_text("changed\n")
    ws_id = await _workspace(client, ws_root)

    r = await _commit_push(client, ws_id, push=False)
    assert r.status_code == 200, r.text
    commits = _by_repo(r.json())
    assert set(commits) == {"services/api"}
    assert _git(repo, "log", "-1", "--format=%s").strip() == "wip"
