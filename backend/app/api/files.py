"""Workspace file access: browse, read, write, and watch for live changes.

The workspace directory is the agent's filesystem root, so these endpoints power
a lightweight in-app editor: a lazily-loaded file tree, read/write of individual
files, fuzzy search over filenames (``/search``) and over file *contents*
(``/grep``), and a WebSocket that streams filesystem changes as the agent (or
anyone else) touches the directory — so edits made by a running agent surface
live in the open editor.

Every path is confined to the workspace root: a client-supplied relative path is
joined onto the root and rejected if it escapes (``..`` traversal, absolute
paths, symlinks pointing outside). POSIX and Windows alike, the check is an
``is_relative_to`` guard applied twice — lexically, then against
:meth:`Path.resolve` — with exactly one admitted escape, a linked skill folder in
the skills catalog (see :func:`_follows_catalog_link`).
"""

from __future__ import annotations

import asyncio
import contextlib
import fnmatch
import json
import mimetypes
import os
import re
import shutil
from pathlib import Path, PurePosixPath

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
from app.skills import store as skill_store
from app.workspace_paths import is_skills_catalog

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


# What a skill that really lives in the catalog is called, next to the ``~/.claude``
# and ``~/.hermes`` of the links around it.
OWN_SOURCE_LABEL = "Lursor"


def _source_of(child: Path) -> tuple[str, str]:
    """``(link target, short label)`` for a directory entry, or ``("", "")``.

    The label names the *tool* rather than the directory: a link to
    ``~/.claude/skills/pdf`` reads "~/.claude", not "~/.claude/skills", because that
    is the distinction a person is making when they scan the tree. That is one
    segment above the containing root, which is exactly what ``root_label`` returns
    when handed the root — so the badge here and the badge on the Skills page are
    produced by the same function.
    """
    if not child.is_symlink():
        return "", ""
    try:
        target = child.resolve()
    except OSError:
        return "", ""
    return str(target), skill_store.root_label(str(target.parent)) or str(target.parent)


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

# Hard ceiling on matches a content search will return, whatever ``limit`` asks
# for. The client shows the count and says when it truncated, so a bigger number
# would only cost transfer for a list nobody scrolls.
_MAX_GREP_MATCHES = 1_000

# Matches taken from any one file, so a single minified bundle can't spend the
# whole budget on one line.
_MAX_GREP_MATCHES_PER_FILE = 20

# Longest line returned verbatim. Past this the match is returned inside a window
# of the line (see :func:`_window_line`) — a minified file otherwise sends a
# hundred kilobytes to render one row.
_MAX_GREP_LINE_CHARS = 400


class DirEntry(BaseModel):
    name: str
    path: str  # POSIX-style path relative to the workspace root
    is_dir: bool
    # Where a symlinked entry actually points (absolute), empty for a real file or
    # folder. The tree needs this because a linked skill is indistinguishable from a
    # real one otherwise, and which tool owns it decides what editing it affects.
    link_target: str = ""
    # Short, human form of the above for a badge: "~/.claude", "~/.hermes". Set for
    # any symlink, and additionally for a *real* top-level entry of the skills
    # catalog, which gets :data:`OWN_SOURCE_LABEL` — with most of that directory
    # being links into other tools, "no badge" is a worse answer than saying whose
    # it is. Computed server-side, and with the same helper the skills API uses, so
    # the two surfaces can't disagree about what to call a directory.
    source_label: str = ""


class FileContent(BaseModel):
    path: str
    content: str
    is_binary: bool
    size: int
    truncated: bool


class GrepMatch(BaseModel):
    """One matching line, addressed well enough to open and select it."""

    path: str  # POSIX-style, relative to the workspace root
    line: int  # 1-based
    # 1-based column of the match in the *real* line, which is what the editor
    # jumps to — not an offset into ``text``.
    column: int
    # The matching line, windowed when it was long enough to be unrenderable.
    text: str
    match_length: int
    # Characters dropped off the front of the line to build ``text``. 0 for any
    # ordinary line; the client needs it to find ``column`` inside ``text``.
    text_offset: int = 0


class GrepResult(BaseModel):
    matches: list[GrepMatch]
    # Set when the search hit ``limit``, the per-file cap, or the scan ceiling —
    # so the client can say "first 200 of more" instead of implying completeness.
    truncated: bool
    # Files the search actually looked at. When it stopped early there is no such
    # number to report, so this falls back to the files it had seen matches in.
    files_scanned: int


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


def _follows_catalog_link(root: Path, rel: str, real: Path) -> bool:
    """Is this escape one of our own linked skill folders?

    The skills catalog is registered as a workspace so the file tree, chat and
    terminal all work over it, and an entry in it may be a symlink into another
    tool's directory (``POST /skills/{id}/link``) — the whole point being to edit
    the original rather than a copy. Such a path escapes the root by design, so it
    is admitted, but only on the two conditions that make it *ours*: the workspace
    is the catalog, and the escape goes through a symlink at the first segment,
    which in a directory only Lursor writes to is a link Lursor made.

    Everything else — a symlinked ``node_modules`` in a repo, a link inside a skill
    folder, a link one level down in the catalog — still fails the guard.
    """
    if not is_skills_catalog(root):
        return False
    first = PurePosixPath(rel.replace("\\", "/")).parts
    if not first:
        return False
    link = root / first[0]
    if not link.is_symlink():
        return False
    with contextlib.suppress(OSError):
        resolved = link.resolve()
        return real == resolved or real.is_relative_to(resolved)
    return False


def _safe_join(root: Path, rel: str) -> Path:
    """Join ``rel`` onto ``root``, rejecting anything that escapes the root.

    Guards against ``..`` traversal, absolute paths, and symlinks that resolve
    outside the workspace. The one admitted escape is a linked skill folder in the
    catalog; see :func:`_follows_catalog_link`.

    Returns the **logical** path — joined and lexically normalized, not resolved —
    so that a path which legitimately points outside the root stays expressible as
    something under it, which is what :func:`_rel` needs to name it back to the
    client. Filesystem calls follow the link on their own; nothing downstream wants
    the resolved form.
    """
    logical = Path(os.path.normpath(root / rel))
    # Lexical containment catches ``..`` and absolute paths before touching disk.
    if logical != root and not logical.is_relative_to(root):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Path escapes workspace root")
    real = logical.resolve()
    if real == root or real.is_relative_to(root):
        return logical
    if _follows_catalog_link(root, rel, real):
        return logical
    raise HTTPException(status.HTTP_400_BAD_REQUEST, "Path escapes workspace root")


def _rel(root: Path, path: Path) -> str:
    """POSIX-style path of ``path`` relative to ``root`` ("" for the root)."""
    return path.relative_to(root).as_posix() if path != root else ""


# Extensions ``mimetypes`` names in a form browsers don't accept for media
# playback. The stdlib table carries some genuinely old registrations —
# ``audio/mp4a-latm`` for ``.m4a``, and the ``x-`` experimental forms that were
# standardized years ago — and a ``<video>``/``<audio>`` element handed one of
# those may refuse the source outright rather than sniff past it. Everything not
# listed here is whatever ``guess_type`` says, as before.
_MEDIA_TYPE_OVERRIDES = {
    ".m4a": "audio/mp4",
    ".m4v": "video/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".weba": "audio/webm",
}


def _media_type(target: Path) -> str:
    """Content type to serve ``target`` as, for the two raw-bytes endpoints."""
    override = _MEDIA_TYPE_OVERRIDES.get(target.suffix.lower())
    if override:
        return override
    guessed, _ = mimetypes.guess_type(target.name)
    return guessed or "application/octet-stream"


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

    # Only the catalog's own top level names itself: deeper rows sit *inside* a
    # skill whose source the row above already gave, so repeating it is noise.
    own_label = OWN_SOURCE_LABEL if is_skills_catalog(root) else ""

    entries: list[DirEntry] = []
    with contextlib.suppress(OSError):
        for child in target.iterdir():
            rel = _rel(root, child)
            if _tree_hidden(rel, child.name):
                continue
            is_dir = child.is_dir()
            link, label = _source_of(child)
            entries.append(
                DirEntry(
                    name=child.name,
                    path=rel,
                    is_dir=is_dir,
                    link_target=link,
                    source_label=label or (own_label if "/" not in rel else ""),
                )
            )

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


# --- Content search -------------------------------------------------------------
#
# Two implementations of one endpoint. ``rg`` is used when the machine has it and
# a pure-Python walk when it doesn't: a packaged Electron build can't assume
# ripgrep is installed, so it has to stay an optimization and never a dependency.
#
# The two are kept deliberately close. ``rg`` is invoked with ``--no-ignore``
# (so a ``.gitignore`` can't change what a search finds from one machine to the
# next), ``--hidden`` (the walk doesn't skip dotfiles either) and an explicit
# exclude glob per :data:`_IGNORED_DIRS` entry — which leaves exactly the tree the
# walk covers. The ``include`` filter and every cap are applied in Python for both
# paths, so the same query answers the same way whichever ran it.


def _grep_pattern(q: str, regex: bool, case: bool, whole_word: bool) -> re.Pattern[str]:
    """Compile the needle, raising 422 on a regex the user mistyped."""
    body = q if regex else re.escape(q)
    if whole_word:
        body = rf"\b(?:{body})\b"
    try:
        return re.compile(body, 0 if case else re.IGNORECASE)
    except re.error as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"Invalid regular expression: {exc}"
        ) from exc


def _parse_includes(include: str) -> tuple[str, ...]:
    """Split the comma-separated include field into globs."""
    return tuple(p for p in (part.strip() for part in include.split(",")) if p)


def _include_matches(rel: str, patterns: tuple[str, ...]) -> bool:
    """Whether a workspace-relative path passes the include globs (any of them).

    A pattern carrying no ``/`` is about the *filename* (``*.ts``), so it is
    matched against the basename as well as the path — otherwise the most obvious
    thing anyone types would match nothing outside the root.
    """
    if not patterns:
        return True
    name = rel.rsplit("/", 1)[-1]
    for pattern in patterns:
        if fnmatch.fnmatch(rel, pattern):
            return True
        if "/" not in pattern and fnmatch.fnmatch(name, pattern):
            return True
    return False


def _window_line(line: str, start: int, length: int) -> tuple[str, int]:
    """``(text, dropped_prefix_chars)`` for a match at ``start`` in ``line``.

    Short lines come back whole. A long one is returned as a window that keeps
    some context in front of the match, because the interesting part of a minified
    line is the match and its neighbourhood, not its first 400 characters.
    """
    if len(line) <= _MAX_GREP_LINE_CHARS:
        return line, 0
    lead = 40
    begin = max(0, min(start - lead, len(line) - _MAX_GREP_LINE_CHARS))
    return line[begin : begin + max(_MAX_GREP_LINE_CHARS, length)], begin


def _matches_in_text(
    rel: str, text: str, pattern: re.Pattern[str], budget: int
) -> tuple[list[GrepMatch], bool]:
    """Every match in one file's text, capped by ``budget`` and the per-file cap.

    Returns ``(matches, more)`` where ``more`` says the file had matches we did
    not take.
    """
    cap = min(budget, _MAX_GREP_MATCHES_PER_FILE)
    found: list[GrepMatch] = []
    for number, line in enumerate(text.splitlines(), start=1):
        for hit in pattern.finditer(line):
            if len(found) >= cap:
                return found, True
            windowed, offset = _window_line(line, hit.start(), len(hit.group(0)))
            found.append(
                GrepMatch(
                    path=rel,
                    line=number,
                    column=hit.start() + 1,
                    text=windowed,
                    match_length=len(hit.group(0)),
                    text_offset=offset,
                )
            )
            # A zero-width match (an empty alternation, say) would otherwise spin
            # on one position forever; one hit per line is enough to find it.
            if not hit.group(0):
                break
    return found, False


def _grep_walk(
    root: Path, pattern: re.Pattern[str], includes: tuple[str, ...], limit: int
) -> GrepResult:
    """Search file contents with a plain recursive walk. Runs off the event loop.

    Skips what ``read_file`` skips — anything over :data:`_MAX_READ_BYTES`, and
    anything holding a NUL byte or not decodable as UTF-8 — so a binary can never
    produce a match.
    """
    matches: list[GrepMatch] = []
    scanned = 0
    truncated = False

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _IGNORED_DIRS]
        for name in filenames:
            if name in _IGNORED_DIRS:
                continue
            target = Path(dirpath) / name
            rel = _rel(root, target)
            if not _include_matches(rel, includes):
                continue
            scanned += 1
            try:
                if target.stat().st_size > _MAX_READ_BYTES:
                    continue
                raw = target.read_bytes()
            except OSError:
                continue
            if b"\x00" in raw:
                continue
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                continue
            found, more = _matches_in_text(rel, text, pattern, limit - len(matches))
            matches.extend(found)
            truncated = truncated or more
            if len(matches) >= limit:
                return GrepResult(matches=matches, truncated=True, files_scanned=scanned)
        if scanned >= _MAX_SEARCH_SCAN:
            return GrepResult(matches=matches, truncated=True, files_scanned=scanned)

    return GrepResult(matches=matches, truncated=truncated, files_scanned=scanned)


def _rg_argv(root: Path, q: str, regex: bool, case: bool, whole_word: bool) -> list[str]:
    """The ripgrep invocation matching what :func:`_grep_walk` would cover."""
    argv = [
        "rg",
        "--json",
        "--line-number",
        "--column",
        "--no-messages",
        # Ignore files are a per-checkout thing; letting them in would make the
        # same search answer differently on two machines.
        "--no-ignore",
        "--no-require-git",
        "--hidden",
        f"--max-count={_MAX_GREP_MATCHES_PER_FILE}",
        f"--max-filesize={_MAX_READ_BYTES}",
    ]
    for ignored in sorted(_IGNORED_DIRS):
        # No `/`, so this prunes a directory (or drops a file) of that name at any
        # depth — the same rule the walk applies.
        argv.append(f"--glob=!{ignored}")
    if not case:
        argv.append("--ignore-case")
    if whole_word:
        argv.append("--word-regexp")
    if not regex:
        argv.append("--fixed-strings")
    argv += [f"--regexp={q}", "--", str(root)]
    return argv


def _parse_rg_json(
    root: Path, stdout: bytes, includes: tuple[str, ...], limit: int
) -> GrepResult:
    """Turn ripgrep's JSON event stream into a :class:`GrepResult`."""
    matches: list[GrepMatch] = []
    per_file: dict[str, int] = {}
    seen_files: set[str] = set()
    reported_scanned: int | None = None
    truncated = False

    for raw_line in stdout.splitlines():
        if not raw_line:
            continue
        try:
            event = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        kind = event.get("type")
        if kind == "summary":
            stats = event.get("data", {}).get("stats", {})
            searched = stats.get("searches")
            if isinstance(searched, int):
                reported_scanned = searched
            continue
        if kind != "match":
            continue

        data = event.get("data", {})
        absolute = data.get("path", {}).get("text")
        line_text = data.get("lines", {}).get("text")
        number = data.get("line_number")
        if not absolute or line_text is None or not isinstance(number, int):
            # A non-UTF-8 path or line arrives base64-encoded under `bytes`; the
            # walk wouldn't have returned it either, so skip it.
            continue
        try:
            rel = _rel(root, Path(absolute))
        except ValueError:
            continue
        if not _include_matches(rel, includes):
            continue
        seen_files.add(rel)
        line = line_text.rstrip("\r\n")
        raw = line.encode("utf-8")

        for submatch in data.get("submatches", []):
            begin, end = submatch.get("start"), submatch.get("end")
            if not isinstance(begin, int) or not isinstance(end, int):
                continue
            if len(matches) >= limit:
                return GrepResult(
                    matches=matches,
                    truncated=True,
                    files_scanned=reported_scanned or len(seen_files),
                )
            if per_file.get(rel, 0) >= _MAX_GREP_MATCHES_PER_FILE:
                truncated = True
                break
            # ripgrep reports byte offsets into the line; Monaco counts
            # characters, so the prefix is decoded to find out how many there are.
            start_chars = len(raw[:begin].decode("utf-8", errors="replace"))
            match_chars = len(raw[begin:end].decode("utf-8", errors="replace"))
            windowed, offset = _window_line(line, start_chars, match_chars)
            matches.append(
                GrepMatch(
                    path=rel,
                    line=number,
                    column=start_chars + 1,
                    text=windowed,
                    match_length=match_chars,
                    text_offset=offset,
                )
            )
            per_file[rel] = per_file.get(rel, 0) + 1

    # `--max-count` stopping a file short is a truncation the client should say.
    if any(n >= _MAX_GREP_MATCHES_PER_FILE for n in per_file.values()):
        truncated = True
    return GrepResult(
        matches=matches,
        truncated=truncated,
        files_scanned=reported_scanned or len(seen_files),
    )


@router.get("/grep", response_model=GrepResult)
async def grep_workspace(
    workspace_id: str,
    q: str,
    regex: bool = False,
    case: bool = False,
    whole_word: bool = False,
    include: str = "",
    limit: int = 200,
    session: AsyncSession = Depends(get_session),
) -> GrepResult:
    """Search *file contents* under the workspace root.

    The counterpart to ``/search``, which only looks at filenames. ``q`` is a
    literal by default and a regular expression when ``regex`` is set (a bad
    pattern is a 422, not a 500); ``case`` makes it case-sensitive, ``whole_word``
    requires word boundaries, and ``include`` is a comma-separated list of globs
    the path must match.

    Read-only by design: replace-across-files is not offered here.
    """
    root = await _workspace_root(workspace_id, session)
    needle = q.strip()
    if not needle:
        return GrepResult(matches=[], truncated=False, files_scanned=0)

    # Compiled up front even on the ripgrep path, which never uses it: it is what
    # turns a mistyped pattern into a 422, and that answer shouldn't depend on
    # whether the machine happens to have ripgrep installed.
    pattern = _grep_pattern(needle, regex, case, whole_word)
    includes = _parse_includes(include)
    limit = max(1, min(limit, _MAX_GREP_MATCHES))

    if shutil.which("rg"):
        argv = _rg_argv(root, needle, regex, case, whole_word)
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await proc.communicate()
        # rg exits 1 for "no matches", which is not an error. Anything above that
        # is (a bad pattern it disagrees with us about, a permissions problem) —
        # fall through to the walk rather than reporting an empty workspace.
        if (proc.returncode or 0) <= 1:
            return _parse_rg_json(root, stdout, includes, limit)

    return await asyncio.to_thread(_grep_walk, root, pattern, includes, limit)


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

    Used for inline previews the JSON ``/read`` endpoint can't carry — images,
    video and audio, all of which ``/read`` reports as binary (and video, as
    oversize). :class:`FileResponse` honours ``Range``, so a video player seeks
    by fetching the byte window it needs rather than the whole file.

    Path safety is identical to ``/read``: the client-supplied path is confined
    to the workspace root.
    """
    root = await _workspace_root(workspace_id, session)
    target = _safe_join(root, path)
    if not target.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    return FileResponse(target, media_type=_media_type(target))


@router.get("/serve/{file_path:path}")
async def serve_file(
    workspace_id: str,
    file_path: str,
    session: AsyncSession = Depends(get_session),
) -> FileResponse:
    """Serve a file's raw bytes with its path *in the URL* rather than a query.

    Same bytes and content type as ``/raw``; the difference is the shape of the
    URL. An HTML page previewed in an iframe resolves its relative references
    against the URL it was loaded from, so ``?path=docs/report.html`` would send
    a sibling ``chart.png`` to ``files/chart.png`` and 404. Served at
    ``files/serve/docs/report.html`` the same reference lands on
    ``files/serve/docs/chart.png``, which is the file next to it. Root-relative
    (``/style.css``) references still can't resolve — they don't over ``file:``
    either.

    Path safety is identical to ``/read``: the path is confined to the workspace
    root.
    """
    root = await _workspace_root(workspace_id, session)
    target = _safe_join(root, file_path)
    if not target.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    return FileResponse(target, media_type=_media_type(target))


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
        # A symlink is removed as a link, never followed. ``rmtree`` refuses one
        # outright, and the case that matters is a linked skill folder in the
        # catalog, where following it would delete somebody else's real skill
        # instead of the pointer the user asked to remove.
        if target.is_symlink():
            target.unlink()
        elif target.is_dir():
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
