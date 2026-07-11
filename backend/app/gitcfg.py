"""Lursor-owned git configuration (isolated from the user's real git setup).

Rather than writing the GitHub token into ``~/.gitconfig`` / ``~/.git-credentials``
(which would clobber the user's own identity and credentials on a personal
machine), Lursor keeps its git config under ``~/.lursor/git/`` and points git at
it via the ``GIT_CONFIG_GLOBAL`` environment variable — for the clone/push/pull
endpoints and for the terminal panel's shell.

The managed config ``[include]``s the user's real ``~/.gitconfig`` as a base, so
their aliases and identity still apply; Lursor only layers on a github.com
credential helper (and an optional identity when the user supplies one).

``GIT_CONFIG_GLOBAL`` requires Git ≥ 2.32 (2021).
"""

from __future__ import annotations

import contextlib
import os
from pathlib import Path

GITHUB_HOST = "github.com"

_GIT_DIR = Path.home() / ".lursor" / "git"
_CONFIG_PATH = _GIT_DIR / "config"
_CREDENTIALS_PATH = _GIT_DIR / "credentials"


def config_env() -> dict[str, str]:
    """Env overrides that make git use Lursor's config, or ``{}`` if unset.

    Returned as a dict so callers can merge it into ``os.environ`` for the
    processes they spawn. When no config exists (never connected / disconnected)
    this is empty, so git falls back to the user's own ``~/.gitconfig`` untouched.
    """
    if _CONFIG_PATH.exists():
        return {"GIT_CONFIG_GLOBAL": str(_CONFIG_PATH)}
    return {}


def write(token: str, login: str | None, name: str | None, email: str | None) -> None:
    """Write the Lursor git config + credential store for a connected account."""
    _GIT_DIR.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        os.chmod(_GIT_DIR, 0o700)

    cred_line = f"https://{login or 'x-access-token'}:{token}@{GITHUB_HOST}"
    _CREDENTIALS_PATH.write_text(cred_line + "\n", encoding="utf-8")
    with contextlib.suppress(OSError):
        os.chmod(_CREDENTIALS_PATH, 0o600)

    _CONFIG_PATH.write_text(_render(name, email), encoding="utf-8")
    with contextlib.suppress(OSError):
        os.chmod(_CONFIG_PATH, 0o600)


def clear() -> None:
    """Remove Lursor's git config + credentials (revert to the user's own git)."""
    for path in (_CREDENTIALS_PATH, _CONFIG_PATH):
        with contextlib.suppress(OSError):
            path.unlink()


def _render(name: str | None, email: str | None) -> str:
    """Build the managed git config file body."""
    lines = [
        "# Managed by Lursor — do not edit.",
        "# GIT_CONFIG_GLOBAL points git here so GitHub auth works without",
        "# touching your real ~/.gitconfig (included below as the base).",
    ]

    real_gitconfig = Path.home() / ".gitconfig"
    if real_gitconfig.exists():
        lines += ["[include]", f"\tpath = {real_gitconfig}"]

    # Scope the credential store to github.com. The empty ``helper =`` first
    # clears any helpers inherited from the included config, so Lursor's token
    # is the one git uses for GitHub.
    lines += [
        '[credential "https://github.com"]',
        "\thelper =",
        f"\thelper = store --file={_CREDENTIALS_PATH}",
    ]

    # Identity is placed after the include so a user-supplied name/email wins;
    # when omitted, the included ~/.gitconfig identity applies unchanged.
    identity = []
    if name:
        identity.append(f"\tname = {name}")
    if email:
        identity.append(f"\temail = {email}")
    if identity:
        lines.append("[user]")
        lines += identity

    return "\n".join(lines) + "\n"
