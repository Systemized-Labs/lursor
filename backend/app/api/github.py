"""GitHub integration — connect an account and clone/push/pull with a token.

The user pastes a personal access token; the backend validates it against the
GitHub API and, on success, stores it in a *Lursor-owned* git config under
``~/.lursor/git/`` (see :mod:`app.gitcfg`). Git is pointed at that config via
``GIT_CONFIG_GLOBAL`` for the clone endpoint here and for the terminal panel's
shell, so operations are authenticated without ever modifying the user's real
``~/.gitconfig`` / ``~/.git-credentials``.

This is a local, single-user app, so there is a single ``GitHubConfig`` row.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app import gitcfg
from app.config import get_settings
from app.db.models import GitHubConfig, Workspace
from app.db.session import get_session
from app.schemas.github import (
    GitHubCloneInput,
    GitHubConfigInput,
    GitHubConfigRead,
    GitHubRepo,
)
from app.schemas.workspace import WorkspaceRead
from app.workspace_paths import unique_workspace_dir

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/github", tags=["github"])
settings = get_settings()

GITHUB_API = "https://api.github.com"
_GITHUB_HOST = gitcfg.GITHUB_HOST


# --- GitHub REST helpers --------------------------------------------------------


def _headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


async def _validate_token(token: str) -> dict:
    """Return the authenticated user (``GET /user``) or raise a 400/502.

    A 401 means the token is wrong or expired; anything else non-2xx is an
    upstream problem we surface verbatim so the user can act on it.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{GITHUB_API}/user", headers=_headers(token))
    except httpx.RequestError as exc:
        logger.warning("github: /user unreachable: %s", exc)
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "Could not reach GitHub. Check your connection."
        ) from exc

    if resp.status_code == 401:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "GitHub rejected the token. Check that it is correct and not expired.",
        )
    if resp.status_code >= 400:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"GitHub returned HTTP {resp.status_code} while validating the token.",
        )
    return resp.json()


async def _fetch_repos(token: str) -> list[GitHubRepo]:
    """List repositories the token can access, most-recently-updated first."""
    repos: list[GitHubRepo] = []
    params = {
        "per_page": "100",
        "sort": "updated",
        "affiliation": "owner,collaborator,organization_member",
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            # Walk pages until GitHub returns a short (or empty) page. Cap at 5
            # pages (500 repos) so a huge account can't hang the request.
            for page in range(1, 6):
                resp = await client.get(
                    f"{GITHUB_API}/user/repos",
                    headers=_headers(token),
                    params={**params, "page": str(page)},
                )
                if resp.status_code == 401:
                    raise HTTPException(
                        status.HTTP_400_BAD_REQUEST,
                        "GitHub rejected the token. Reconnect your account.",
                    )
                if resp.status_code >= 400:
                    raise HTTPException(
                        status.HTTP_502_BAD_GATEWAY,
                        f"GitHub returned HTTP {resp.status_code} while listing repos.",
                    )
                batch = resp.json()
                for r in batch:
                    repos.append(
                        GitHubRepo(
                            full_name=r["full_name"],
                            name=r["name"],
                            description=r.get("description"),
                            private=bool(r.get("private")),
                            clone_url=r["clone_url"],
                            default_branch=r.get("default_branch") or "main",
                            updated_at=r.get("updated_at"),
                        )
                    )
                if len(batch) < 100:
                    break
    except httpx.RequestError as exc:
        logger.warning("github: /user/repos unreachable: %s", exc)
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "Could not reach GitHub. Check your connection."
        ) from exc
    return repos


# --- git configuration ----------------------------------------------------------


async def _run_git(*args: str, cwd: str | None = None) -> tuple[int, str, str]:
    """Run ``git <args>`` non-interactively; return ``(rc, stdout, stderr)``.

    ``GIT_TERMINAL_PROMPT=0`` guarantees git never blocks waiting on a username
    or password — a missing credential fails fast instead of hanging the server.
    """
    if shutil.which("git") is None:
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED,
            "git is not installed on the machine running the backend.",
        )
    # Merge in Lursor's isolated git config (GIT_CONFIG_GLOBAL) so clones
    # authenticate with the stored token, and never block on a prompt.
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", **gitcfg.config_env()}
    proc = await asyncio.create_subprocess_exec(
        "git", *args, cwd=cwd, env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


# --- persistence helpers --------------------------------------------------------


async def _get_config(session: AsyncSession) -> GitHubConfig | None:
    result = await session.execute(select(GitHubConfig))
    return result.scalars().first()


async def _require_config(session: AsyncSession) -> GitHubConfig:
    cfg = await _get_config(session)
    if cfg is None or not cfg.token:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "No GitHub account connected. Add a token first."
        )
    return cfg


# --- routes ---------------------------------------------------------------------


@router.get("/config", response_model=GitHubConfigRead)
async def get_config(session: AsyncSession = Depends(get_session)):
    cfg = await _get_config(session)
    return GitHubConfigRead.from_config(cfg) if cfg else GitHubConfigRead.disconnected()


@router.put("/config", response_model=GitHubConfigRead)
async def save_config(payload: GitHubConfigInput, session: AsyncSession = Depends(get_session)):
    token = payload.token.strip()
    if not token:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A token is required.")

    user = await _validate_token(token)
    login = user.get("login")
    name = (payload.name or "").strip() or user.get("name") or login
    email = (payload.email or "").strip() or None

    cfg = await _get_config(session)
    if cfg is None:
        cfg = GitHubConfig()
    cfg.token = token
    cfg.login = login
    cfg.name = name
    cfg.email = email
    cfg.avatar_url = user.get("avatar_url")

    if shutil.which("git") is None:
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED,
            "git is not installed on the machine running the backend.",
        )
    gitcfg.write(token, login, name, email)

    session.add(cfg)
    await session.commit()
    await session.refresh(cfg)
    return GitHubConfigRead.from_config(cfg)


@router.delete("/config", status_code=status.HTTP_204_NO_CONTENT)
async def disconnect(session: AsyncSession = Depends(get_session)):
    cfg = await _get_config(session)
    gitcfg.clear()
    if cfg is not None:
        await session.delete(cfg)
        await session.commit()


@router.get("/repos", response_model=list[GitHubRepo])
async def list_repos(session: AsyncSession = Depends(get_session)):
    cfg = await _require_config(session)
    return await _fetch_repos(cfg.token)


@router.post("/clone", response_model=WorkspaceRead, status_code=status.HTTP_201_CREATED)
async def clone_repo(payload: GitHubCloneInput, session: AsyncSession = Depends(get_session)):
    await _require_config(session)

    clone_url = (payload.clone_url or "").strip()
    full_name = (payload.repo_full_name or "").strip().strip("/")
    if not clone_url and full_name:
        clone_url = f"https://{_GITHUB_HOST}/{full_name}.git"
    if not clone_url:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Provide a repository (repo_full_name or clone_url)."
        )

    repo_name = _repo_name_from_url(full_name or clone_url)
    name = (payload.name or "").strip() or repo_name

    # Resolve the on-disk target. A custom path must be absent or empty (git
    # refuses to clone into a non-empty directory); the default is a fresh dir
    # named by a slug of the repo name under the workspaces root.
    ws = Workspace(name=name)
    if payload.path and payload.path.strip():
        target = Path(payload.path.strip()).expanduser()
        if not target.is_absolute():
            target = target.resolve()
        if target.exists() and any(target.iterdir()):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Target directory is not empty: {target}",
            )
    else:
        target = unique_workspace_dir(settings.workspaces_dir, name)

    target.parent.mkdir(parents=True, exist_ok=True)

    rc, _out, err = await _run_git("clone", clone_url, str(target))
    if rc != 0:
        # Scrub the token if git ever echoes a credentialed URL back to us.
        detail = _scrub(err) or "unknown error"
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"git clone failed: {detail}")

    ws.path = str(target)
    session.add(ws)
    await session.commit()
    return WorkspaceRead.from_workspace(ws)


def _repo_name_from_url(value: str) -> str:
    """Derive a bare repo name from ``owner/name``, a URL, or a git remote."""
    tail = value.rstrip("/").rsplit("/", 1)[-1]
    return re.sub(r"\.git$", "", tail) or "repo"


def _scrub(text: str) -> str:
    """Redact any ``user:token@`` credentials that leak into git's stderr."""
    return re.sub(r"https://[^@\s/]+:[^@\s/]+@", "https://", text).strip()
