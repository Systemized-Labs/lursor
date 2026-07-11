"""Helpers for deriving friendly on-disk workspace directory names.

Workspaces used to be stored as ``<workspaces_dir>/<uuid-hex>`` which is opaque
in a terminal. Instead we slugify the workspace ``name`` and dedup on collision,
so a repo cloned as "swarmcore" lives at ``<workspaces_dir>/swarmcore``.
"""

from __future__ import annotations

import re
from pathlib import Path

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(name: str) -> str:
    """Turn a workspace name into a filesystem-friendly slug.

    Lowercases, collapses runs of non-alphanumerics into single hyphens, and
    trims leading/trailing hyphens. Falls back to ``"workspace"`` when the input
    has no usable characters (e.g. an all-emoji name).
    """
    slug = _SLUG_RE.sub("-", name.strip().lower()).strip("-")
    return slug or "workspace"


def unique_workspace_dir(root: Path, name: str) -> Path:
    """Return a not-yet-existing directory under ``root`` for ``name``.

    Uses the bare slug (``root/swarmcore``) when free, otherwise appends an
    incrementing suffix (``swarmcore-2``, ``swarmcore-3``, ...). The caller is
    responsible for creating the directory; because creation is immediate this
    is race-free for the local single-user app.
    """
    base = slugify(name)
    candidate = root / base
    counter = 2
    while candidate.exists():
        candidate = root / f"{base}-{counter}"
        counter += 1
    return candidate
