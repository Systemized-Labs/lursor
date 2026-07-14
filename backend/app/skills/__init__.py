"""Filesystem-backed skill storage.

Skills follow the Anthropic skill standard: each skill is a folder containing a
``SKILL.md`` (YAML frontmatter + markdown body), plus optional bundled resource
files and ``scripts/``. This package owns all on-disk access; the ``skills`` DB
table is a rebuildable index over it (see ``app/api/skills.py``).
"""

from app.skills import store

__all__ = ["store"]
