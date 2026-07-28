"""On-disk skill storage following the Anthropic skill standard.

A skill lives in ``<root>/<slug>/`` and always contains a ``SKILL.md`` with YAML
frontmatter (``name``, ``description``) and a markdown body. The folder may also
carry bundled **resource** files (``.md``/``.json``/``.yaml``/``.yml``/``.csv``/
``.xml``/``.txt`` at any depth) and **scripts** (``*.py`` in the folder root or a
``scripts/`` subdirectory). These are exactly the files ``pydantic_deep``'s
``SkillsDirectory`` discovers at run time, so what the UI shows here matches what
the agent actually loads.

Skill folders live in one of three kinds of root:

- the **catalog** — ``~/.lursor/skills/`` (``settings.skills_dir``): one copy of
  every UI-managed skill, wherever it applies. Which workspaces a catalog skill
  reaches is an *assignment* held in the database, not a location on disk.
- a **local** root — ``<workspace.path>/<subdir>/`` for each entry in
  ``settings.local_skill_roots`` (``.agents/skills``, ``.claude/skills``,
  ``.cursor/skills``): travels with the workspace directory (git-shareable) and
  applies only there.
- a **user** root — ``~/.claude/skills``, ``~/.cursor/skills`` and anything else
  in ``settings.user_skill_roots``: personal skills owned by another tool, in
  scope everywhere.

Only the first two are Lursor's to write into structurally, and only
``.agents/skills`` among the local ones — see :func:`is_owned_root`. A root we
don't own is *discovered*: never created, and a folder missing from it is gone
rather than something to rebuild. Editing a skill's files through Lursor still
writes to wherever it actually lives, foreign root included.

Every path helper takes an explicit ``root`` so the same code serves all of them;
``catalog_root`` / ``local_skill_roots`` / ``user_skill_roots`` resolve them. What
a given run actually sees is decided in ``app/skills/resolve.py``, which needs the
database (assignments) and therefore does not live here.

This module is filesystem-only — it never touches the database. The DB ``skills``
table is a rebuildable index reconciled against this store in ``app/api/skills.py``.
"""

from __future__ import annotations

import io
import os
import re
import shutil
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

import yaml

from app.config import get_settings

# Kept in sync with pydantic_deep.features.skills.types.SKILL_RESOURCE_EXTENSIONS
# so listed resources match what the agent discovers at run time.
RESOURCE_EXTENSIONS: frozenset[str] = frozenset(
    {".md", ".json", ".yaml", ".yml", ".csv", ".xml", ".txt"}
)
SKILL_FILE = "SKILL.md"

# The one workspace-relative root Lursor writes into structurally: creates it,
# authors into it, and rebuilds a folder there from the DB cache. The ``.agents/``
# prefix matches the convention several agent tools/libraries already use for
# on-disk configuration that travels with a repo. Other local roots
# (``.claude/skills``, ``.cursor/skills``) belong to other tools and are read in
# place.
DEFAULT_LOCAL_SKILL_ROOT = ".agents/skills"


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


def _normalize_root_key(raw: str) -> str:
    """Canonical form of a configured workspace-relative root.

    Separators become ``/`` and surrounding slashes/whitespace are dropped, so
    ``".claude/skills/"`` and ``".claude\\skills"`` are the same key — the key is
    stored on every ``Skill`` row, and two spellings of one directory would index
    it twice.
    """
    key = raw.strip().replace("\\", "/").strip("/")
    if not key or key == "." or ".." in PurePosixPath(key).parts:
        return ""
    return key


def workspace_skills_root(workspace_path: str | Path) -> Path:
    """The root a *new* workspace-local skill is written into.

    ``<workspace.path>/.agents/skills/`` — the only local root Lursor creates.
    Not created here: a workspace may have no skills, so absence is normal, and
    directory creation is lazy on the first workspace-scoped write.
    """
    return Path(workspace_path) / DEFAULT_LOCAL_SKILL_ROOT


def local_root_path(workspace_path: str | Path, key: str) -> Path:
    """Absolute path of one local root, given the key a ``Skill`` row stores.

    An empty or malformed key falls back to the default root, so a row written
    before roots were configurable still resolves.
    """
    return Path(workspace_path) / (_normalize_root_key(key) or DEFAULT_LOCAL_SKILL_ROOT)


def local_root_keys() -> list[str]:
    """Configured workspace-relative roots, in precedence order, de-duplicated."""
    keys: list[str] = []
    for raw in get_settings().local_skill_roots:
        key = _normalize_root_key(raw)
        if key and key not in keys:
            keys.append(key)
    return keys


def local_skill_roots(workspace_path: str | Path) -> list[tuple[str, Path]]:
    """``(key, absolute path)`` for every configured local root that exists.

    ``key`` is the workspace-relative subdir as configured (``".claude/skills"``)
    and is what a ``Skill`` row stores, so the row survives the workspace moving.
    Non-existent roots are omitted: absence is the normal case.

    The catalog is never returned as a *local* root. A workspace registered at
    ``~/.lursor`` (or the catalog's own parent) would otherwise match the bare
    ``skills`` entry and index every managed skill a second time — as a local one,
    which then shadows the managed row it was copied from.
    """
    base = Path(workspace_path)
    catalog = get_settings().skills_dir.expanduser().resolve()
    out: list[tuple[str, Path]] = []
    for key in local_root_keys():
        path = base / key
        if not path.is_dir() or path.resolve() == catalog:
            continue
        out.append((key, path))
    return out


def user_root_keys() -> list[str]:
    """Configured personal roots as expanded absolute paths, in precedence order."""
    keys: list[str] = []
    for raw in get_settings().user_skill_roots:
        raw = raw.strip()
        if not raw:
            continue
        key = str(Path(raw).expanduser())
        if key not in keys:
            keys.append(key)
    return keys


def user_skill_roots() -> list[tuple[str, Path]]:
    """``(key, path)`` for every configured personal root that exists.

    ``key`` is the expanded absolute path — these are not relative to anything.
    """
    return [(key, Path(key)) for key in user_root_keys() if Path(key).is_dir()]


def is_owned_root(key: str) -> bool:
    """True when Lursor may create this root or rebuild a folder inside it.

    The catalog (empty key) and ``.agents/skills`` are ours. Everything else is
    another tool's directory: we index what is there and nothing more, so a
    folder that disappears means the skill is gone, not that the index should
    put it back.
    """
    return not key.strip() or _normalize_root_key(key) == DEFAULT_LOCAL_SKILL_ROOT


def root_label(key: str) -> str:
    """Short display form of a root (``.claude``, ``.cursor``, ``~/.claude``).

    Empty for the catalog, which needs no badge. Computed here rather than in the
    frontend so no client has to parse paths to say where a skill came from.
    """
    key = key.strip().replace("\\", "/")
    if not key:
        return ""
    path = PurePosixPath(key)
    parent = path.parent
    label = parent.name or path.name
    if not path.is_absolute():
        return label
    home = PurePosixPath(str(Path.home()))
    if parent == home or home in parent.parents:
        return f"~/{label}"
    return str(parent)


def path_for(slug: str, root: Path) -> Path:
    """Absolute path to a skill folder under ``root``.

    ``slug`` is validated to name a direct child of ``root`` (no separators, no
    traversal). The folder itself is deliberately *not* resolved: a symlinked
    skill folder is common in a hand-maintained ``~/.claude/skills``, and
    resolving it would put it outside its root and make the whole root unreadable.
    Escapes are still caught below, and files *inside* the folder are checked
    against the resolved folder in :func:`_resource_path`.
    """
    if not slug or slug in {".", ".."} or "/" in slug or "\\" in slug or os.sep in slug:
        raise ValueError(f"Invalid skill slug: {slug!r}")
    folder = root / slug
    if folder.parent.resolve() != root.resolve():
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


def copy_skill(slug: str, src_root: Path, dst_root: Path, *, taken: set[str]) -> str:
    """Copy a skill folder between roots, returning the (possibly new) slug.

    The non-destructive half of :func:`move_skill`, for roots Lursor doesn't own.
    Taking a skill out of ``.claude/skills`` would mutate a git-tracked tree
    behind the user's back; taking one out of ``~/.claude/skills`` would delete it
    from under Claude Code. Symlinks are followed so the catalog copy is
    self-contained.
    """
    src = path_for(slug, src_root)
    new_slug = slug if slug not in taken else slugify(slug, taken=taken)
    dst = path_for(new_slug, dst_root)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst, symlinks=False)
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
    """Create/overwrite ``<root>/<slug>/SKILL.md``, preserving unknown frontmatter.

    Only ``name`` and ``description`` are modelled by the UI, but a skill written
    for another tool routinely carries ``allowed-tools``, ``license`` or
    ``version``. Rebuilding the frontmatter from the two known keys would delete
    the rest — silently, and in a file inside someone's repo or home directory —
    so existing keys are merged rather than replaced.
    """
    folder = path_for(slug, root)
    folder.mkdir(parents=True, exist_ok=True)
    skill_md = folder / SKILL_FILE
    existing: dict = {}
    if skill_md.is_file():
        existing, _ = _split_frontmatter(skill_md.read_text(encoding="utf-8"))
    # name/description lead (that is the standard's shape); everything else keeps
    # its original order behind them.
    merged = {"name": name, "description": description}
    merged.update({k: v for k, v in existing.items() if k not in merged})
    frontmatter = yaml.safe_dump(
        merged, sort_keys=False, allow_unicode=True
    ).strip()
    body = content.strip()
    doc = f"---\n{frontmatter}\n---\n\n{body}\n" if body else f"---\n{frontmatter}\n---\n"
    skill_md.write_text(doc, encoding="utf-8")


def delete_skill(slug: str, root: Path) -> None:
    folder = path_for(slug, root)
    # A skill folder in a hand-maintained root may be a symlink; ``rmtree``
    # refuses those, so unlink the link and leave its target alone.
    if folder.is_symlink():
        folder.unlink()
    elif folder.is_dir():
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
