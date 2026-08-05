"""Integration detection — what other agent tools on this machine Lursor can pair with.

Read-only by design. Lursor's rule for another tool's directory is *read in
place, never write* (see ``skills/store.py``: "the bytes stay where Claude Code
or Hermes put them"), and installing a plugin into ``~/.hermes`` would break it.
So this router only *reports* what it finds and hands back the exact commands the
operator runs themselves. Nothing here mutates anything outside Lursor.

Currently one integration: the Lursor plugin for Hermes, which lets Hermes drive
this instance — the reverse of the skills relationship, where Lursor reads
``~/.hermes/skills``.
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

import yaml
from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/integrations", tags=["integrations"])

# The plugin's manifest name, which is also the directory Hermes installs it as
# and the key it is enabled under in Hermes's config.
PLUGIN_NAME = "lursor"

# Where the plugin source sits inside this repo, resolved relative to this file
# so it keeps working wherever the checkout lives. Absent in a packaged build,
# which only costs us the "version available" comparison.
_PLUGIN_SUBDIR = ("integrations", "hermes", PLUGIN_NAME)

# The public source Hermes clones from. Its installer accepts an
# ``owner/repo/subdir`` shorthand, so the plugin needs no repo of its own.
_PLUGIN_ORIGIN = "Systemized-Labs/lursor"


class HermesIntegration(BaseModel):
    """What we can see of a local Hermes install and our plugin inside it."""

    # Whether a Hermes home directory exists at all. Everything else is only
    # meaningful when this is true.
    hermes_present: bool
    home: str
    # Empty when the CLI could not be located — see ``_find_cli`` for why that
    # is weaker evidence than it looks from a desktop-launched backend.
    cli_path: str

    plugin_installed: bool
    # True when the plugin directory is a symlink, i.e. someone wired a working
    # checkout in rather than installing a copy. Worth surfacing: it tracks a
    # branch and updates itself on restart.
    plugin_linked: bool
    plugin_enabled: bool
    installed_version: str
    available_version: str
    update_available: bool

    # Copy-paste commands. The operator runs these; Lursor never does.
    install_command: str
    enable_command: str
    detail: str


def hermes_home() -> Path:
    """Hermes's home directory, honouring its own ``HERMES_HOME`` override."""
    override = (os.environ.get("HERMES_HOME") or "").strip()
    return Path(override).expanduser() if override else Path.home() / ".hermes"


def _find_cli() -> str:
    """Absolute path to the ``hermes`` CLI, or ``""``.

    ``shutil.which`` alone is unreliable here: the desktop app inherits a
    minimal PATH from the window server, so a CLI at ``~/.local/bin`` is invisible
    to it even though the user's shell finds it fine. Fall back to the known
    install roots before concluding it is missing — a false "not installed" is
    the one answer that would send someone down the wrong path.
    """
    found = shutil.which("hermes")
    if found:
        return found
    for candidate in (
        Path.home() / ".local" / "bin" / "hermes",
        hermes_home() / "bin" / "hermes",
    ):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return ""


def _manifest_version(plugin_dir: Path) -> str:
    """``version`` from a plugin directory's manifest, or ``""``."""
    for name in ("plugin.yaml", "plugin.yml"):
        path = plugin_dir / name
        if not path.is_file():
            continue
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except (OSError, yaml.YAMLError):
            return ""
        if isinstance(data, dict):
            return str(data.get("version") or "")
    return ""


def _enabled_plugins(home: Path) -> set[str]:
    """Plugin keys listed under ``plugins.enabled`` in Hermes's config.

    Hermes is opt-in: a plugin present on disk does nothing until its key is in
    this list, so "installed but not enabled" is a state worth telling the user
    about rather than showing as working.
    """
    config = home / "config.yaml"
    if not config.is_file():
        return set()
    try:
        data = yaml.safe_load(config.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        # Their config, not ours — a parse failure is not something to raise over.
        logger.debug("Could not parse Hermes config at %s", config)
        return set()
    plugins = data.get("plugins") if isinstance(data, dict) else None
    enabled = plugins.get("enabled") if isinstance(plugins, dict) else None
    if not isinstance(enabled, list):
        return set()
    return {str(item) for item in enabled if item}


def _repo_plugin_dir() -> Path | None:
    """This checkout's copy of the plugin, if the source tree is present.

    Walks up from this file rather than assuming a working directory, and returns
    ``None`` in a packaged build where only the backend was shipped.
    """
    for parent in Path(__file__).resolve().parents:
        candidate = parent.joinpath(*_PLUGIN_SUBDIR)
        if candidate.is_dir():
            return candidate
    return None


@router.get("/hermes", response_model=HermesIntegration)
async def hermes_status() -> HermesIntegration:
    """Report whether Hermes is installed here and whether our plugin is live."""
    home = hermes_home()
    present = home.is_dir()
    plugin_dir = home / "plugins" / PLUGIN_NAME
    # ``is_dir`` follows the link, which is what we want — a symlink to a real
    # checkout is a working install.
    installed = plugin_dir.is_dir()
    linked = plugin_dir.is_symlink()

    installed_version = _manifest_version(plugin_dir) if installed else ""
    repo_dir = _repo_plugin_dir()
    available_version = _manifest_version(repo_dir) if repo_dir else ""
    enabled = PLUGIN_NAME in _enabled_plugins(home) if present else False

    subdir = "/".join(_PLUGIN_SUBDIR)
    install_command = f"hermes plugins install {_PLUGIN_ORIGIN}/{subdir}"

    if not present:
        detail = (
            "No Hermes install found on this machine. Install Hermes first, then "
            "come back — this plugin lets it drive Lursor."
        )
    elif not installed:
        detail = (
            "Hermes is installed but does not have the Lursor plugin yet. Run the "
            "install command below, then restart Hermes."
        )
    elif not enabled:
        detail = (
            "The plugin is present but not enabled. Hermes is opt-in, so run the "
            "enable command below, then restart Hermes."
        )
    elif linked:
        detail = (
            "Connected, from a local checkout — the plugin tracks that working "
            "copy and picks up changes when Hermes restarts."
        )
    else:
        detail = "Connected. Hermes can drive this Lursor instance."

    update = bool(
        installed
        and not linked
        and available_version
        and installed_version
        and available_version != installed_version
    )
    if update:
        detail += (
            f" Version {installed_version} is installed and {available_version} ships "
            "with this Lursor — re-run the install to upgrade."
        )

    return HermesIntegration(
        hermes_present=present,
        home=str(home),
        cli_path=_find_cli(),
        plugin_installed=installed,
        plugin_linked=linked,
        plugin_enabled=enabled,
        installed_version=installed_version,
        available_version=available_version,
        update_available=update,
        install_command=install_command,
        enable_command=f"hermes plugins enable {PLUGIN_NAME}",
        detail=detail,
    )
