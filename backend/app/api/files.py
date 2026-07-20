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
import mimetypes
import os
import shutil
from pathlib import Path

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
    WebSocket,
    status,
)
from fastapi.responses import FileResponse
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
        # Lursor's own per-workspace config lives here (workspace-scoped skills
        # under .agents/skills). It's managed from the Skills page, not the file
        # explorer, so keep it out of the tree and @files search. The one
        # exception is the plan folder — see ``_tree_hidden``.
        ".agents",
    }
)

# Within the otherwise-hidden ``.agents`` folder, plans are meant to be read and
# revisited, so we expose ``.agents/plan/`` (and its contents) in the file tree.
_PLAN_SUBDIR = ".agents/plan"


def _tree_hidden(rel: str, name: str) -> bool:
    """Whether a child should be omitted from the file tree.

    ``.agents`` is normally hidden (workspace-scoped agent config), but we let the
    ``.agents`` container and its ``plan/`` subtree through so users can browse and
    reopen past plans. Everything else under ``.agents`` (e.g. ``skills``) stays
    hidden and is managed from its own page. All other noise dirs are hidden by
    name as before.
    """
    if rel == ".agents" or rel == _PLAN_SUBDIR or rel.startswith(f"{_PLAN_SUBDIR}/"):
        return False
    if rel.startswith(".agents/"):
        return True
    return name in _IGNORED_DIRS

# Files larger than this are not returned inline (the editor shows a notice).
_MAX_READ_BYTES = 2 * 1024 * 1024

# Upper bound on files visited during a fuzzy search, so the recursive walk
# stays cheap even on a large workspace. Beyond this we stop scanning and rank
# what we've seen.
_MAX_SEARCH_SCAN = 20_000


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
            rel = _rel(root, child)
            if _tree_hidden(rel, child.name):
                continue
            is_dir = child.is_dir()
            entries.append(DirEntry(name=child.name, path=rel, is_dir=is_dir))

    entries.sort(key=lambda e: (not e.is_dir, e.name.lower()))
    return entries


def _fuzzy_score(query: str, text: str) -> int | None:
    """Subsequence-match ``query`` against ``text`` (case-insensitive).

    Returns a relevance score (higher is better), or ``None`` when the query's
    characters don't all appear in order. Consecutive hits and hits at path/word
    boundaries (after ``/._- ``) score higher, so ``chatcomp`` ranks
    ``ChatComposer.tsx`` above an incidental scattered match.
    """
    if not query:
        return 0
    text_l = text.lower()
    score = 0
    cursor = 0
    prev = -2
    for ch in query.lower():
        idx = text_l.find(ch, cursor)
        if idx == -1:
            return None
        score += 1
        if idx == prev + 1:
            score += 5  # consecutive with the previous matched char
        if idx == 0 or text_l[idx - 1] in "/._- ":
            score += 3  # start of a path segment or word
        prev = idx
        cursor = idx + 1
    return score


@router.get("/search", response_model=list[DirEntry])
async def search_files(
    workspace_id: str,
    q: str = "",
    limit: int = 50,
    session: AsyncSession = Depends(get_session),
) -> list[DirEntry]:
    """Fuzzy-search files and directories anywhere under the workspace root.

    ``q`` is matched as a subsequence against each entry's workspace-relative
    path; results are ranked best-first and capped at ``limit``. An empty ``q``
    returns the first entries encountered (a default listing). Ignored/noise
    directories are pruned from the walk. Directories are included so they can be
    ``@``-referenced in chat alongside files.
    """
    root = await _workspace_root(workspace_id, session)
    limit = max(1, min(limit, 200))
    query = q.strip()

    # (score, path-length, name, path, is_dir) — path-length and name break score
    # ties so shorter, alphabetically-earlier paths win.
    scored: list[tuple[int, int, str, str, bool]] = []
    scanned = 0

    def _consider(name: str, rel: str, is_dir: bool) -> None:
        if query:
            # Prefer a basename hit, but fall back to the full relative path
            # so "src/comp" style queries still match.
            score = _fuzzy_score(query, name)
            path_score = _fuzzy_score(query, rel)
            if score is None and path_score is None:
                return
            best = max(s for s in (score, path_score) if s is not None)
            if score is not None:
                best += 4  # nudge basename matches above path-only matches
        else:
            best = 0
        scored.append((-best, len(rel), name.lower(), rel, is_dir))

    for dirpath, dirnames, filenames in os.walk(root):
        # Prune ignored dirs in place so os.walk never descends into them.
        dirnames[:] = [d for d in dirnames if d not in _IGNORED_DIRS]
        for name in dirnames:
            scanned += 1
            _consider(name, _rel(root, Path(dirpath) / name), True)
        for name in filenames:
            if name in _IGNORED_DIRS:
                continue
            scanned += 1
            _consider(name, _rel(root, Path(dirpath) / name), False)
        if scanned >= _MAX_SEARCH_SCAN:
            break

    scored.sort()
    return [
        DirEntry(name=Path(rel).name, path=rel, is_dir=is_dir)
        for _, _, _, rel, is_dir in scored[:limit]
    ]


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


@router.get("/raw")
async def read_raw(
    workspace_id: str,
    path: str,
    session: AsyncSession = Depends(get_session),
) -> FileResponse:
    """Serve a file's raw bytes with a guessed content type.

    Used for inline previews the JSON ``/read`` endpoint can't carry — chiefly
    images, which ``/read`` reports as binary. Path safety is identical to
    ``/read``: the client-supplied path is confined to the workspace root.
    """
    root = await _workspace_root(workspace_id, session)
    target = _safe_join(root, path)
    if not target.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    media_type, _ = mimetypes.guess_type(target.name)
    return FileResponse(target, media_type=media_type or "application/octet-stream")


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


@router.post("/upload", response_model=list[DirEntry], status_code=status.HTTP_201_CREATED)
async def upload_files(
    workspace_id: str,
    files: list[UploadFile] = File(...),
    path: str = Form(""),
    session: AsyncSession = Depends(get_session),
) -> list[DirEntry]:
    """Upload one or more files into a workspace folder.

    ``path`` is the workspace-relative destination directory ("" for the root).
    Each file's raw bytes are written verbatim, so binary uploads (images,
    archives, …) round-trip intact. A filename may carry its own relative
    subpath (as browsers send for a folder upload), and intermediate directories
    are created as needed. Every resolved target is confined to the workspace
    root; anything escaping it is rejected.
    """
    root = await _workspace_root(workspace_id, session)
    dest = _safe_join(root, path)
    if dest.exists() and not dest.is_dir():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Destination is not a folder")

    created: list[DirEntry] = []
    for upload in files:
        # Browsers send folder uploads with the relative path in the filename;
        # normalize separators and drop leading slashes so it stays relative.
        rel_name = (upload.filename or "").replace("\\", "/").strip().lstrip("/")
        if not rel_name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "File is missing a name")

        target = _safe_join(dest, rel_name)
        if target == root or target.is_dir():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Not a writable file path")

        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(await upload.read())
        except OSError as exc:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR, f"Could not save file: {exc}"
            ) from exc

        created.append(DirEntry(name=target.name, path=_rel(root, target), is_dir=False))

    return created


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
        with contextlib.suppress(Exception):
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        return

    try:
        await websocket.accept()
    except (WebSocketDisconnect, RuntimeError):
        # The client dropped the socket during the handshake — common on page
        # navigation / HMR reload. Nothing to accept; bail quietly.
        return

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
    except (WebSocketDisconnect, RuntimeError):
        # Normal teardown when the client goes away (RuntimeError can surface
        # from receive() after an abrupt disconnect).
        pass
    finally:
        stop.set()
        pump_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await pump_task
