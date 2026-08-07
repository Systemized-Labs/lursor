"""App-wide settings — currently the OpenRouter API key.

The key can come from two places: the environment / ``.env`` (read at boot into
:class:`Settings`) or a value the user saves here, which is persisted in the
single ``AppConfig`` row. A UI-saved key wins and is applied to the running
process — both the cached :class:`Settings` (read directly by the models
endpoint) and ``OPENROUTER_API_KEY`` in ``os.environ`` (read by Pydantic AI's
OpenRouter provider during runs) — so it takes effect without a restart.
"""

from __future__ import annotations

import contextlib
import logging
import os

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.agents import hindsight
from app.agents.image_runtime import reset_image_model_cache
from app.agents.video_runtime import reset_video_model_cache
from app.agents.web_search import DEFAULT_WEB_SEARCH_PROVIDER
from app.config import get_settings
from app.db.models import AppConfig, LaiosConnection
from app.db.session import async_session_factory, get_session
from app.media import openrouter as openrouter_media
from app.media import refs
from app.schemas.settings import (
    CompactionDefaultsRead,
    CompactionDefaultsUpdate,
    KeyedSearchProvider,
    MediaModalityRead,
    MediaSettingsRead,
    MediaSettingsUpdate,
    MemorySettingsRead,
    MemorySettingsUpdate,
    MemoryTestResult,
    OpenRouterKeyReveal,
    OpenRouterSettingsRead,
    OpenRouterSettingsUpdate,
    OpenRouterTestResult,
    WebSearchKeyReveal,
    WebSearchSettingsRead,
    WebSearchSettingsUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])

# The values provided via the environment / .env, captured once before any UI
# override is applied. Used as the fallback when the user clears a saved value.
_env_key: str | None = None
_env_compaction: tuple[float, float] | None = None
_env_captured = False


def _capture_env_baseline() -> None:
    """Snapshot the environment's own values, once, before any override lands.

    Covers every setting the UI can override *in the running process* — the
    OpenRouter key and the compaction defaults — so clearing one has something
    truthful to revert to. Called from each endpoint that reads or writes them as
    well as from startup, so whichever runs first captures a clean baseline.
    """
    global _env_key, _env_compaction, _env_captured
    if not _env_captured:
        current = get_settings()
        _env_key = current.openrouter_api_key
        _env_compaction = (
            current.default_compaction_threshold,
            current.default_compaction_ratio,
        )
        _env_captured = True


def _apply_key(key: str | None) -> None:
    """Point the running process at ``key`` (or nothing) for OpenRouter."""
    settings = get_settings()
    settings.openrouter_api_key = key or None
    if key:
        os.environ["OPENROUTER_API_KEY"] = key
    else:
        os.environ.pop("OPENROUTER_API_KEY", None)


def _apply_compaction(threshold: float | None, ratio: float | None) -> None:
    """Point the running process at the saved compaction defaults.

    Mutating the cached :class:`Settings` is what makes a save take effect without
    a restart: every consumer resolves through that one object (see
    ``agents/context_budget.py``), so nothing else has to be plumbed. ``None`` for
    either knob restores the environment's value.
    """
    settings = get_settings()
    env_threshold, env_ratio = _env_compaction or (
        settings.default_compaction_threshold,
        settings.default_compaction_ratio,
    )
    settings.default_compaction_threshold = (
        threshold if threshold is not None else env_threshold
    )
    settings.default_compaction_ratio = ratio if ratio is not None else env_ratio


async def load_app_config() -> None:
    """Apply the persisted settings at startup (called from the app lifespan)."""
    _capture_env_baseline()
    async with async_session_factory() as session:
        cfg = (await session.execute(select(AppConfig))).scalars().first()
    if cfg is None:
        return
    if cfg.openrouter_api_key:
        _apply_key(cfg.openrouter_api_key)
    # Unconditional (unlike the key): a NULL knob has to reinstate the environment
    # value, since a stale value from a previous save must not survive a clear.
    _apply_compaction(cfg.compaction_threshold, cfg.compaction_ratio)


def _hint(key: str | None) -> str | None:
    return f"…{key[-4:]}" if key and len(key) >= 4 else None


async def _get_config(session: AsyncSession) -> AppConfig | None:
    return (await session.execute(select(AppConfig))).scalars().first()


@router.get("/openrouter", response_model=OpenRouterSettingsRead)
async def get_openrouter(session: AsyncSession = Depends(get_session)):
    _capture_env_baseline()
    cfg = await _get_config(session)
    db_key = cfg.openrouter_api_key if cfg else None
    effective = get_settings().openrouter_api_key
    source = "database" if db_key else ("env" if effective else "none")
    return OpenRouterSettingsRead(
        configured=bool(effective), key_hint=_hint(effective), source=source
    )


@router.get("/openrouter/reveal", response_model=OpenRouterKeyReveal)
async def reveal_openrouter(session: AsyncSession = Depends(get_session)):
    """Return the effective key in full so the UI can copy it back out.

    A key pasted here is otherwise write-only, which makes it impossible to move
    to another machine without digging it out of the provider's dashboard. This
    is a local single-user app behind the same auth as every other route, so
    handing the secret back on an explicit request is safe.
    """
    _capture_env_baseline()
    key = get_settings().openrouter_api_key
    if not key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No OpenRouter key is set.")
    cfg = await _get_config(session)
    return OpenRouterKeyReveal(
        api_key=key, source="database" if (cfg and cfg.openrouter_api_key) else "env"
    )


@router.put("/openrouter", response_model=OpenRouterSettingsRead)
async def set_openrouter(
    payload: OpenRouterSettingsUpdate, session: AsyncSession = Depends(get_session)
):
    _capture_env_baseline()
    key = (payload.api_key or "").strip() or None

    cfg = await _get_config(session)
    if cfg is None:
        cfg = AppConfig()
    cfg.openrouter_api_key = key
    session.add(cfg)
    await session.commit()

    # A saved key takes effect immediately; clearing reverts to the env value.
    _apply_key(key or _env_key)
    return await get_openrouter(session)


@router.post("/openrouter/test", response_model=OpenRouterTestResult)
async def test_openrouter(payload: OpenRouterSettingsUpdate):
    """Probe a key against OpenRouter's ``/key`` endpoint without saving it.

    When ``api_key`` is omitted, the currently-effective key is tested.
    """
    key = (payload.api_key or "").strip() or get_settings().openrouter_api_key
    if not key:
        return OpenRouterTestResult(status="error", error="No key to test.")

    base = get_settings().openrouter_base_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{base}/key", headers={"Authorization": f"Bearer {key}"}
            )
    except httpx.RequestError as exc:
        logger.warning("openrouter: /key unreachable: %s", exc)
        return OpenRouterTestResult(
            status="error", error="Could not reach OpenRouter. Check your connection."
        )

    if resp.status_code in (401, 403):
        return OpenRouterTestResult(status="error", error="OpenRouter rejected the key.")
    if resp.status_code >= 400:
        return OpenRouterTestResult(
            status="error", error=f"OpenRouter returned HTTP {resp.status_code}."
        )

    data = resp.json().get("data", {}) if resp.content else {}
    return OpenRouterTestResult(status="ok", label=data.get("label") or None)


@router.delete("/openrouter", status_code=status.HTTP_204_NO_CONTENT)
async def clear_openrouter(session: AsyncSession = Depends(get_session)):
    _capture_env_baseline()
    cfg = await _get_config(session)
    if cfg is not None:
        cfg.openrouter_api_key = None
        session.add(cfg)
        await session.commit()
    _apply_key(_env_key)


# --- Web search ---------------------------------------------------------------
# The provider is applied at agent-build time (see ``agents/builder.py``), so —
# unlike the OpenRouter key — there is nothing to push into the running process
# here: reads happen per run straight from the DB row / environment.


@router.get("/web-search", response_model=WebSearchSettingsRead)
async def get_web_search(session: AsyncSession = Depends(get_session)):
    cfg = await _get_config(session)
    provider = (cfg.web_search_provider if cfg else None) or DEFAULT_WEB_SEARCH_PROVIDER

    tavily_db = cfg.tavily_api_key if cfg else None
    tavily_env = get_settings().tavily_api_key
    tavily_eff = tavily_db or tavily_env

    exa_db = cfg.exa_api_key if cfg else None
    exa_env = get_settings().exa_api_key
    exa_eff = exa_db or exa_env

    return WebSearchSettingsRead(
        provider=provider,
        tavily_configured=bool(tavily_eff),
        tavily_key_hint=_hint(tavily_eff),
        tavily_source="database" if tavily_db else ("env" if tavily_env else "none"),
        exa_configured=bool(exa_eff),
        exa_key_hint=_hint(exa_eff),
        exa_source="database" if exa_db else ("env" if exa_env else "none"),
    )


@router.get("/web-search/{provider}/reveal", response_model=WebSearchKeyReveal)
async def reveal_web_search_key(
    provider: KeyedSearchProvider, session: AsyncSession = Depends(get_session)
):
    """Return one provider's effective key in full so the UI can copy it out.

    Only the keyed providers have anything to reveal; ``native`` and
    ``duckduckgo`` are rejected by the path type before reaching here.
    """
    cfg = await _get_config(session)
    db_key = getattr(cfg, f"{provider}_api_key", None) if cfg else None
    key = db_key or getattr(get_settings(), f"{provider}_api_key")
    if not key:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"No {provider.title()} key is set."
        )
    return WebSearchKeyReveal(
        provider=provider, api_key=key, source="database" if db_key else "env"
    )


@router.put("/web-search", response_model=WebSearchSettingsRead)
async def set_web_search(
    payload: WebSearchSettingsUpdate, session: AsyncSession = Depends(get_session)
):
    cfg = await _get_config(session)
    if cfg is None:
        cfg = AppConfig()

    # Only touch fields the caller actually sent, so the provider and each key
    # can be saved independently without clobbering the others.
    fields = payload.model_fields_set
    if "provider" in fields:
        cfg.web_search_provider = payload.provider
    if "tavily_api_key" in fields:
        cfg.tavily_api_key = (payload.tavily_api_key or "").strip() or None
    if "exa_api_key" in fields:
        cfg.exa_api_key = (payload.exa_api_key or "").strip() or None

    session.add(cfg)
    await session.commit()
    return await get_web_search(session)


# --- Image & video --------------------------------------------------------------
# Which source generates images and clips: a connected laios box, or OpenRouter.
# Read per run straight off the row, like web search and unlike the compaction
# knobs — there is nothing to push into the running process.
#
# What a save *does* have to do is drop the resolver caches. Both runtimes cache
# "what is this box serving" for five minutes and the OpenRouter catalogues for
# fifteen, so without this the reason sentence shown immediately after a change
# would describe the previous choice — which reads as the save not having worked.


async def _media_modality(
    session: AsyncSession, cfg: AppConfig | None, kind: str
) -> MediaModalityRead:
    """The configured source/model for one modality, plus what it resolves to.

    ``available`` / ``reason`` come from the same resolver the capability probe
    and ``build_deep_agent`` use, so this card cannot disagree with the agent
    editor's hint about whether generation works.
    """
    from app.agents.image_runtime import resolve_image_target
    from app.agents.video_runtime import resolve_video_target

    if kind == "image":
        source = (cfg.image_source if cfg else None) or refs.LAIOS
        pinned = (cfg.image_model if cfg else None) or None
        runtime, reason = await resolve_image_target(session)
        effective = runtime.default.model if runtime else None
    else:
        source = (cfg.video_source if cfg else None) or refs.LAIOS
        pinned = (cfg.video_model if cfg else None) or None
        runtime, reason = await resolve_video_target(session)
        effective = runtime.model if runtime else None

    return MediaModalityRead(
        source=source,  # type: ignore[arg-type]
        model=pinned,
        model_source="database" if pinned else "auto",
        available=runtime is not None,
        reason=reason,
        effective_model=effective,
    )


@router.get("/media", response_model=MediaSettingsRead)
async def get_media(session: AsyncSession = Depends(get_session)):
    cfg = await _get_config(session)
    connections = (await session.execute(select(LaiosConnection))).scalars().first()
    return MediaSettingsRead(
        image=await _media_modality(session, cfg, "image"),
        video=await _media_modality(session, cfg, "video"),
        openrouter_configured=bool(get_settings().openrouter_api_key),
        laios_connected=connections is not None,
    )


@router.put("/media", response_model=MediaSettingsRead)
async def set_media(
    payload: MediaSettingsUpdate, session: AsyncSession = Depends(get_session)
):
    cfg = await _get_config(session)
    if cfg is None:
        cfg = AppConfig()

    # Partial, like web search: the image and video choices save independently.
    fields = payload.model_fields_set
    if "image_source" in fields:
        cfg.image_source = payload.image_source
    if "video_source" in fields:
        cfg.video_source = payload.video_source
    if "image_model" in fields:
        cfg.image_model = (payload.image_model or "").strip() or None
    if "video_model" in fields:
        cfg.video_model = (payload.video_model or "").strip() or None

    # A pin that names the other source is rejected rather than stored, because
    # the resolver would then have to choose between honouring the pin (crossing
    # a source the user did not select) and ignoring it (silently). Neither is a
    # state worth being able to reach.
    for kind, source, pinned in (
        ("image", cfg.image_source, cfg.image_model),
        ("video", cfg.video_source, cfg.video_model),
    ):
        try:
            ref = refs.parse_model_ref(pinned)
        except refs.RefError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        if ref is not None and not refs.belongs_to(ref, refs.parse_source(source)):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"the pinned {kind} model {pinned!r} is not on the selected "
                f"{kind} source ({source or refs.LAIOS})",
            )

    session.add(cfg)
    await session.commit()

    # See the section note: a stale resolver would describe the old choice.
    reset_image_model_cache()
    reset_video_model_cache()
    openrouter_media.reset_catalogues()

    return await get_media(session)


# --- Memory -------------------------------------------------------------------
# Which backend an agent with ``include_memory=True`` gets: the library's
# per-workspace MEMORY.md ("file", the default) or a Hindsight memory bank
# ("hindsight"). Like web search, the provider is read at agent-build time, so
# there is nothing to push into the running process here — a save takes effect on
# the next message.
#
# The tuning knobs live in the ``hindsight_config`` JSON blob rather than in
# columns, so adding one needs no migration. Reads and writes both go through
# ``hindsight.resolve_knobs``, the same function the builder uses, so the values
# this endpoint reports are the values a run would actually apply — and an absent
# key means "the default" on both sides.


def _memory_knobs(cfg: AppConfig | None) -> dict:
    """The effective Hindsight tuning knobs — the same resolution a run uses.

    Shared with the builder via ``hindsight.resolve_knobs`` so the values shown
    here can't drift from the values a turn would actually apply. Deliberately
    independent of whether the provider is currently selected: the settings form
    has to render real values before the user switches over.
    """
    return hindsight.resolve_knobs(
        cfg.hindsight_config if cfg else None, get_settings()
    )


@router.get("/memory", response_model=MemorySettingsRead)
async def get_memory(session: AsyncSession = Depends(get_session)):
    cfg = await _get_config(session)
    app_settings = get_settings()

    key_db = cfg.hindsight_api_key if cfg else None
    key_env = app_settings.hindsight_api_key
    key_eff = key_db or key_env

    return MemorySettingsRead(
        provider=hindsight.resolve_provider(cfg),
        hindsight_installed=hindsight.hindsight_installed(),
        hindsight_base_url=(cfg.hindsight_base_url if cfg else None)
        or app_settings.hindsight_base_url,
        hindsight_configured=bool(key_eff),
        hindsight_key_hint=_hint(key_eff),
        hindsight_source="database" if key_db else ("env" if key_env else "none"),
        **_memory_knobs(cfg),
    )


@router.put("/memory", response_model=MemorySettingsRead)
async def set_memory(
    payload: MemorySettingsUpdate, session: AsyncSession = Depends(get_session)
):
    cfg = await _get_config(session)
    if cfg is None:
        cfg = AppConfig()

    # Only touch fields the caller actually sent, so the provider, the connection
    # and each knob can be saved independently without clobbering the others.
    fields = payload.model_fields_set
    if "provider" in fields:
        cfg.memory_provider = payload.provider
    if "hindsight_base_url" in fields:
        cfg.hindsight_base_url = (
            (payload.hindsight_base_url or "").strip().rstrip("/") or None
        )
    if "hindsight_api_key" in fields:
        cfg.hindsight_api_key = (payload.hindsight_api_key or "").strip() or None

    # JSON columns don't track in-place mutation; rebuild and reassign.
    blob = dict(cfg.hindsight_config or {})
    for name in (
        "bank_id",
        "isolation",
        "budget",
        "max_tokens",
        "inject_memories",
        "include_reflect",
        "recall_query",
    ):
        if name in fields:
            value = getattr(payload, name)
            # A blank string means "back to the default", which is what an absent
            # key already encodes — so drop it rather than storing "".
            if isinstance(value, str) and not value.strip():
                blob.pop(name, None)
            else:
                blob[name] = value.strip() if isinstance(value, str) else value
    if "extra_recall_tags" in fields:
        blob["extra_recall_tags"] = [
            t.strip() for t in (payload.extra_recall_tags or []) if t.strip()
        ]
    cfg.hindsight_config = blob

    session.add(cfg)
    await session.commit()
    return await get_memory(session)


@router.post("/memory/test", response_model=MemoryTestResult)
async def test_memory(
    payload: MemorySettingsUpdate, session: AsyncSession = Depends(get_session)
):
    """Probe a Hindsight instance with the submitted values without saving them.

    Falls back to the currently-effective connection for any field the caller
    omits, so the button works both while editing and after a save. Reads the
    instance version, then looks for the bank in its listing — one extra request,
    and it reports the fact count the UI shows without ever writing to a bank the
    user may already own.
    """
    if not hindsight.hindsight_installed():
        return MemoryTestResult(
            status="error",
            error=(
                "The 'hindsight' extra is not installed in the backend. Install it "
                "with `uv sync --extra hindsight` and restart."
            ),
        )

    cfg = await _get_config(session)
    app_settings = get_settings()
    knobs = _memory_knobs(cfg)

    base_url = (
        payload.hindsight_base_url
        if "hindsight_base_url" in payload.model_fields_set
        else None
    ) or (cfg.hindsight_base_url if cfg else None) or app_settings.hindsight_base_url
    base_url = (base_url or "").strip().rstrip("/")
    if not base_url:
        return MemoryTestResult(status="error", error="Enter a Hindsight base URL first.")

    api_key = (
        payload.hindsight_api_key
        if "hindsight_api_key" in payload.model_fields_set
        else None
    ) or (cfg.hindsight_api_key if cfg else None) or app_settings.hindsight_api_key
    bank_id = (payload.bank_id or "").strip() or knobs["bank_id"]

    from hindsight_client import Hindsight

    client = Hindsight(
        base_url=base_url,
        api_key=(api_key or "").strip() or None,
        timeout=10.0,
        user_agent=hindsight.user_agent(),
    )
    try:
        version = (await client.aget_version()).api_version
    except Exception as exc:  # noqa: BLE001 - every failure is a readable message
        logger.warning("hindsight: %s unreachable: %s", base_url, exc)
        return MemoryTestResult(status="error", error=_memory_error(exc, base_url))
    else:
        # A reachable instance whose bank listing fails is still usable — report
        # the connection as OK and leave the bank fields unknown.
        try:
            banks = (await client.banks.list_banks()).banks
            match = next((b for b in banks if b.bank_id == bank_id), None)
            return MemoryTestResult(
                status="ok",
                version=version,
                bank_exists=match is not None,
                memory_count=(match.fact_count if match else None),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("hindsight: bank listing failed on %s: %s", base_url, exc)
            return MemoryTestResult(status="ok", version=version)
    finally:
        with contextlib.suppress(Exception):
            await client.aclose()


def _memory_error(exc: Exception, base_url: str) -> str:
    """Map a client failure onto something a user can act on."""
    status_code = getattr(exc, "status", None)
    if status_code in (401, 403):
        return "Hindsight rejected the API key."
    if isinstance(status_code, int) and status_code >= 400:
        return f"Hindsight returned HTTP {status_code}."
    return f"Could not reach Hindsight at {base_url}. Check the URL and that it is running."


# --- Compaction defaults ------------------------------------------------------


@router.get("/compaction", response_model=CompactionDefaultsRead)
async def get_compaction_defaults(
    session: AsyncSession = Depends(get_session),
) -> CompactionDefaultsRead:
    """The compaction settings an agent with no override of its own runs on.

    Reads the *effective* values off the running process (a saved value was
    applied there on startup or on save), plus where each came from and what a
    reset would restore. Read by the Settings section that edits them and by the
    agent/subagent forms, which show them as the value an unset field resolves to.
    """
    _capture_env_baseline()
    cfg = await _get_config(session)
    current = get_settings()
    env_threshold, env_ratio = _env_compaction or (
        current.default_compaction_threshold,
        current.default_compaction_ratio,
    )
    # The model is read straight off the row rather than the running process: every
    # consumer (the run builder and the ``/compact`` endpoint) loads ``AppConfig``
    # for the run anyway, so there is nothing to push into ``Settings`` — which
    # makes ``settings.default_compaction_model`` always the environment's value.
    saved_model = cfg.compaction_model if cfg else None
    env_model = current.default_compaction_model
    return CompactionDefaultsRead(
        threshold=current.default_compaction_threshold,
        ratio=current.default_compaction_ratio,
        model=saved_model or env_model,
        threshold_source=(
            "database" if cfg and cfg.compaction_threshold is not None else "env"
        ),
        ratio_source="database" if cfg and cfg.compaction_ratio is not None else "env",
        model_source="database" if saved_model else "env",
        env_threshold=env_threshold,
        env_ratio=env_ratio,
        env_model=env_model,
    )


@router.put("/compaction", response_model=CompactionDefaultsRead)
async def set_compaction_defaults(
    payload: CompactionDefaultsUpdate, session: AsyncSession = Depends(get_session)
) -> CompactionDefaultsRead:
    """Save the app-wide compaction defaults, effective immediately.

    Partial: each knob is only touched when the request actually carries it, and a
    present-but-null value clears that knob back to the environment default. The
    two fractions are pushed into the running process, so the next run compacts on
    them without a restart — agents with their own override are unaffected. The
    summarizer model needs no push: the run builder reads it off this row.
    """
    _capture_env_baseline()
    cfg = await _get_config(session)
    if cfg is None:
        cfg = AppConfig()
    sent = payload.model_fields_set
    if "threshold" in sent:
        cfg.compaction_threshold = payload.threshold
    if "ratio" in sent:
        cfg.compaction_ratio = payload.ratio
    if "model" in sent:
        # Blank is a clear, not a saved empty string: an empty model would resolve
        # to nothing at build time and the summarizer would have no model at all.
        cfg.compaction_model = (payload.model or "").strip() or None
    session.add(cfg)
    await session.commit()

    _apply_compaction(cfg.compaction_threshold, cfg.compaction_ratio)
    return await get_compaction_defaults(session)


# --- Default agent per command ------------------------------------------------
# Maps a slash command name to the agent that command runs under. Kept as an open
# map (command name -> agent id) rather than a fixed schema, so adding a command
# needs no backend change — the frontend registry is the source of truth for
# which commands exist. `/plan` reassigns the thread to its agent; `/ask`/`/goal`
# run one-off under their agent (a per-turn override, see chat.py); `chat` seeds a
# new conversation. Values are agent ids; a blank value clears a command's default.


@router.get("/default-agents", response_model=dict[str, str])
async def get_default_agents(session: AsyncSession = Depends(get_session)) -> dict[str, str]:
    cfg = await _get_config(session)
    stored = (cfg.default_agents if cfg else None) or {}
    return {k: v for k, v in stored.items() if isinstance(v, str) and v}


@router.put("/default-agents", response_model=dict[str, str])
async def set_default_agents(
    payload: dict[str, str] = Body(...),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    cfg = await _get_config(session)
    if cfg is None:
        cfg = AppConfig()

    # JSON columns don't track in-place mutation; rebuild and reassign. Only the
    # commands present in the payload are touched, so each can be saved
    # independently; a blank value drops the key (no default agent for it).
    updated = dict(cfg.default_agents or {})
    for command, value in payload.items():
        cleaned = (value or "").strip()
        if cleaned:
            updated[command] = cleaned
        else:
            updated.pop(command, None)
    cfg.default_agents = updated

    session.add(cfg)
    await session.commit()
    return await get_default_agents(session)
