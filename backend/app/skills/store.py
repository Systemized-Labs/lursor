"""On-disk skill storage following the Anthropic skill standard.

A skill lives in ``<root>/<slug>/`` and always contains a ``SKILL.md`` with YAML
frontmatter (``name``, ``description``) and a markdown body. The folder may also
carry bundled **resource** files (``.md``/``.json``/``.yaml``/``.yml``/``.csv``/
``.xml``/``.txt`` at any depth) and **scripts** (``*.py`` in the folder root or a
``scripts/`` subdirectory). These are exactly the files ``pydantic_deep``'s
``SkillsDirectory`` discovers at run time, so what the UI shows here matches what
the agent actually loads.

Skills come from two **scopes**, mirroring Claude Code:

- **global** — ``~/.lursor/skills/`` (``settings.skills_dir``): applies to every
  agent, in every workspace.
- **workspace** — ``<workspace.path>/.agents/skills/``: travels with the workspace
  directory (git-shareable) and only applies while an agent runs in it.

Every path helper takes an explicit ``root`` so the same code serves both scopes;
``global_skills_root`` / ``workspace_skills_root`` resolve the two roots.
``merged_skill_dirs`` is what the builder hands the deep agent for a run: the two
scopes merged with the workspace copy winning on slug collision (closest scope).

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


def global_skills_root() -> Path:
    """The user-global skills root (``~/.lursor/skills/``), created if missing."""
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


def merged_skill_dirs(workspace_path: str | Path) -> list[str]:
    """Absolute skill folders for a run: global skills plus the workspace's own.

    On a slug collision the workspace copy wins (closest scope, like Claude Code).
    Reads the two roots directly off disk — independent of the DB index — so a run
    always sees exactly what is on disk for wherever it is working.
    """
    by_slug: dict[str, Path] = {}
    global_root = global_skills_root()
    for slug in list_slugs(global_root):
        by_slug[slug] = path_for(slug, global_root)
    ws_root = workspace_skills_root(workspace_path)
    for slug in list_slugs(ws_root):
        by_slug[slug] = path_for(slug, ws_root)
    return [str(p) for p in by_slug.values()]


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


# --- Bundled resource / script files -------------------------------------------


def _resource_path(slug: str, root: Path, rel: str) -> Path:
    """Resolve a file inside a skill folder, guarding against path traversal."""
    folder = path_for(slug, root).resolve()
    target = (folder / rel).resolve()
    try:
        target.relative_to(folder)
    except ValueError as exc:
        raise ValueError(f"Path escapes skill folder: {rel!r}") from exc
    if target == folder / SKILL_FILE:
        raise ValueError("SKILL.md is edited via the skill body, not as a resource")
    return target


def read_file(slug: str, root: Path, rel: str) -> str:
    return _resource_path(slug, root, rel).read_text(encoding="utf-8")


def write_file(slug: str, root: Path, rel: str, content: str) -> None:
    target = _resource_path(slug, root, rel)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def delete_file(slug: str, root: Path, rel: str) -> None:
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
