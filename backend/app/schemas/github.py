from __future__ import annotations

from pydantic import BaseModel

from app.db.models import GitHubConfig
from app.schemas._types import UTCDatetime


class GitHubConfigInput(BaseModel):
    """Payload for connecting (or re-connecting) a GitHub account."""

    token: str
    # Git identity for commits. When omitted, the name resolved from the token
    # is used for ``user.name`` and email is left untouched.
    name: str | None = None
    email: str | None = None


class GitHubConfigRead(BaseModel):
    """Connection status. The raw token is never returned — only a hint."""

    connected: bool
    login: str | None = None
    name: str | None = None
    email: str | None = None
    avatar_url: str | None = None
    token_hint: str | None = None  # last 4 chars, e.g. "…a1b2"
    updated_at: UTCDatetime | None = None

    @classmethod
    def disconnected(cls) -> GitHubConfigRead:
        return cls(connected=False)

    @classmethod
    def from_config(cls, cfg: GitHubConfig) -> GitHubConfigRead:
        token = cfg.token or ""
        return cls(
            connected=bool(token),
            login=cfg.login,
            name=cfg.name,
            email=cfg.email,
            avatar_url=cfg.avatar_url,
            token_hint=f"…{token[-4:]}" if len(token) >= 4 else None,
            updated_at=cfg.updated_at,
        )


class GitHubRepo(BaseModel):
    """A repository the connected account can access."""

    full_name: str  # "owner/name"
    name: str
    description: str | None = None
    private: bool = False
    clone_url: str
    default_branch: str = "main"
    updated_at: UTCDatetime | None = None


class GitHubCloneInput(BaseModel):
    """Clone a repository into a freshly created workspace.

    Provide either ``repo_full_name`` (``owner/name``) or an explicit
    ``clone_url``. ``name`` overrides the workspace name (defaults to the repo
    name); ``path`` overrides where it lands on disk.
    """

    repo_full_name: str | None = None
    clone_url: str | None = None
    name: str | None = None
    path: str | None = None


class GitHubCloneIntoInput(BaseModel):
    """Clone a repository into an existing workspace's directory.

    The repo lands in a subfolder of the workspace, named after the repo (or
    ``folder`` when provided). Provide either ``repo_full_name`` (``owner/name``)
    or an explicit ``clone_url``.
    """

    repo_full_name: str | None = None
    clone_url: str | None = None
    folder: str | None = None


class GitHubCloneIntoResult(BaseModel):
    """Result of cloning a repository into an existing workspace."""

    workspace_id: str
    path: str  # absolute path of the cloned subfolder
    folder: str  # subfolder name relative to the workspace directory
