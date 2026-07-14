"""Application settings, loaded from environment / .env file.

Single source of truth for runtime configuration. Add new settings here rather
than reading ``os.environ`` throughout the codebase.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Repo-root/backend directory, used to resolve default relative paths.
BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """Environment-driven configuration."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Server ---
    app_name: str = "Lursor"
    debug: bool = True
    # Origins allowed to call the API (the Vite dev server by default).
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    # --- Database ---
    database_url: str = f"sqlite+aiosqlite:///{BACKEND_DIR / 'lursor.db'}"

    # --- Workspaces ---
    # Root directory under which each workspace gets its own folder (named by its
    # id) unless a custom location is supplied. This folder becomes the deep
    # agent's filesystem root when it runs.
    workspaces_dir: Path = Path.home() / ".lursor" / "workspaces"

    # --- Skills ---
    # Root directory under which each skill is a self-contained folder following
    # the Anthropic skill standard: a ``SKILL.md`` (YAML frontmatter + markdown
    # body) plus optional bundled resource files and ``scripts/``. This directory
    # is the source of truth for skill content; the ``skills`` DB table is a
    # rebuildable index (see ``app/skills/store.py`` and ``api/skills.py``).
    skills_dir: Path = Path.home() / ".lursor" / "skills"

    # --- Agents ---
    # Default model used when an agent row does not specify one.
    # Models are served through OpenRouter (prefix "openrouter:").
    default_model: str = "openrouter:qwen/qwen3.7-max"
    openrouter_api_key: str | None = None
    # Base URL for OpenRouter's REST API; "/models" is appended to list models.
    openrouter_base_url: str = "https://openrouter.ai/api/v1"

    # --- Media / vision ---
    # Where user-attached chat media (images) are stored, one subfolder per
    # thread. Kept out of the DB so message rows stay small.
    media_dir: Path = Path.home() / ".lursor" / "media"
    # Vision-capable model the `view_image` tool calls (via OpenRouter) to answer
    # questions about an image. Runs as an isolated one-shot sub-call so image
    # bytes never enter a text-only agent's context, and lets any agent inspect
    # images regardless of whether its own chat model supports image input. No
    # "openrouter:" prefix — this hits OpenRouter's chat API directly.
    vision_model: str = "google/gemini-2.5-flash-lite"

    # --- laios control plane ---
    # Used to auto-seed a "local" laios connection on startup when Lursor runs
    # alongside a daemon (the supervisor injects these). LAIOS_MASTER_KEY takes
    # precedence; otherwise the master_key is parsed from the daemon config file.
    laios_url: str | None = None  # e.g. "http://127.0.0.1:7420"
    laios_master_key: str | None = None
    # Fallback source for the master_key when the env var is unset.
    laios_config_path: str = "~/.laios/config/laios.toml"

    def ensure_dirs(self) -> None:
        """Create on-disk directories the app relies on."""
        self.workspaces_dir.mkdir(parents=True, exist_ok=True)
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self.skills_dir.mkdir(parents=True, exist_ok=True)

    def apply_env(self) -> None:
        """Export provider keys so Pydantic AI's model providers can read them."""
        import os

        if self.openrouter_api_key:
            os.environ.setdefault("OPENROUTER_API_KEY", self.openrouter_api_key)


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance."""
    return Settings()
