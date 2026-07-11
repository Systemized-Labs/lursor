"""Workspace file access: browse, read, write, and watch for live changes.

The workspace directory is the agent's filesystem root, so these endpoints power
a lightweight in-app editor: a lazily-loaded file tree, read/write of individual
files, and a WebSocket that streams filesystem changes as the agent (or anyone
else) touches the directory — so edits made by a running agent surface live in
the open editor.

Every path is confined to the workspace root: a client-supplied relative path is
joined onto the root and rejected if it escapes (``..`` traversal, absolute
paths, symlinks pointing outside). POSIX and Windows alike, resolution is done
with :meth:`Path.resolve` and an ``is_relative_to`` guard.
"""

from __future__ import annotations

import asyncio
import contextlib
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, WebSocket, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocketDisconnect
from watchfiles import Change, awatch

from app.db.models import Workspace
from app.db.session import async_session_factory, get_session

router = APIRouter(prefix="/workspaces/{workspace_id}/files", tags=["files"])

# Directories that are noisy, huge, or machine-generated — hidden from the tree
# and (via watchfiles' DefaultFilter, which already skips most of these) the
# watcher. Keeps the explorer focused on source the user actually edits.
_IGNORED_DIRS = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
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
        ".DS_Store",
    }
)

# Files larger than this are not returned inline (the editor shows a notice).
_MAX_READ_BYTES = 2 * 1024 * 1024


class DirEntry(BaseModel):
    name: str
    path: str  # POSIX-style path relative to the workspace root
    is_dir: bool


class FileContent(BaseModel):
    path: str
    content: str
    is_binary: bool
    size: int
    truncated: bool


class WriteFileRequest(BaseModel):
    path: str
    content: str


class WriteFileResponse(BaseModel):
    path: str
    size: int


class CreateEntryRequest(BaseModel):
    path: str
    is_dir: bool = False


class RenameRequest(BaseModel):
    path: str
    new_path: str


def _ensure_dir(path: str | None) -> Path | None:
    """Resolve a workspace path, (re)creating the directory if it's gone.

    The directory belongs to the workspace and is expected to exist; if it was
    never created or has since been removed, recreate it (non-destructive, and
    consistent with how the workspace dir is materialized on creation). Returns
    ``None`` only when the workspace has no path configured at all.
    """
    if not path:
        return None
    root = Path(path)
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    return root.resolve()


async def _workspace_root(workspace_id: str, session: AsyncSession) -> Path:
    """Resolve a workspace's on-disk root, creating it if missing."""
    ws = await session.get(Workspace, workspace_id)
    if ws is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    root = _ensure_dir(ws.path)
    if root is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Workspace has no accessible directory"
        )
    return root


def _safe_join(root: Path, rel: str) -> Path:
    """Join ``rel`` onto ``root``, rejecting anything that escapes the root.

    Guards against ``..`` traversal, absolute paths, and symlinks that resolve
    outside the workspace.
    """
    target = (root / rel).resolve()
    if target != root and not target.is_relative_to(root):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Path escapes workspace root")
    return target


def _rel(root: Path, path: Path) -> str:
    """POSIX-style path of ``path`` relative to ``root`` ("" for the root)."""
    return path.relative_to(root).as_posix() if path != root else ""


@router.get("/list", response_model=list[DirEntry])
async def list_directory(
    workspace_id: str,
    path: str = "",
    session: AsyncSession = Depends(get_session),
) -> list[DirEntry]:
    """List the immediate children of a directory (lazy tree loading).

    Directories sort before files; both alphabetically, case-insensitively.
    Ignored/noise directories are omitted.
    """
    root = await _workspace_root(workspace_id, session)
    target = _safe_join(root, path)
    if not target.is_dir():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Directory not found")

    entries: list[DirEntry] = []
    with contextlib.suppress(OSError):
        for child in target.iterdir():
            if child.name in _IGNORED_DIRS:
                continue
            is_dir = child.is_dir()
            entries.append(
                DirEntry(name=child.name, path=_rel(root, child), is_dir=is_dir)
            )

    entries.sort(key=lambda e: (not e.is_dir, e.name.lower()))
    return entries


@router.get("/read", response_model=FileContent)
async def read_file(
    workspace_id: str,
    path: str,
    session: AsyncSession = Depends(get_session),
) -> FileContent:
    """Return a file's text content (or a binary/oversize marker)."""
    root = await _workspace_root(workspace_id, session)
    target = _safe_join(root, path)
    if not target.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")

    size = target.stat().st_size
    if size > _MAX_READ_BYTES:
        return FileContent(
            path=path, content="", is_binary=False, size=size, truncated=True
        )

    raw = target.read_bytes()
    if b"\x00" in raw:
        return FileContent(
            path=path, content="", is_binary=True, size=size, truncated=False
        )
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return FileContent(
            path=path, content="", is_binary=True, size=size, truncated=False
        )
    return FileContent(
        path=path, content=text, is_binary=False, size=size, truncated=False
    )


@router.put("/write", response_model=WriteFileResponse)
async def write_file(
    workspace_id: str,
    payload: WriteFileRequest,
    session: AsyncSession = Depends(get_session),
) -> WriteFileResponse:
    """Write UTF-8 text to a file, creating parent directories as needed."""
    root = await _workspace_root(workspace_id, session)
    target = _safe_join(root, payload.path)
    if target == root or target.is_dir():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Not a writable file path")

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(payload.content, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, f"Could not write file: {exc}"
        ) from exc

    return WriteFileResponse(path=payload.path, size=target.stat().st_size)


@router.post("/create", response_model=DirEntry, status_code=status.HTTP_201_CREATED)
async def create_entry(
    workspace_id: str,
    payload: CreateEntryRequest,
    session: AsyncSession = Depends(get_session),
) -> DirEntry:
    """Create an empty file or a directory, with parents as needed.

    Fails if the target already exists so an accidental create can't silently
    clobber an existing file or merge into a directory.
    """
    root = await _workspace_root(workspace_id, session)
    target = _safe_join(root, payload.path)
    if target == root:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid path")
    if target.exists():
        raise HTTPException(status.HTTP_409_CONFLICT, "A file or folder already exists")

    try:
        if payload.is_dir:
            target.mkdir(parents=True, exist_ok=False)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch(exist_ok=False)
    except OSError as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, f"Could not create: {exc}"
        ) from exc

    return DirEntry(name=target.name, path=_rel(root, target), is_dir=payload.is_dir)


@router.post("/rename", response_model=DirEntry)
async def rename_entry(
    workspace_id: str,
    payload: RenameRequest,
    session: AsyncSession = Depends(get_session),
) -> DirEntry:
    """Rename or move a file/directory to ``new_path`` (both workspace-relative)."""
    root = await _workspace_root(workspace_id, session)
    src = _safe_join(root, payload.path)
    dst = _safe_join(root, payload.new_path)
    if src == root or dst == root:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid path")
    if not src.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    if dst.exists():
        raise HTTPException(status.HTTP_409_CONFLICT, "A file or folder already exists")

    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
    except OSError as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, f"Could not rename: {exc}"
        ) from exc

    return DirEntry(name=dst.name, path=_rel(root, dst), is_dir=dst.is_dir())


@router.delete("/delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entry(
    workspace_id: str,
    path: str,
    session: AsyncSession = Depends(get_session),
) -> None:
    """Delete a file, or a directory and everything under it."""
    root = await _workspace_root(workspace_id, session)
    target = _safe_join(root, path)
    if target == root:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot delete workspace root")
    if not target.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")

    try:
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
    except OSError as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, f"Could not delete: {exc}"
        ) from exc


# watchfiles.Change → the string kind the client understands.
_CHANGE_KIND = {
    Change.added: "added",
    Change.modified: "modified",
    Change.deleted: "deleted",
}


@router.websocket("/watch")
async def watch_files(websocket: WebSocket, workspace_id: str) -> None:
    """Stream filesystem changes under the workspace root to the client.

    Emits JSON batches ``{"changes": [{"type": "...", "path": "..."}]}`` where
    ``path`` is workspace-relative. Powers live refresh of the tree and reload of
    open files while an agent edits the directory. Closes when the client
    disconnects (a background receive loop trips ``stop``).
    """
    async with async_session_factory() as session:
        ws_row = await session.get(Workspace, workspace_id)
    root = _ensure_dir(ws_row.path) if ws_row else None
    if root is None:
        # Reject the handshake (no accept) so the client sees a permanent failure
        # and backs off instead of hammering us with reconnects.
        await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        return

    await websocket.accept()

    stop = asyncio.Event()

    async def pump() -> None:
        async for changes in awatch(root, stop_event=stop):
            batch = []
            for change, raw_path in changes:
                with contextlib.suppress(ValueError):
                    rel = Path(raw_path).resolve().relative_to(root).as_posix()
                    batch.append({"type": _CHANGE_KIND[change], "path": rel})
            if batch:
                with contextlib.suppress(Exception):
                    await websocket.send_json({"changes": batch})

    pump_task = asyncio.create_task(pump())
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        stop.set()
        pump_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await pump_task
