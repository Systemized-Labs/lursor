"""FastAPI application entrypoint."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import (
    agents,
    chat,
    files,
    git,
    github,
    laios,
    models,
    prompt_templates,
    providers,
    skills,
    subagents,
    terminal,
    threads,
    tools,
    workspaces,
)
from app.api import (
    settings as settings_api,
)
from app.config import get_settings
from app.db.session import init_db

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.ensure_dirs()
    settings.apply_env()
    await init_db()
    # Apply any UI-saved settings (e.g. OpenRouter key) over the env defaults.
    await settings_api.load_app_config()
    # Seed a "local" laios connection when running alongside a daemon.
    await laios.seed_local_laios()
    yield


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health", tags=["health"])
async def health() -> dict[str, str]:
    return {"status": "ok", "app": settings.app_name}


for module in (
    agents,
    skills,
    subagents,
    prompt_templates,
    tools,
    providers,
    workspaces,
    threads,
    chat,
    models,
    terminal,
    files,
    git,
    github,
    laios,
    settings_api,
):
    app.include_router(module.router, prefix="/api")
