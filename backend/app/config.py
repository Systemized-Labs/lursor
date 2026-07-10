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
    app_name: str = "Hearthstack"
    debug: bool = True
    # Origins allowed to call the API (the Vite dev server by default).
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    # --- Database ---
    database_url: str = f"sqlite+aiosqlite:///{BACKEND_DIR / 'hearthstack.db'}"

    # --- Workspaces ---
    # Root directory under which each workspace gets its own folder. This folder
    # becomes the deep agent's filesystem root when it runs.
    workspaces_dir: Path = BACKEND_DIR / "workspaces"

    # --- Agents ---
    # Default model used when an agent row does not specify one.
    # Models are served through OpenRouter (prefix "openrouter:").
    default_model: str = "openrouter:qwen/qwen3.7-max"
    openrouter_api_key: str | None = None

    def ensure_dirs(self) -> None:
        """Create on-disk directories the app relies on."""
        self.workspaces_dir.mkdir(parents=True, exist_ok=True)

    def apply_env(self) -> None:
        """Export provider keys so Pydantic AI's model providers can read them."""
        import os

        if self.openrouter_api_key:
            os.environ.setdefault("OPENROUTER_API_KEY", self.openrouter_api_key)


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance."""
    return Settings()
