"""Workspace git status: the uncommitted diff powering the "Changes" panel.

``GET /api/workspaces/{id}/git/diff`` reports every git repository found under the
workspace root and its working-tree changes against ``HEAD`` — each modified,
added (including untracked), and deleted file, with its unified diff — so the
right-dock Changes panel can render a review view without dropping to a terminal.

``GET /api/workspaces/{id}/git/status`` is the same enumeration with the patches
left out: just a state per path, for decorating rows in the file tree the way VS
Code does. It exists separately because the tree wants this on every workspace it
shows, and computing a patch per changed file to colour a row would be paying for
the whole review view to draw a letter.

A workspace often isn't a single repo at its root: it may hold one repo nested in
a subdirectory (``swarmcore-ui/…``) or several sibling repos. So we walk the tree
(pruning noise dirs like ``node_modules``) to discover all repo roots, diff each,
and report file paths relative to the workspace root — prefixed with the repo's
subdirectory — so the panel can group changes by repo.

Diffs come from shelling out to ``git`` (reusing :func:`app.api.github._run_git`,
which runs non-interactively and merges Lursor's isolated git config). Add/delete
counts and binary detection are parsed straight from each file's patch.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from collections.abc import Iterator
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, WebSocket, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocketDisconnect
from watchfiles import awatch

from app.api.github import _run_git
from app.db.models import Workspace
from app.db.session import async_session_factory, get_session

router = APIRouter(prefix="/workspaces/{workspace_id}/git", tags=["git"])

# The well-known empty-tree object. Used as the diff base when a repo has no
# commits yet, so a brand-new repo's staged files still diff as additions.
_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

# Cap a single file's patch so a giant generated file can't bloat the payload.
_MAX_PATCH_BYTES = 256 * 1024

# Dirs never worth descending into when hunting for repos: package/build output
# and other machine-generated trees. Keeps discovery cheap on a big workspace.
_PRUNE_DIRS = frozenset(
    {
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        "dist",
        "build",
        ".next",
        ".turbo",
        "target",
    }
)

# Bound the discovery walk so a pathological tree can't hang the request.
_MAX_WALK_DIRS = 20_000


class ChangedFile(BaseModel):
    """One file in a repo's working tree that differs from HEAD."""

    path: str  # workspace-relative (repo subdir prefix + repo-relative path)
    repo: str  # workspace-relative repo root ("" when the repo is the root)
    status: str  # "added" | "modified" | "deleted"
    additions: int
    deletions: int
    is_binary: bool
    truncated: bool
    diff: str  # unified diff text (empty for binary/truncated)


class FileStatus(BaseModel):
    """One path's working-tree state, with no patch — for tree decoration."""

    path: str  # workspace-relative (repo subdir prefix + repo-relative path)
    status: str  # "modified" | "added" | "untracked" | "deleted" | "conflicted"
    staged: bool  # the index differs from HEAD (the change is at least partly staged)


class GitStatus(BaseModel):
    """Every path under the workspace that git has something to say about."""

    is_repo: bool
    files: list[FileStatus]
    # Ignored paths. A trailing "/" marks a wholly-ignored directory and stands for
    # everything beneath it, so a `node_modules` never arrives one file at a time.
    ignored: list[str]


class RepoInfo(BaseModel):
    """A git repo discovered under the workspace root."""

    path: str  # workspace-relative repo root ("" when the repo is the root)
    branch: str | None


class GitDiff(BaseModel):
    is_repo: bool  # whether at least one repo was found
    branch: str | None  # convenience: the root/first repo's branch
    repos: list[RepoInfo]
    files: list[ChangedFile]
    additions: int
    deletions: int


class BranchRef(BaseModel):
    """A branch offered in the picker.

    ``remote`` is set only for a remote-tracking branch with no local
    counterpart yet — selecting it checks out a new local branch that tracks it.
    """

    name: str  # short branch name (checkout target), e.g. "feat/x"
    remote: str | None = None  # remote name for remote-only branches, else None


class GitBranches(BaseModel):
    """Branches of the workspace's primary repo: local first, then remote-only."""

    is_repo: bool
    current: str | None
    branches: list[BranchRef]


class CheckoutInput(BaseModel):
    branch: str


async def _workspace_root(workspace_id: str, session: AsyncSession) -> Path:
    """Resolve a workspace's on-disk root, or 404/409 if unavailable."""
    ws = await session.get(Workspace, workspace_id)
    if ws is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    if not ws.path or not Path(ws.path).is_dir():
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Workspace has no accessible directory"
        )
    return Path(ws.path).resolve()


def _find_repos(root: Path) -> list[Path]:
    """Discover every git repo root under ``root`` (root itself included).

    A directory is a repo root when it contains a ``.git`` entry (a dir for a
    normal checkout, a file for a submodule/worktree). We stop descending once a
    repo is found — its inner ``.git`` and submodule contents are the repo's
    concern — and prune noise dirs so the walk stays cheap.
    """
    repos: list[Path] = []
    walked = 0
    for dirpath, dirnames, _ in os.walk(root):
        walked += 1
        if walked > _MAX_WALK_DIRS:
            break
        here = Path(dirpath)
        if (here / ".git").exists():
            repos.append(here)
            dirnames[:] = []  # don't descend into a repo we've already recorded
            continue
        dirnames[:] = [d for d in dirnames if d not in _PRUNE_DIRS and d != ".git"]
    repos.sort(key=lambda p: p.as_posix().lower())
    return repos


def _primary_repo(root: Path) -> Path | None:
    """The repo whose branch heads the UI: the root repo, else the first found."""
    repos = _find_repos(root)
    if not repos:
        return None
    for repo in repos:
        if repo == root:
            return repo
    return repos[0]


def _classify(xy: str) -> str:
    """Map a porcelain status code to our coarse add/modify/delete kind."""
    if xy == "??" or xy.strip() == "A":
        return "added"
    if "D" in xy:
        return "deleted"
    return "modified"


# Porcelain codes for an unresolved merge conflict. They contain the same letters
# as ordinary changes ("AA", "DU", …), so they have to be matched before anything
# else reads a letter out of the pair.
_CONFLICT_CODES = frozenset({"DD", "AU", "UD", "UA", "DU", "AA", "UU"})


def _porcelain_records(out: str) -> Iterator[tuple[str, str]]:
    """Yield ``(XY, path)`` for each record of ``git status --porcelain -z`` output.

    A record is a two-letter code, a space, then the path — so anything shorter
    than four characters is the trailing empty field, not an entry.
    """
    for record in out.split("\0"):
        if not record or len(record) < 4:
            continue
        yield record[:2], record[3:]


def _tree_status(xy: str) -> str:
    """Map a porcelain code to the state a file-tree row is decorated with.

    Finer-grained than :func:`_classify`, which only needs to know how to diff the
    file: the tree draws VS Code's letters, where an untracked file (U, green) and
    a staged new one (A) read differently, and a conflict (C) is its own state.
    Deletion wins over addition so a staged-then-deleted path reads as gone, which
    is what its absence from the tree already says.
    """
    if xy in _CONFLICT_CODES:
        return "conflicted"
    if xy == "??":
        return "untracked"
    if "D" in xy:
        return "deleted"
    if "A" in xy or "C" in xy:
        return "added"
    return "modified"  # M, T (typechange), and anything git adds later


def _measure(patch: str) -> tuple[int, int, bool]:
    """Count added/removed lines and detect a binary patch, from the diff text."""
    additions = deletions = 0
    is_binary = False
    for line in patch.split("\n"):
        if line.startswith(("+++", "---")):
            continue
        if line.startswith("+"):
            additions += 1
        elif line.startswith("-"):
            deletions += 1
        elif line.startswith("Binary files") or line.startswith("GIT binary patch"):
            is_binary = True
    return additions, deletions, is_binary


async def _file_patch(repo: Path, path: str, status_kind: str, base: str) -> str:
    """Return the unified diff for a single changed file (paths repo-relative).

    Untracked files (``added`` with nothing in the index) have no diff base, so
    they're diffed against ``/dev/null`` via ``--no-index`` (which exits non-zero
    by design). Tracked changes diff the working tree against ``base`` (HEAD, or
    the empty tree for a repo with no commits).
    """
    cwd = str(repo)
    if status_kind == "added":
        _, out, _ = await _run_git(
            "diff", "--no-index", "--no-color", "--", "/dev/null", path, cwd=cwd
        )
        if out.strip():
            return out
    _, out, _ = await _run_git("diff", "--no-color", base, "--", path, cwd=cwd)
    return out


async def _repo_diff(repo: Path) -> tuple[str | None, list[ChangedFile]]:
    """Return ``(branch, changed files)`` for one repo (paths repo-relative)."""
    cwd = str(repo)

    branch_rc, branch_out, _ = await _run_git(
        "rev-parse", "--abbrev-ref", "HEAD", cwd=cwd
    )
    branch = branch_out.strip() if branch_rc == 0 else None

    # Base for tracked diffs: HEAD when the repo has commits, else the empty tree.
    head_rc, _, _ = await _run_git("rev-parse", "--verify", "HEAD", cwd=cwd)
    base = "HEAD" if head_rc == 0 else _EMPTY_TREE

    # Enumerate changes with NUL-separated porcelain. --no-renames keeps parsing
    # simple: a rename shows as a delete + an add rather than a two-path record.
    _, status_out, _ = await _run_git(
        "status", "--porcelain", "-z", "--untracked-files=all", "--no-renames", cwd=cwd
    )

    files: list[ChangedFile] = []
    for xy, path in _porcelain_records(status_out):
        kind = _classify(xy)

        patch = await _file_patch(repo, path, kind, base)
        additions, deletions, is_binary = _measure(patch)
        truncated = len(patch.encode("utf-8", errors="replace")) > _MAX_PATCH_BYTES

        files.append(
            ChangedFile(
                path=path,
                repo="",  # filled in by the caller with the repo's subdir prefix
                status=kind,
                additions=additions,
                deletions=deletions,
                is_binary=is_binary,
                truncated=truncated,
                diff="" if (is_binary or truncated) else patch,
            )
        )
    return branch, files


@router.get("/diff", response_model=GitDiff)
async def get_diff(
    workspace_id: str,
    session: AsyncSession = Depends(get_session),
) -> GitDiff:
    """Return uncommitted changes across every repo under the workspace root."""
    root = await _workspace_root(workspace_id, session)
    repos = _find_repos(root)
    if not repos:
        return GitDiff(
            is_repo=False, branch=None, repos=[], files=[], additions=0, deletions=0
        )

    repo_infos: list[RepoInfo] = []
    all_files: list[ChangedFile] = []
    total_add = total_del = 0
    root_branch: str | None = None

    for repo in repos:
        rel = "" if repo == root else repo.relative_to(root).as_posix()
        branch, files = await _repo_diff(repo)
        repo_infos.append(RepoInfo(path=rel, branch=branch))
        # Prefer the root repo's branch for the header; else the first repo's.
        if rel == "" or root_branch is None:
            root_branch = branch

        for f in files:
            f.repo = rel
            f.path = f"{rel}/{f.path}" if rel else f.path
            all_files.append(f)
            total_add += f.additions
            total_del += f.deletions

    all_files.sort(key=lambda f: f.path.lower())
    return GitDiff(
        is_repo=True,
        branch=root_branch,
        repos=repo_infos,
        files=all_files,
        additions=total_add,
        deletions=total_del,
    )


@router.get("/status", response_model=GitStatus)
async def get_status(
    workspace_id: str,
    session: AsyncSession = Depends(get_session),
) -> GitStatus:
    """Report a state per path across every repo under the workspace root.

    One ``git status`` per repo and no diffing at all, so the file tree can decorate
    its rows without the cost of ``/diff``. ``--ignored=matching`` is what keeps
    that true for the ignored set: it collapses a wholly-ignored directory to the
    directory itself instead of listing the 40,000 files inside a ``node_modules``.
    """
    root = await _workspace_root(workspace_id, session)
    repos = _find_repos(root)
    if not repos:
        return GitStatus(is_repo=False, files=[], ignored=[])

    files: list[FileStatus] = []
    ignored: list[str] = []
    for repo in repos:
        rel = "" if repo == root else repo.relative_to(root).as_posix()
        # --no-renames, as in the diff: a rename reads as a delete plus an add,
        # which is one record per path and needs no two-path parsing.
        _, out, _ = await _run_git(
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
            "--no-renames",
            cwd=str(repo),
        )
        for xy, path in _porcelain_records(out):
            full = f"{rel}/{path}" if rel else path
            if xy == "!!":
                ignored.append(full)
                continue
            files.append(
                FileStatus(
                    path=full,
                    status=_tree_status(xy),
                    # X is the index column; " " means unstaged, "?"/"!" untracked
                    # or ignored — neither of which is a staged change.
                    staged=xy[0] not in " ?!",
                )
            )

    files.sort(key=lambda f: f.path.lower())
    ignored.sort(key=str.lower)
    return GitStatus(is_repo=True, files=files, ignored=ignored)


async def _list_branches(repo: Path) -> GitBranches:
    """Local + remote-only branches of ``repo``, most-recently-committed first."""
    cwd = str(repo)

    cur_rc, cur_out, _ = await _run_git("rev-parse", "--abbrev-ref", "HEAD", cwd=cwd)
    current = cur_out.strip() if cur_rc == 0 else None

    local_rc, local_out, _ = await _run_git(
        "for-each-ref",
        "--format=%(refname:short)",
        "--sort=-committerdate",
        "refs/heads",
        cwd=cwd,
    )
    locals_ = [b.strip() for b in local_out.split("\n") if b.strip()] if local_rc == 0 else []
    local_set = set(locals_)

    # Remote-tracking refs come back as "<remote>/<branch>" (e.g. "origin/dev").
    # Surface only those without a local counterpart; skip the "<remote>/HEAD"
    # symbolic ref and de-dupe branches carried by more than one remote.
    rem_rc, rem_out, _ = await _run_git(
        "for-each-ref",
        "--format=%(refname:short)",
        "--sort=-committerdate",
        "refs/remotes",
        cwd=cwd,
    )
    remote_only: list[BranchRef] = []
    seen: set[str] = set()
    if rem_rc == 0:
        for ref in rem_out.split("\n"):
            ref = ref.strip()
            if "/" not in ref:
                continue
            remote_name, branch_name = ref.split("/", 1)
            if branch_name == "HEAD" or branch_name in local_set or branch_name in seen:
                continue
            seen.add(branch_name)
            remote_only.append(BranchRef(name=branch_name, remote=remote_name))

    branches = [BranchRef(name=b) for b in locals_] + remote_only
    return GitBranches(is_repo=True, current=current, branches=branches)


@router.get("/branches", response_model=GitBranches)
async def get_branches(
    workspace_id: str,
    session: AsyncSession = Depends(get_session),
) -> GitBranches:
    """List the primary repo's branches (local, then remote-only)."""
    root = await _workspace_root(workspace_id, session)
    repo = _primary_repo(root)
    if repo is None:
        return GitBranches(is_repo=False, current=None, branches=[])
    return await _list_branches(repo)


@router.post("/checkout", response_model=GitBranches)
async def checkout_branch(
    workspace_id: str,
    payload: CheckoutInput,
    session: AsyncSession = Depends(get_session),
) -> GitBranches:
    """Switch the primary repo to a branch.

    Local branches check out directly. A remote-only branch is materialised as a
    new local branch that tracks the matching remote ref.
    """
    root = await _workspace_root(workspace_id, session)
    repo = _primary_repo(root)
    if repo is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Workspace has no git repository"
        )
    branch = payload.branch.strip()
    if not branch:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A branch is required")
    cwd = str(repo)

    local_rc, _, _ = await _run_git(
        "show-ref", "--verify", "--quiet", f"refs/heads/{branch}", cwd=cwd
    )
    if local_rc == 0:
        rc, _, err = await _run_git("checkout", branch, cwd=cwd)
    else:
        # Find a remote ref whose branch component matches (e.g. "origin/dev").
        _, rem_out, _ = await _run_git(
            "for-each-ref", "--format=%(refname:short)", "refs/remotes", cwd=cwd
        )
        match = next(
            (
                r.strip()
                for r in rem_out.split("\n")
                if "/" in r.strip() and r.strip().split("/", 1)[1] == branch
            ),
            None,
        )
        if match:
            # -b <branch> <remote/branch> creates a local branch tracking it.
            rc, _, err = await _run_git("checkout", "-b", branch, match, cwd=cwd)
        else:
            # No local or remote match — let git try (and report its own error).
            rc, _, err = await _run_git("checkout", branch, cwd=cwd)

    if rc != 0:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            err.strip() or f"Failed to switch to '{branch}'",
        )
    return await _list_branches(repo)


def _is_git_state_change(path: str) -> bool:
    """True for a ``.git`` internal path whose change alters the working-tree diff
    or branch header — a commit, staging, branch switch, merge/rebase/reset.

    Deliberately ignores the high-churn internals (loose/packed objects, logs,
    lock files) so a background fetch or gc can't spam refreshes. This is the
    filter watchfiles' ``DefaultFilter`` normally applies in reverse: that one
    drops all of ``.git`` (which is why plain file-watching never sees commits),
    so we supply our own to surface just the state-changing writes.
    """
    parts = Path(path).parts
    try:
        i = parts.index(".git")
    except ValueError:
        return False
    rel = parts[i + 1 :]  # path components inside the .git dir
    if not rel:
        return False
    top, name = rel[0], rel[-1]
    if top == "objects" or top == "logs" or name.endswith(".lock"):
        return False
    if top == "refs":  # a commit or branch create/delete moves a ref here
        return True
    return name in {"HEAD", "index", "packed-refs", "ORIG_HEAD", "MERGE_HEAD"}


@router.websocket("/watch")
async def watch_git(websocket: WebSocket, workspace_id: str) -> None:
    """Notify the client when a repo's git state changes so the Changes panel can
    re-fetch its diff live, without a manual refresh.

    Working-tree *file* edits (agent saves, manual edits) already reach the panel
    via the files-watch socket; this socket covers the ``.git``-internal
    transitions that watcher deliberately ignores — commits, staging, branch
    switches, merges/rebases/resets. Emits ``{"changed": true}`` pings; the client
    responds by re-querying ``/git/diff``. Closes when the client disconnects.
    """
    async with async_session_factory() as session:
        ws_row = await session.get(Workspace, workspace_id)
    root = Path(ws_row.path).resolve() if ws_row and ws_row.path else None
    if root is None or not root.is_dir():
        # Reject the handshake (no accept) so the client backs off instead of
        # hammering us with reconnects.
        with contextlib.suppress(Exception):
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        return

    try:
        await websocket.accept()
    except (WebSocketDisconnect, RuntimeError):
        # Client dropped during the handshake (page nav / HMR reload). Bail.
        return

    stop = asyncio.Event()

    async def pump() -> None:
        async for changes in awatch(
            root,
            watch_filter=lambda _change, path: _is_git_state_change(path),
            stop_event=stop,
        ):
            if changes:
                with contextlib.suppress(Exception):
                    await websocket.send_json({"changed": True})

    pump_task = asyncio.create_task(pump())
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        stop.set()
        pump_task.cancel()
