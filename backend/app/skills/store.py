"""On-disk skill storage following the Anthropic skill standard.

A skill lives in ``<skills_dir>/<slug>/`` and always contains a ``SKILL.md``
with YAML frontmatter (``name``, ``description``) and a markdown body. The folder
may also carry bundled **resource** files (``.md``/``.json``/``.yaml``/``.yml``/
``.csv``/``.xml``/``.txt`` at any depth) and **scripts** (``*.py`` in the folder
root or a ``scripts/`` subdirectory). These are exactly the files
``pydantic_deep``'s ``SkillsDirectory`` discovers at run time, so what the UI
shows here matches what the agent actually loads.

This module is filesystem-only — it never touches the database. The DB
``skills`` table is a rebuildable index reconciled against this store in
``app/api/skills.py``.
"""

from __future__ import annotations

import io
import re
import shutil
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from app.config import get_settings

# Kept in sync with pydantic_deep.features.skills.types.SKILL_RESOURCE_EXTENSIONS
# so listed resources match what the agent discovers at run time.
RESOURCE_EXTENSIONS: frozenset[str] = frozenset(
    {".md", ".json", ".yaml", ".yml", ".csv", ".xml", ".txt"}
)
SKILL_FILE = "SKILL.md"


@dataclass
class ParsedSkill:
    """The contents of one on-disk skill folder."""

    slug: str
    name: str
    description: str
    content: str
    resources: list[str] = field(default_factory=list)
    scripts: list[str] = field(default_factory=list)


def skills_root() -> Path:
    root = get_settings().skills_dir
    root.mkdir(parents=True, exist_ok=True)
    return root


def path_for(slug: str) -> Path:
    """Absolute path to a skill folder. ``slug`` is validated to stay under root."""
    root = skills_root()
    folder = (root / slug).resolve()
    if folder.parent != root.resolve():
        raise ValueError(f"Invalid skill slug: {slug!r}")
    return folder


def exists(slug: str) -> bool:
    return (path_for(slug) / SKILL_FILE).is_file()


def slugify(name: str, *, taken: set[str] | None = None) -> str:
    """Kebab-case a name into a folder-safe, standard-compliant slug.

    Matches ``pydantic_deep``'s name pattern ``^[a-z0-9]+(-[a-z0-9]+)*$``. When
    ``taken`` is supplied, a numeric suffix is appended to avoid collisions.
    """
    base = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    base = base or "skill"
    if taken is None:
        return base
    slug = base
    n = 2
    while slug in taken:
        slug = f"{base}-{n}"
        n += 1
    return slug


def list_slugs() -> list[str]:
    """Every folder directly under the skills root that holds a ``SKILL.md``."""
    root = skills_root()
    return sorted(
        p.name for p in root.iterdir() if p.is_dir() and (p / SKILL_FILE).is_file()
    )


def _split_frontmatter(text: str) -> tuple[dict, str]:
    """Return ``(frontmatter_dict, body)`` for a SKILL.md string."""
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.DOTALL)
    if not match:
        return {}, text.strip()
    try:
        data = yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    return data, match.group(2).strip()


def _discover_resources(folder: Path) -> list[str]:
    resolved = folder.resolve()
    out: list[str] = []
    for ext in RESOURCE_EXTENSIONS:
        for f in folder.rglob(f"*{ext}"):
            if f.name.upper() == SKILL_FILE.upper():
                continue
            try:
                f.resolve().relative_to(resolved)  # reject symlink escapes
            except ValueError:
                continue
            out.append(str(f.relative_to(folder)))
    return sorted(out)


def _discover_scripts(folder: Path) -> list[str]:
    resolved = folder.resolve()
    out: list[str] = []
    candidates = list(folder.glob("*.py"))
    scripts_dir = folder / "scripts"
    if scripts_dir.is_dir():
        candidates += list(scripts_dir.glob("*.py"))
    for f in candidates:
        if f.name == "__init__.py":
            continue
        try:
            f.resolve().relative_to(resolved)
        except ValueError:
            continue
        out.append(str(f.relative_to(folder)))
    return sorted(out)


def read_skill(slug: str) -> ParsedSkill | None:
    """Load a skill folder, or ``None`` if it has no ``SKILL.md``."""
    folder = path_for(slug)
    skill_md = folder / SKILL_FILE
    if not skill_md.is_file():
        return None
    frontmatter, body = _split_frontmatter(skill_md.read_text(encoding="utf-8"))
    return ParsedSkill(
        slug=slug,
        name=str(frontmatter.get("name") or slug),
        description=str(frontmatter.get("description") or ""),
        content=body,
        resources=_discover_resources(folder),
        scripts=_discover_scripts(folder),
    )


def write_skill(slug: str, *, name: str, description: str, content: str) -> None:
    """Create/overwrite ``<slug>/SKILL.md`` with standard frontmatter."""
    folder = path_for(slug)
    folder.mkdir(parents=True, exist_ok=True)
    frontmatter = yaml.safe_dump(
        {"name": name, "description": description},
        sort_keys=False,
        allow_unicode=True,
    ).strip()
    body = content.strip()
    doc = f"---\n{frontmatter}\n---\n\n{body}\n" if body else f"---\n{frontmatter}\n---\n"
    (folder / SKILL_FILE).write_text(doc, encoding="utf-8")


def delete_skill(slug: str) -> None:
    folder = path_for(slug)
    if folder.is_dir():
        shutil.rmtree(folder)


# --- Bundled resource / script files -------------------------------------------


def _resource_path(slug: str, rel: str) -> Path:
    """Resolve a file inside a skill folder, guarding against path traversal."""
    folder = path_for(slug).resolve()
    target = (folder / rel).resolve()
    try:
        target.relative_to(folder)
    except ValueError as exc:
        raise ValueError(f"Path escapes skill folder: {rel!r}") from exc
    if target == folder / SKILL_FILE:
        raise ValueError("SKILL.md is edited via the skill body, not as a resource")
    return target


def read_file(slug: str, rel: str) -> str:
    return _resource_path(slug, rel).read_text(encoding="utf-8")


def write_file(slug: str, rel: str, content: str) -> None:
    target = _resource_path(slug, rel)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def delete_file(slug: str, rel: str) -> None:
    target = _resource_path(slug, rel)
    if target.is_file():
        target.unlink()


# --- Import -------------------------------------------------------------------


def extract_zip(raw: bytes, dest: Path) -> None:
    """Extract a zip archive into ``dest``, rejecting path-traversal (zip-slip)."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise ValueError("Not a valid .zip archive") from exc
    dest_resolved = dest.resolve()
    for member in archive.namelist():
        target = (dest / member).resolve()
        try:
            target.relative_to(dest_resolved)
        except ValueError as exc:
            raise ValueError(f"Archive entry escapes destination: {member!r}") from exc
    archive.extractall(dest)


def write_tree(dest: Path, entries: list[tuple[str, bytes]]) -> None:
    """Write ``(relative_path, bytes)`` entries under ``dest``.

    Relative paths come from an untrusted client (a browser folder upload), so
    each is validated to stay within ``dest`` (rejecting ``..`` and absolute
    paths) before writing.
    """
    dest_resolved = dest.resolve()
    for rel, data in entries:
        rel = rel.replace("\\", "/").lstrip("/")
        if not rel:
            continue
        target = (dest / rel).resolve()
        try:
            target.relative_to(dest_resolved)
        except ValueError as exc:
            raise ValueError(f"Path escapes destination: {rel!r}") from exc
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def find_skill_folders(root: Path) -> list[Path]:
    """Top-level skill folders (holding a SKILL.md) under ``root``.

    A skill nested inside another skill's folder is skipped — its files are
    already carried along when the outer folder is copied.
    """
    folders = sorted({p.parent for p in root.rglob(SKILL_FILE)}, key=lambda p: len(p.parts))
    chosen: list[Path] = []
    for folder in folders:
        if any(folder != c and c in folder.parents for c in chosen):
            continue
        chosen.append(folder)
    return chosen


def import_folder(src: Path, *, taken: set[str]) -> str:
    """Copy an on-disk skill folder into the store under a fresh slug."""
    frontmatter, _ = _split_frontmatter((src / SKILL_FILE).read_text(encoding="utf-8"))
    base = str(frontmatter.get("name") or src.name)
    slug = slugify(base, taken=taken)
    taken.add(slug)
    shutil.copytree(src, path_for(slug))
    return slug


def import_markdown(text: str, *, fallback_name: str, taken: set[str]) -> str:
    """Create a skill from a single SKILL.md/markdown document."""
    frontmatter, body = _split_frontmatter(text)
    name = str(frontmatter.get("name") or fallback_name)
    slug = slugify(name, taken=taken)
    taken.add(slug)
    if frontmatter:
        # Already standard-shaped: preserve it verbatim (may carry extra keys).
        folder = path_for(slug)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / SKILL_FILE).write_text(text.strip() + "\n", encoding="utf-8")
    else:
        write_skill(slug, name=name, description="", content=body)
    return slug
