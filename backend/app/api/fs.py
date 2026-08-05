"""Directory browsing on the backend host.

This exists for one case: choosing a workspace folder when the backend is not on
your machine. ``POST /workspaces/pick-folder`` shells out to ``osascript`` or
``zenity`` to show a real OS dialog, which is the right answer when the backend
runs on your laptop and no answer at all on a headless VPS — there is no display
to draw it on, and the process the dialog would belong to is a systemd service.

So the client asks ``GET /api/server-info`` whether a native picker exists and, if
not, walks the remote filesystem through here instead.

Deliberately *not* confined to a root. Workspaces are arbitrary directories on the
host by design — that is the whole model — and the token holder already has a PTY
there (``/api/terminal/ws``), so a directory listing grants nothing new. It is
read-only and lists names only: no file contents, no sizes, no traversal into
files. Reading file bytes stays where it already is, scoped to a workspace, in
``api/files.py``.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

router = APIRouter(prefix="/fs", tags=["fs"])

# A directory with tens of thousands of entries (``node_modules``, a dataset dump)
# would produce a response no picker can usefully render and a scan that stalls the
# threadpool. Cap it and say so, rather than truncating in silence.
_MAX_ENTRIES = 2000


class DirEntry(BaseModel):
    name: str
    path: str
    # Flagged so the picker can mark repositories, which is what you are almost
    # always looking for when choosing a workspace.
    is_repo: bool


class DirListing(BaseModel):
    """One directory, resolved, plus the two places every picker needs to offer."""

    path: str
    # ``None`` at the filesystem root, which is what stops the "up" control there.
    parent: str | None
    home: str
    entries: list[DirEntry]
    # True when the listing was capped; the client says so instead of implying the
    # directory is smaller than it is.
    truncated: bool


@router.get("/dirs", response_model=DirListing)
def list_dirs(path: str = "", show_hidden: bool = False) -> DirListing:
    """List the subdirectories of ``path`` (defaults to the backend user's home).

    A sync route on purpose: ``scandir`` on a cold or network-mounted directory
    blocks, and FastAPI runs sync routes in a threadpool, so the event loop — and
    every agent streaming through it — stays free.
    """
    home = Path.home()
    target = Path(path).expanduser() if path.strip() else home

    try:
        # ``resolve`` also collapses the ``..`` a client may have built by hand, so
        # the path echoed back is the one that was actually listed.
        target = target.resolve()
    except OSError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Could not resolve path: {exc}"
        ) from exc

    if not target.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No such directory: {target}")
    if not target.is_dir():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Not a directory: {target}")

    entries: list[DirEntry] = []
    truncated = False
    try:
        with os.scandir(target) as it:
            for entry in it:
                if len(entries) >= _MAX_ENTRIES:
                    truncated = True
                    break
                if not show_hidden and entry.name.startswith("."):
                    continue
                try:
                    # ``follow_symlinks`` default means a symlinked directory is
                    # offered like any other, which is what a user expects of a
                    # link they made themselves.
                    if not entry.is_dir():
                        continue
                except OSError:
                    # A broken link or a mount that went away mid-scan: skip it
                    # rather than failing the whole listing.
                    continue
                child = Path(entry.path)
                entries.append(
                    DirEntry(
                        name=entry.name,
                        path=str(child),
                        is_repo=(child / ".git").exists(),
                    )
                )
    except PermissionError as exc:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, f"Permission denied: {target}"
        ) from exc
    except OSError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Could not read directory: {exc}"
        ) from exc

    entries.sort(key=lambda e: e.name.lower())

    parent = target.parent
    return DirListing(
        path=str(target),
        parent=None if parent == target else str(parent),
        home=str(home),
        entries=entries,
        truncated=truncated,
    )
