"""Path handling shared by the tools that write files into a workspace.

Four helpers with no per-medium reasoning in them: resolve a model-supplied path
against the workspace root, name a file relative to it again, turn a prompt into a
filename stem, and drop a gitignore over a generated tree.

Extracted rather than copied because this is the *third* user, not the second —
``agents/video_tools.py`` and ``agents/image_tools.py`` both materialize generated
media, and ``agents/vision.py`` already resolves a path against the workspace its
own way. The repo's usual preference for parallel copies (see the ``_gateway``
copies in ``api/images.py`` and ``api/videos.py``) is for copies whose *reasons*
differ; these have no reasons of their own at all.

What stays per-medium: the directory constants, the filename scheme, and every
message the model reads. Those carry the medium's own argument and belong next to
the tools that make it.
"""

from __future__ import annotations

import re
from pathlib import Path


def resolve_in_workspace(root: Path, candidate: str) -> Path | str:
    """Resolve a tool-supplied path against the workspace, or return an error.

    Returns the error as a *string* rather than raising, because every caller is a
    tool body and an exception escaping one aborts the run: a bad path should cost
    one step, not the turn.
    """
    if not (candidate or "").strip():
        return "Error: a path is required."
    path = Path(candidate)
    resolved = path if path.is_absolute() else (root / path)
    try:
        resolved = resolved.resolve()
    except OSError as exc:
        return f"Error: could not resolve path {candidate!r}: {exc}"
    if not resolved.is_file():
        return f"Error: no such file: {candidate}"
    return resolved


def relative_to_workspace(root: Path, path: Path) -> str:
    """Name a file the way the agent refers to it, falling back to absolute."""
    try:
        return str(path.relative_to(root.resolve()))
    except ValueError:
        return str(path)


def slug(text: str) -> str:
    """A short filename-safe stem from a prompt or an id."""
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    return "-".join(words)[:40].strip("-")


def write_gitignore(directory: Path, comment: str) -> None:
    """Ignore a generated tree, on first use.

    A workspace is usually a git repo, and generated blobs would flood the git panel
    and the file-tree decorations. Deliverables the user asked to keep live wherever
    they named them, and are the only generated artifacts that should be committed.
    """
    marker = directory / ".gitignore"
    if not marker.exists():
        marker.write_text(f"# {comment}\n*\n")
