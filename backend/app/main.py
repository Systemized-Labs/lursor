"""FastAPI application entrypoint."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.agents import scheduler
from app.agents.hindsight import close_hindsight_clients
from app.api import (
    agents,
    analytics,
    chat,
    env_vars,
    files,
    git,
    github,
    integrations,
    laios,
    models,
    preview,
    prompt_templates,
    providers,
    schedules,
    skills,
    subagents,
    terminal,
    threads,
    tools,
    videos,
    workspace_folders,
    workspaces,
)
from app.api import (
    settings as settings_api,
)
from app.config import get_settings
from app.db.prompt_seed import seed_prompt_templates
from app.db.session import async_session_factory, init_db
from app.skills.seed import globalize_bundled, seed_bundled_skills

settings = get_settings()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.ensure_dirs()
    settings.apply_env()
    await init_db()
    # Ship the curated built-in prompt templates on every start (idempotent),
    # register the skills catalog as a workspace so it can be chatted with, and
    # reconcile the skills index against the on-disk skill folders so agent runs
    # always see up-to-date skill directories (and pre-folder rows migrate).
    # The workspace goes in before ``reconcile``, which iterates workspaces.
    #
    # The skills Lursor itself ships (``app/skills/bundled/``) are copied into the
    # catalog first, so ``reconcile`` indexes them in the same pass — a folder that
    # arrived after it ran would sit unindexed until someone opened the Skills page.
    # ``globalize_bundled`` then gives only the *newly installed* ones their initial
    # reach, because the catalog indexes a new folder as parked and a shipped skill
    # that is in scope nowhere does nothing at all. It deliberately does not re-apply
    # on later boots: parking one must survive the next release
    # (``app/skills/seed.py``).
    seeded = seed_bundled_skills()
    async with async_session_factory() as session:
        await seed_prompt_templates(session)
        await workspaces.ensure_skills_workspace(session)
        await skills.reconcile(session)
        await globalize_bundled(session, seeded.installed)
    # Run state is in-memory only, so nothing survives a restart: any thread the
    # last process left mid-run would otherwise show a live status pill forever.
    await chat.reconcile_interrupted_runs()
    # Apply any UI-saved settings (e.g. OpenRouter key) over the env defaults.
    await settings_api.load_app_config()
    # Seed a "local" laios connection when running alongside a daemon.
    await laios.seed_local_laios()
    # Report (never replay) the schedule fires this process was not alive for, then
    # start the 30s tick. Deliberately after ``reconcile_interrupted_runs``: the
    # skip guard asks the run registry what is live, which that pass has to have
    # settled first. Best-effort — a scheduler that can't start must not stop the
    # app, which is otherwise fully usable without it.
    try:
        await scheduler.start()
    except Exception:  # noqa: BLE001 — schedules are a feature, not a prerequisite
        logger.exception("scheduler failed to start; schedules will not fire")
    yield
    await scheduler.stop()
    # Drain the shared Hindsight clients (see ``agents/hindsight.py``). Their
    # transport is aiohttp, which complains loudly about sessions left unclosed at
    # interpreter exit; a no-op when the memory provider is "file".
    await close_hindsight_clients()


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)

# Allow any origin. Using a regex (rather than allow_origins=["*"]) so the
# request origin is reflected back, which browsers require when credentials are
# enabled — this makes any localhost port (Vite may drift to 5174/5175/...) work.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Turn an unhandled error into a JSON 500 the browser is allowed to read.

    Without this, Starlette answers with a bare ``text/plain`` 500 from
    ``ServerErrorMiddleware`` — which sits *outside* ``CORSMiddleware``, so the
    response carries no ``access-control-allow-origin``. The browser then rejects
    it before the app sees it and ``fetch`` throws ``TypeError: Failed to fetch``,
    which is indistinguishable from the backend being down. Every server-side bug
    reads as a network outage, and the actual error only exists in a terminal.

    The CORS headers are therefore set by hand, mirroring the middleware config
    above (reflect the origin, allow credentials), because that middleware never
    gets to run on this path. The traceback is logged here too, since the
    exception is re-raised past the logging FastAPI would otherwise do.
    """
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    headers = {"access-control-allow-credentials": "true"}
    origin = request.headers.get("origin")
    if origin:
        headers["access-control-allow-origin"] = origin
        headers["vary"] = "Origin"
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": f"{type(exc).__name__}: {exc}"},
        headers=headers,
    )


@app.get("/api/health", tags=["health"])
async def health() -> dict[str, str]:
    return {"status": "ok", "app": settings.app_name}


for module in (
    agents,
    analytics,
    env_vars,
    skills,
    subagents,
    prompt_templates,
    tools,
    providers,
    workspaces,
    workspace_folders,
    threads,
    chat,
    schedules,
    models,
    terminal,
    files,
    git,
    github,
    integrations,
    laios,
    videos,
    preview,
    settings_api,
):
    app.include_router(module.router, prefix="/api")
