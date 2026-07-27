"""On-disk skill storage following the Anthropic skill standard.

A skill lives in ``<root>/<slug>/`` and always contains a ``SKILL.md`` with YAML
frontmatter (``name``, ``description``) and a markdown body. The folder may also
carry bundled **resource** files (``.md``/``.json``/``.yaml``/``.yml``/``.csv``/
``.xml``/``.txt`` at any depth) and **scripts** (``*.py`` in the folder root or a
``scripts/`` subdirectory). These are exactly the files ``pydantic_deep``'s
``SkillsDirectory`` discovers at run time, so what the UI shows here matches what
the agent actually loads.

Skill folders live in one of two kinds of root:

- the **catalog** — ``~/.lursor/skills/`` (``settings.skills_dir``): one copy of
  every UI-managed skill, wherever it applies. Which workspaces a catalog skill
  reaches is an *assignment* held in the database, not a location on disk.
- a **workspace** root — ``<workspace.path>/.agents/skills/``: travels with the
  workspace directory (git-shareable, the Claude Code convention) and applies
  only there.

Every path helper takes an explicit ``root`` so the same code serves both;
``catalog_root`` / ``workspace_skills_root`` resolve them. What a given run
actually sees is decided in ``app/skills/resolve.py``, which needs the database
(assignments) and therefore does not live here.

This module is filesystem-only — it never touches the database. The DB ``skills``
table is a rebuildable index reconciled against this store in ``app/api/skills.py``.
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

# Per-workspace skills live here, relative to the workspace directory. The
# ``.agents/`` prefix matches the convention several agent tools/libraries already
# use for on-disk configuration that travels with a repo.
WORKSPACE_SKILLS_SUBDIR = Path(".agents") / "skills"


@dataclass
class ParsedSkill:
    """The contents of one on-disk skill folder."""

    slug: str
    name: str
    description: str
    content: str
    resources: list[str] = field(default_factory=list)
    scripts: list[str] = field(default_factory=list)


def catalog_root() -> Path:
    """The canonical store for managed skills (``~/.lursor/skills/``).

    Created if missing. Every UI-created or imported skill lands here exactly
    once; its reach (global / a set of workspaces / nowhere) is an assignment in
    the database, so re-pointing a skill never moves files.
    """
    root = get_settings().skills_dir
    root.mkdir(parents=True, exist_ok=True)
    return root


def workspace_skills_root(workspace_path: str | Path) -> Path:
    """The skills root for a workspace: ``<workspace.path>/.agents/skills/``.

    Not created here — a workspace may have no skills, so absence is normal.
    Directory creation is lazy, on the first workspace-scoped write.
    """
    return Path(workspace_path) / WORKSPACE_SKILLS_SUBDIR


def path_for(slug: str, root: Path) -> Path:
    """Absolute path to a skill folder under ``root``.

    ``slug`` is validated to stay directly under ``root`` (no traversal).
    """
    folder = (root / slug).resolve()
    if folder.parent != root.resolve():
        raise ValueError(f"Invalid skill slug: {slug!r}")
    return folder


def exists(slug: str, root: Path) -> bool:
    return (path_for(slug, root) / SKILL_FILE).is_file()


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


def list_slugs(root: Path) -> list[str]:
    """Every folder directly under ``root`` that holds a ``SKILL.md``.

    Tolerates a missing ``root`` (returns ``[]``) since workspace roots are only
    created on first write.
    """
    if not root.is_dir():
        return []
    return sorted(
        p.name for p in root.iterdir() if p.is_dir() and (p / SKILL_FILE).is_file()
    )


def move_skill(slug: str, src_root: Path, dst_root: Path, *, taken: set[str]) -> str:
    """Move a skill folder between roots, returning the (possibly new) slug.

    Used by promote (workspace root → catalog): the whole folder moves so bundled
    resources and scripts come along. The slug is re-derived against ``taken`` so
    a name already present in the destination doesn't clobber it.
    """
    src = path_for(slug, src_root)
    new_slug = slug if slug not in taken else slugify(slug, taken=taken)
    dst = path_for(new_slug, dst_root)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    return new_slug


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


def read_skill(slug: str, root: Path) -> ParsedSkill | None:
    """Load a skill folder under ``root``, or ``None`` if it has no ``SKILL.md``."""
    folder = path_for(slug, root)
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


def write_skill(
    slug: str, root: Path, *, name: str, description: str, content: str
) -> None:
    """Create/overwrite ``<root>/<slug>/SKILL.md`` with standard frontmatter."""
    folder = path_for(slug, root)
    folder.mkdir(parents=True, exist_ok=True)
    frontmatter = yaml.safe_dump(
        {"name": name, "description": description},
        sort_keys=False,
        allow_unicode=True,
    ).strip()
    body = content.strip()
    doc = f"---\n{frontmatter}\n---\n\n{body}\n" if body else f"---\n{frontmatter}\n---\n"
    (folder / SKILL_FILE).write_text(doc, encoding="utf-8")


def delete_skill(slug: str, root: Path) -> None:
    folder = path_for(slug, root)
    if folder.is_dir():
        shutil.rmtree(folder)


# --- Files inside a skill folder -----------------------------------------------


def _resource_path(slug: str, root: Path, rel: str) -> Path:
    """Resolve a file inside a skill folder, guarding against path traversal."""
    folder = path_for(slug, root).resolve()
    target = (folder / rel).resolve()
    try:
        target.relative_to(folder)
    except ValueError as exc:
        raise ValueError(f"Path escapes skill folder: {rel!r}") from exc
    return target


def is_skill_file(slug: str, root: Path, rel: str) -> bool:
    """Does ``rel`` point at the folder's ``SKILL.md``?

    ``SKILL.md`` is editable like any other file — the editor shows the real file,
    frontmatter included, so keys the UI doesn't model (``license``, ``version``,
    ``allowed-tools``…) survive a round-trip. Callers use this to refresh the
    cached name/description afterwards, since those live in that frontmatter.
    """
    return _resource_path(slug, root, rel) == path_for(slug, root).resolve() / SKILL_FILE


def read_file(slug: str, root: Path, rel: str) -> str:
    return _resource_path(slug, root, rel).read_text(encoding="utf-8")


def write_file(slug: str, root: Path, rel: str, content: str) -> None:
    target = _resource_path(slug, root, rel)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def delete_file(slug: str, root: Path, rel: str) -> None:
    # Deleting SKILL.md would leave a folder that no longer reads as a skill, so
    # the whole skill is deleted through its own endpoint instead.
    if is_skill_file(slug, root, rel):
        raise ValueError("SKILL.md can't be deleted — delete the skill instead")
    target = _resource_path(slug, root, rel)
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


def import_folder(src: Path, root: Path, *, taken: set[str]) -> str:
    """Copy an on-disk skill folder into ``root`` under a fresh slug."""
    frontmatter, _ = _split_frontmatter((src / SKILL_FILE).read_text(encoding="utf-8"))
    base = str(frontmatter.get("name") or src.name)
    slug = slugify(base, taken=taken)
    taken.add(slug)
    shutil.copytree(src, path_for(slug, root))
    return slug


def import_markdown(
    text: str, root: Path, *, fallback_name: str, taken: set[str]
) -> str:
    """Create a skill in ``root`` from a single SKILL.md/markdown document."""
    frontmatter, body = _split_frontmatter(text)
    name = str(frontmatter.get("name") or fallback_name)
    slug = slugify(name, taken=taken)
    taken.add(slug)
    if frontmatter:
        # Already standard-shaped: preserve it verbatim (may carry extra keys).
        folder = path_for(slug, root)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / SKILL_FILE).write_text(text.strip() + "\n", encoding="utf-8")
    else:
        write_skill(slug, root, name=name, description="", content=body)
    return slug
