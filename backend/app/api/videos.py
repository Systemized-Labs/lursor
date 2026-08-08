"""Audio-video generation against a laios gateway's ``/v1/videos``.

Chat is one synchronous call; generating a clip is not. MiniMax-H3 (the first
``capabilities: [video]`` recipe) takes ~44 s per denoise step, so laios exposes
a job API on the same inference origin as chat — submit, poll, download, cancel —
and relays the engine's own request schema unaltered.

This module is a proxy in the same spirit: it does not invent a request shape.
``request`` is passed through to the gateway as sent, so a new engine knob works
here the day it works there. What it adds is the two things the gateway
deliberately does not do:

* **Durability.** The gateway binds job id → upstream in memory, capped at the
  last 1024 jobs, so a restart mid-generation loses the binding. The
  :class:`~app.db.models.VideoJob` row is the record of what we asked for, which
  also gives a history of test runs to compare.
* **The clip.** ``/v1/videos/{id}/content`` is fetched once and stored
  content-addressed in the media store, so replaying a result does not re-pull
  it through the tunnel.

The laios path reaches the gateway through :func:`~app.api.laios.gateway_base`,
which resolves both direct (``:4000``) and lastway-tunnelled (apex root)
topologies. Nothing here knows which of the two it is talking to.

**OpenRouter is the second source**, selected app-wide in Settings (see
``AppConfig.video_source``). Its job API has the same four verbs, so the shape of
this module carries over and the provider branch lives in the four functions that
actually touch the network. Two things genuinely differ, and both are visible to
the user rather than papered over:

* **The clip is downloaded eagerly**, on the poll that first sees ``completed``,
  instead of on first view. ``unsigned_urls`` expire. Deferring is right for a box
  — the mp4 stays on the box, and pulling it through a tunnel is the expensive
  part — but here it would mean a clip somebody paid for becoming unreachable
  because they closed the tab. ``content_url`` stays on the row as the retry
  handle, and :func:`stored_clip`'s lazy path still covers an eager fetch that
  failed.
* **There is no cancel.** OpenRouter's job API has none, so
  :func:`cancel_video` marks the row locally and says plainly that the render
  continues and will still be billed. Reporting a cancel that did not happen
  would be the worse failure.

**A custom provider is the third source**, and it costs almost nothing here.
A user-added OpenAI-compatible endpoint speaks the same ``/videos`` job API on the
same ``/v1`` root, so submit, poll, cancel and download are literally the laios
code path with a different client — which is what :func:`_endpoint` exists to
hand back. The branch is one line in four places, and the error unwrapping,
durability and media store are shared unchanged. What is *not* shared is how its
models are found and what request shape they are driven with; see
``app/media/custom.py`` and ``video_runtime._resolve_custom``.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app import media_store
from app.api.laios import gateway_base, load_connection
from app.db.models import AppConfig, LaiosConnection, VideoJob
from app.db.session import get_session
from app.media import custom as custom_media
from app.media import openrouter as openrouter_media
from app.media import refs

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/media/videos", tags=["videos"])

# The capability probe answers "can this app generate video at all", which is a
# question about the configured source rather than about one connection, so it
# keeps its own router and its own stable path.
capability_router = APIRouter(prefix="/video", tags=["videos"])


@capability_router.get("/capability")
async def video_capability(session: AsyncSession = Depends(get_session)):
    """Whether the configured source can generate video, and what would be used.

    Exists for the agent editor. The ``include_video`` toggle is gated on the
    source actually being able to serve a model this build can drive
    (``agents/video_runtime.py``), and a checkbox that silently does nothing is
    indistinguishable from a broken one — so the editor states which model it
    would reach, or why it would reach none.

    Shares the resolver's caches, so opening the dialog costs no round trip once a
    run has already resolved.
    """
    from app.agents.video_runtime import resolve_video_target

    runtime, reason = await resolve_video_target(session)
    return {
        "available": runtime is not None,
        "source": runtime.provider if runtime else None,
        "model": runtime.model if runtime else None,
        "connection_name": runtime.connection_name if runtime else None,
        # True when something about the model was inferred rather than declared:
        # on laios, its request shape (from the model's identity); on a custom
        # provider, that it is a video model at all (from its name). Both are the
        # case where Lursor is trusting a guess instead of a declaration, and both
        # are worth saying out loud. Never true on OpenRouter, whose catalogue is
        # the declaration.
        "assumed": bool(runtime.assumed) if runtime else False,
        "price": _price(runtime.price) if runtime else None,
        "pinned": runtime.pinned if runtime else False,
        "reason": reason,
    }


def _price(quote) -> dict[str, Any] | None:
    """A :class:`PriceQuote` as JSON, or null when no rate is published."""
    if quote is None:
        return None
    return {
        "amount": quote.amount,
        "unit": quote.unit,
        "approximate": quote.approximate,
    }


# Declared before ``/{job_id}`` — a literal route in the same path space as a
# parameterized one must come first (AGENTS.md invariant 7).
@router.get("/models")
async def list_video_models(
    source: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
):
    """Every video model the given source offers, with its constraints and rate.

    Unlike images, video resolves to a single target rather than a set — the
    request shape is per-model on laios, so "which one can we drive" has one right
    answer. The list is therefore built from the catalogue on OpenRouter and from
    the drivable served models on laios, and both are rendered the same way.
    """
    from app.agents.video_runtime import resolve_video_target

    if source is None:
        cfg = (await session.execute(select(AppConfig))).scalars().first()
        source = (cfg.video_source if cfg else None) or refs.LAIOS
    try:
        wanted = refs.parse_source(source)
    except refs.RefError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    runtime, reason = await resolve_video_target(session)
    if runtime is None or runtime.provider != wanted.provider:
        return {
            "source": wanted.provider,
            "available": False,
            "reason": reason,
            "models": [],
        }

    if runtime.is_openrouter:
        observed = await _observed_video_costs(session)
        catalogue = await openrouter_media.video_models()
        models = [
            {
                "ref": refs.format_model_ref(refs.OPENROUTER, entry.slug),
                "id": entry.slug,
                "label": entry.label,
                "provider": refs.OPENROUTER,
                "note": entry.note,
                "price": _price(entry.price),
                "observed_cost": observed.get(entry.slug),
                "connection_name": "OpenRouter",
                "custom": None,
                "resolutions": list(entry.resolutions),
                "aspect_ratios": list(entry.aspect_ratios),
                "sizes": list(entry.sizes),
                "durations": list(entry.durations),
                "keyframes": entry.keyframes,
                "audio": entry.audio,
                "seed": entry.seed,
            }
            for entry in catalogue
        ]
    else:
        # laios and a custom provider each resolve to one drivable target, so the
        # list is that target.
        constraints = runtime.constraints
        note = f"driven as {runtime.request_schema}"
        if runtime.custom is not None and not runtime.custom.declared:
            note = f"matched by name, {note}"
        models = [
            {
                "ref": runtime.ref,
                "id": runtime.model,
                "label": runtime.label,
                "provider": runtime.provider,
                "note": note,
                "price": None,
                "observed_cost": None,
                "connection_name": runtime.connection_name,
                "custom": {"declared": runtime.custom.declared}
                if runtime.custom
                else None,
                "resolutions": [],
                "aspect_ratios": list(constraints.aspect_ratios),
                "sizes": list(constraints.sizes.values()),
                "durations": [],
                "keyframes": constraints.keyframes,
                "audio": constraints.emits_audio,
                "seed": True,
            }
        ]

    return {
        "source": runtime.provider,
        "available": True,
        "reason": reason,
        "models": models,
    }


async def _observed_video_costs(session: AsyncSession) -> dict[str, float]:
    from app.media.history import observed_video_costs

    return await observed_video_costs(session, refs.OPENROUTER)

# Submitting and polling are fast — the generation itself happens on the box and
# is observed by polling, so no request here waits on a clip.
_DEFAULT_TIMEOUT = httpx.Timeout(30.0)

# Downloading the finished mp4 is the one call with a real payload. A 15s 768p
# H.264 clip is single-digit MB, but through a tunnel on a slow link that is
# still worth more than 30s.
_CONTENT_TIMEOUT = httpx.Timeout(300.0, connect=30.0)

# Statuses the engine reports for a job that will not change again.
TERMINAL = frozenset({"completed", "failed", "cancelled", "canceled"})


async def _gateway(
    conn: LaiosConnection, timeout: httpx.Timeout | None = None
) -> httpx.AsyncClient:
    """Client bound to this connection's inference gateway.

    The gateway authenticates the same ``master_key`` the control plane does, and
    it is held server-side — the browser never sees it.
    """
    base = await gateway_base(conn)
    if not base:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "connection has no usable base URL for its inference gateway",
        )
    headers = {"Accept": "application/json"}
    if conn.master_key:
        headers["Authorization"] = f"Bearer {conn.master_key}"
    return httpx.AsyncClient(
        base_url=base.rstrip("/"), headers=headers, timeout=timeout or _DEFAULT_TIMEOUT
    )


async def _endpoint(
    provider: str,
    endpoint_id: str,
    session: AsyncSession,
    timeout: httpx.Timeout | None = None,
) -> tuple[httpx.AsyncClient, str]:
    """A client for whichever kind of endpoint owns this job, plus its name.

    laios and a custom provider are both ``/v1``-rooted OpenAI-compatible origins
    speaking the same four-verb job API, so everything above this — submit, poll,
    cancel, download, and the error unwrapping — is one code path with one branch
    at the bottom. Only the credential and the base URL differ.

    :func:`_gateway` is still called by name rather than inlined: it is the seam the
    tests replace to run this module against a fake box.
    """
    if provider == refs.CUSTOM:
        record = await custom_media.load_provider(session, endpoint_id)
        return custom_media.client(record, timeout=timeout or _DEFAULT_TIMEOUT), (
            record.name
        )
    conn = await load_connection(endpoint_id, session)
    return await _gateway(conn, timeout=timeout), conn.name


def _unreachable(name: str, exc: Exception) -> HTTPException:
    logger.warning("inference gateway for %r unreachable: %s", name, exc)
    return HTTPException(
        status.HTTP_502_BAD_GATEWAY,
        f"could not reach the inference gateway for {name} — "
        "is the model serving, and the tunnel up?",
    )


def _gateway_error_detail(resp: httpx.Response) -> str:
    """Unwrap whichever error shape the gateway used.

    There are two, and only one of them used to be handled:

    * ``{"error": {"code", "message"}}`` — the gateway's own OpenAI-shaped errors
      (no such job, no backend holding it).
    * ``{"detail": ...}`` — FastAPI's default, which is what the engine's own
      request validation returns. Every per-model constraint arrives this way:
      ``target.short_edge must be 768 for minimax_h3, got 1080``.

    Missing the second one turned a precise, actionable message into
    "gateway returned HTTP 400" — the operator was told a request was rejected
    but not which knob or what value would work. ``detail`` may also be a list
    (FastAPI emits one per invalid field), so those are joined rather than
    stringified as a Python repr.
    """
    try:
        body = resp.json()
    except ValueError:
        return f"gateway returned HTTP {resp.status_code}"
    if not isinstance(body, dict):
        return f"gateway returned HTTP {resp.status_code}"

    err = body.get("error")
    if isinstance(err, dict):
        code = err.get("code")
        msg = err.get("message") or ""
        return f"{msg} ({code})" if code else msg or f"HTTP {resp.status_code}"

    detail = body.get("detail")
    if isinstance(detail, str) and detail.strip():
        return detail
    if isinstance(detail, list):
        parts = []
        for item in detail:
            if isinstance(item, dict):
                # Pydantic's shape: locate the field, then say what was wrong.
                loc = ".".join(str(p) for p in item.get("loc", []) if p != "body")
                msg = item.get("msg") or ""
                parts.append(f"{loc}: {msg}" if loc and msg else msg or str(item))
            else:
                parts.append(str(item))
        joined = "; ".join(p for p in parts if p)
        if joined:
            return joined

    return f"gateway returned HTTP {resp.status_code}"


# Public name for the unwrapper above: ``api/images.py`` proxies the same gateway
# and gets the same two error shapes back, so it wants the same translation. Aliased
# rather than moved because the tests monkeypatch this module's ``_gateway`` seam and
# the two proxies are otherwise independent (same idiom as ``laios.load_connection``).
gateway_error_detail = _gateway_error_detail


def _to_read(job: VideoJob) -> dict[str, Any]:
    return {
        "id": job.id,
        "provider": job.provider,
        "connection_id": job.connection_id,
        "cost_usd": job.cost_usd,
        "job_id": job.job_id,
        "model": job.model,
        "prompt": job.prompt,
        "task": job.task,
        "request": job.request,
        "status": job.status,
        "progress": job.progress,
        "error": job.error,
        "media_id": job.media_id,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
    }


def _storable_request(body: dict[str, Any]) -> dict[str, Any]:
    """The request as submitted, minus any inlined frame bytes.

    A ``fl2va`` submission carries its keyframes inside the body as base64 ``data:``
    URIs — a megabyte or two each. The row exists to record *what was asked for* and
    to feed the page's "reuse", and neither needs the pixels: the engine has them,
    and the workspace file they came from is where the operator would look. Storing
    them would put a multi-megabyte string in every history response.

    The elision is a visible descriptor rather than a dropped key, because a
    ``conditions`` entry with no ``uri`` would read as a request that never had one.
    """
    conditions = body.get("conditions")
    if not isinstance(conditions, list):
        return body

    stored: list[Any] = []
    elided = False
    for entry in conditions:
        if not isinstance(entry, dict):
            stored.append(entry)
            continue
        uri = entry.get("uri")
        if isinstance(uri, str) and uri.startswith(("data:", "base64://")):
            elided = True
            head = uri.split(",", 1)[0]
            media_type = head[5:].split(";", 1)[0] if head.startswith("data:") else ""
            entry = {
                **entry,
                "uri": f"<inline {media_type or 'image'}, {len(uri)} chars not stored>",
            }
        stored.append(entry)
    if not elided:
        return body
    return {**body, "conditions": stored}


async def _row(job_id: str, session: AsyncSession) -> VideoJob:
    result = await session.execute(select(VideoJob).where(VideoJob.job_id == job_id))
    job = result.scalars().first()
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "video job not found")
    return job


@router.get("")
async def list_videos(
    source: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
):
    """Every job we've submitted, newest first.

    Served from our own table rather than the gateway: the engine's own
    ``GET /v1/videos`` is deliberately not proxied by laios (across several
    backends it would have to be merged rather than routed), and our rows outlive
    the gateway's in-memory map anyway.

    Non-terminal rows are refreshed first (see :func:`_refresh_active`). Nothing
    advances a job server-side, so without this a run whose submitter went away —
    an agent that was stopped, a browser tab that was closed — sits at ``queued``
    forever while the box (or OpenRouter) happily finishes the render. Opening
    this list is what reconciles it.

    ``source`` filters; omitting it returns everything. As with images, switching
    the source in Settings does not hide the history made under the previous one.
    """
    query = select(VideoJob).order_by(VideoJob.created_at.desc())
    if source:
        try:
            wanted = refs.parse_source(source)
        except refs.RefError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        query = query.where(VideoJob.provider == wanted.provider)
        if wanted.connection_id:
            query = query.where(VideoJob.connection_id == wanted.connection_id)

    jobs = list((await session.execute(query)).scalars().all())
    await _refresh_active(jobs, session)
    return [_to_read(job) for job in jobs]


async def _refresh_active(jobs: list[VideoJob], session: AsyncSession) -> None:
    """Poll every non-terminal row and fold in what came back.

    Bounded by the rows themselves rather than by a cap: a job runs for minutes, so
    "active" is a handful at most, and a silent cap here would read as "these are
    up to date" when some of them weren't. Every failure leaves the row alone —
    an unreachable upstream means we don't know yet, not that the job died.

    Grouped by endpoint so one client serves all of that box's (or provider's) rows,
    and so an endpoint that is down short-circuits its own group without stalling
    the others.
    """
    active = [job for job in jobs if job.status not in TERMINAL]
    if not active:
        return

    changed = False
    for job in [j for j in active if j.provider == refs.OPENROUTER]:
        changed |= await _refresh_openrouter(job, session)

    # Keyed on (provider, endpoint) rather than the endpoint alone: a laios
    # connection id and a custom provider id are different id spaces, and nothing
    # stops them colliding.
    by_endpoint: dict[tuple[str, str], list[VideoJob]] = {}
    for job in active:
        if job.provider != refs.OPENROUTER:
            by_endpoint.setdefault((job.provider, job.connection_id), []).append(job)

    for (provider, endpoint_id), group in by_endpoint.items():
        try:
            client, _name = await _endpoint(provider, endpoint_id, session)
        except HTTPException:
            # No such connection or provider, or no usable base URL. Listing the
            # history must still work — that is the surface where the operator
            # would notice.
            continue
        async with client:
            for job in group:
                try:
                    resp = await client.get(f"/videos/{job.job_id}")
                except (httpx.TimeoutException, httpx.RequestError) as exc:
                    logger.debug(
                        "refreshing %s: gateway unreachable: %s", job.job_id, exc
                    )
                    break  # the box is down; the rest would fail the same way
                if resp.status_code == status.HTTP_404_NOT_FOUND:
                    job.status = "failed"
                    job.error = "the gateway no longer knows this job id"
                elif resp.status_code >= 400:
                    continue
                else:
                    _apply(job, resp.json())
                session.add(job)
                changed = True

    if changed:
        await session.commit()


async def _refresh_openrouter(job: VideoJob, session: AsyncSession) -> bool:
    """Poll one hosted job, pulling the clip down if it just finished.

    Returns whether the row changed. Failures are swallowed for the same reason
    the laios path swallows them — a list that 500s because one upstream blinked
    is worse than a list with one stale row.
    """
    try:
        payload = await openrouter_media.poll_video(job.job_id)
    except (openrouter_media.OpenRouterMediaError, httpx.HTTPError) as exc:
        logger.debug("refreshing %s: openrouter unreachable: %s", job.job_id, exc)
        return False
    _apply(job, payload)
    await _fetch_finished_clip(job, session)
    session.add(job)
    return True


async def _fetch_finished_clip(job: VideoJob, session: AsyncSession) -> None:
    """Pull an OpenRouter clip the moment it completes. See the module docstring.

    A failure here is not fatal: ``content_url`` stays on the row, and
    :func:`stored_clip` will retry on first view. It is only the *timing* that is
    eager — the URL may still be alive then, and if it is not, at least the row
    says what was attempted.
    """
    if job.media_id or job.status != "completed" or not job.content_url:
        return
    try:
        data, content_type = await openrouter_media.download(job.content_url)
        job.media_id = media_store.save_video(data, content_type or "video/mp4")
    except (openrouter_media.OpenRouterMediaError, httpx.HTTPError, ValueError) as exc:
        logger.warning("could not download clip for %s: %s", job.job_id, exc)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_video(body: dict, session: AsyncSession = Depends(get_session)):
    """Submit a generation and record the job the upstream hands back.

    ``body`` is the provider's schema and is relayed as given. On laios that is
    ``model``, ``prompt``, ``task``, ``target{short_edge,aspect_ratio,duration_seconds}``,
    ``num_inference_steps``, ``seed``; on OpenRouter it is ``model``, ``prompt``,
    ``duration``, ``resolution``/``size``, ``aspect_ratio``, ``frame_images``,
    ``generate_audio``, ``seed``. We read ``model``/``prompt``/``task`` only to
    label the row. ``source`` is ours and is stripped before submitting.

    First/last-frame conditioning rides the same JSON path on both: the keyframes
    are ``data:`` URIs in the body, so nothing here needs a multipart branch and an
    off-box Lursor can still supply frames the engine never had on disk. Only the
    *stored* body differs — see :func:`_storable_request`.
    """
    model = str(body.get("model") or "").strip()
    if not model:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "model is required")

    try:
        ref = refs.parse_model_ref(model) if ":" in model else None
        if ref is not None:
            source = ref.source
            model = ref.model
        else:
            raw_source = body.get("source")
            if raw_source is None:
                cfg = (await session.execute(select(AppConfig))).scalars().first()
                raw_source = (cfg.video_source if cfg else None) or refs.LAIOS
            source = refs.parse_source(str(raw_source))
    except refs.RefError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    request = {k: v for k, v in body.items() if k != "source"}
    request["model"] = model

    if source.is_openrouter:
        created = await _submit_openrouter(request)
        connection_id = ""
    elif source.is_custom:
        connection_id = source.connection_id or await _only_provider(session)
        created = await _submit_endpoint(refs.CUSTOM, connection_id, request, session)
    else:
        connection_id = source.connection_id or await _only_connection(session)
        created = await _submit_endpoint(refs.LAIOS, connection_id, request, session)

    job = VideoJob(
        provider=source.provider,
        connection_id=connection_id,
        job_id=str(created.get("id")),
        model=model,
        prompt=str(body.get("prompt") or ""),
        task=str(body.get("task") or ""),
        request=_storable_request(request),
        status=str(created.get("status") or "queued"),
        progress=_as_float(created.get("progress")),
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)
    return _to_read(job)


async def _submit_openrouter(request: dict[str, Any]) -> dict[str, Any]:
    if not openrouter_media.configured():
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "no OpenRouter API key is set — add one in Settings → Providers",
        )
    try:
        return await openrouter_media.submit_video(request)
    except openrouter_media.OpenRouterMediaError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT, "submitting the video job timed out"
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "could not reach OpenRouter"
        ) from exc


async def _submit_endpoint(
    provider: str, endpoint_id: str, request: dict[str, Any], session: AsyncSession
) -> dict[str, Any]:
    """Submit to a laios box or a custom provider — the same call either way."""
    client, name = await _endpoint(provider, endpoint_id, session)
    try:
        async with client:
            resp = await client.post("/videos", json=request)
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT, "submitting the video job timed out"
        ) from exc
    except httpx.RequestError as exc:
        raise _unreachable(name, exc) from exc

    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, _gateway_error_detail(resp))

    try:
        created = resp.json()
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "gateway returned a non-JSON job"
        ) from exc

    if not str(created.get("id") or "").strip():
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "gateway accepted the job but returned no id"
        )
    return created


async def _only_connection(session: AsyncSession) -> str:
    """The connection a bare ``laios`` source means, when there is just one.

    Same argument as ``images._only_connection``: unambiguous for resolution,
    ambiguous for submission, and picking a box to spend minutes of its GPU is not
    a guess worth making silently.
    """
    connections = list(
        (
            await session.execute(
                select(LaiosConnection).order_by(LaiosConnection.created_at)
            )
        )
        .scalars()
        .all()
    )
    if not connections:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "no laios connection is configured"
        )
    if len(connections) > 1:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "several laios connections are configured — name one, as "
            f"'laios:{connections[0].id}'",
        )
    return connections[0].id


async def _only_provider(session: AsyncSession) -> str:
    """The custom provider a bare ``custom`` source means, when there is one."""
    providers = await custom_media.media_providers(session)
    if not providers:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "no custom provider is configured"
        )
    if len(providers) > 1:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "several custom providers are configured — name one, as "
            f"'custom:{providers[0].id}'",
        )
    return providers[0].id


@router.get("/{job_id}")
async def video_status(job_id: str, session: AsyncSession = Depends(get_session)):
    """Poll the upstream and fold the result into our row.

    A job already in a terminal state is answered from the row without touching
    the network — polling a finished clip forever is how a page left open becomes
    load on the box (or a stream of requests at OpenRouter).
    """
    job = await _row(job_id, session)
    if job.status in TERMINAL:
        return _to_read(job)

    if job.provider == refs.OPENROUTER:
        try:
            payload = await openrouter_media.poll_video(job.job_id)
        except openrouter_media.OpenRouterMediaError as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
        except httpx.TimeoutException as exc:
            raise HTTPException(
                status.HTTP_504_GATEWAY_TIMEOUT, "polling the video job timed out"
            ) from exc
        except httpx.RequestError as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "could not reach OpenRouter"
            ) from exc
        _apply(job, payload)
        await _fetch_finished_clip(job, session)
        session.add(job)
        await session.commit()
        await session.refresh(job)
        return _to_read(job)

    client, name = await _endpoint(job.provider, job.connection_id, session)
    try:
        async with client:
            resp = await client.get(f"/videos/{job_id}")
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT, "polling the video job timed out"
        ) from exc
    except httpx.RequestError as exc:
        raise _unreachable(name, exc) from exc

    # A 404 here is meaningful rather than fatal: the gateway forgot the job (its
    # map is bounded and in-memory) or the box was restarted. Record it instead
    # of leaving the row polling forever.
    if resp.status_code == status.HTTP_404_NOT_FOUND:
        job.status = "failed"
        job.error = "the gateway no longer knows this job id"
        session.add(job)
        await session.commit()
        await session.refresh(job)
        return _to_read(job)

    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, _gateway_error_detail(resp))

    _apply(job, resp.json())
    session.add(job)
    await session.commit()
    await session.refresh(job)
    return _to_read(job)


@router.delete("/{job_id}")
async def cancel_video(job_id: str, session: AsyncSession = Depends(get_session)):
    """Cancel a running job. Keeps the row so the attempt stays in the history.

    On OpenRouter there is nothing to cancel — the job API has no such verb — so
    the row is marked locally and the response says plainly that the render
    continues and will still be billed. Reporting a cancel that did not happen
    would be the more expensive lie.
    """
    job = await _row(job_id, session)

    if job.provider == refs.OPENROUTER:
        job.status = "cancelled"
        job.error = (
            "stopped tracking this job — OpenRouter has no cancel, so the render "
            "continues and will still be billed."
        )
        session.add(job)
        await session.commit()
        await session.refresh(job)
        return _to_read(job)

    client, name = await _endpoint(job.provider, job.connection_id, session)
    try:
        async with client:
            resp = await client.delete(f"/videos/{job_id}")
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT, "cancelling the video job timed out"
        ) from exc
    except httpx.RequestError as exc:
        raise _unreachable(name, exc) from exc

    # Already gone upstream is the outcome we wanted, not an error.
    if resp.status_code >= 400 and resp.status_code != status.HTTP_404_NOT_FOUND:
        raise HTTPException(resp.status_code, _gateway_error_detail(resp))

    job.status = "cancelled"
    session.add(job)
    await session.commit()
    await session.refresh(job)
    return _to_read(job)


async def stored_clip(
    job: VideoJob, session: AsyncSession, variant: int = 0
) -> Path:
    """Local path to this job's finished clip, fetching it once if needed.

    The clip is stored content-addressed in the media store, so a reload — or a
    second look at an old run — is served from disk instead of re-pulling it
    through the tunnel.

    Shared with the agent tools (``agents/video_tools.py``), which materialize the
    same file into the workspace. Raises :class:`HTTPException`, so both callers
    surface the gateway's own message: an HTTP status for the route, and text for
    the tool.
    """
    if variant == 0 and job.media_id:
        path = media_store.video_path(job.media_id)
        if path.is_file():
            return path

    if job.provider == refs.OPENROUTER:
        return await _openrouter_clip(job, session)

    client, name = await _endpoint(
        job.provider, job.connection_id, session, timeout=_CONTENT_TIMEOUT
    )
    try:
        async with client:
            resp = await client.get(
                f"/videos/{job.job_id}/content", params={"variant": variant}
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT, "downloading the clip timed out"
        ) from exc
    except httpx.RequestError as exc:
        raise _unreachable(name, exc) from exc

    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, _gateway_error_detail(resp))

    content_type = resp.headers.get("content-type", "video/mp4")
    try:
        media_id = media_store.save_video(resp.content, content_type)
    except ValueError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    # Only variant 0 is remembered on the row: it is the one the UI plays, and a
    # media_id is a single column rather than a per-variant map.
    if variant == 0 and job.media_id != media_id:
        job.media_id = media_id
        session.add(job)
        await session.commit()

    return media_store.video_path(media_id)


async def _openrouter_clip(job: VideoJob, session: AsyncSession) -> Path:
    """The retry path for a hosted clip whose eager download did not happen.

    Normally unreachable: :func:`_fetch_finished_clip` pulls the bytes on the poll
    that first sees ``completed``, because ``unsigned_urls`` expire. This covers
    the case where that fetch failed (or the process died between the poll and the
    save), and it is also where the expiry surfaces as a message someone can act
    on rather than as a broken video element.
    """
    if not job.content_url:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "OpenRouter reported no download URL for this clip"
            + (f" — it {job.status}" if job.status in TERMINAL else " yet"),
        )
    try:
        data, content_type = await openrouter_media.download(job.content_url)
    except openrouter_media.OpenRouterMediaError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"could not download the clip from OpenRouter ({exc}). Its download "
            "URL expires, and this one may already have.",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "could not reach OpenRouter"
        ) from exc

    try:
        media_id = media_store.save_video(data, content_type or "video/mp4")
    except ValueError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    if job.media_id != media_id:
        job.media_id = media_id
        session.add(job)
        await session.commit()
    return media_store.video_path(media_id)


@router.get("/{job_id}/content")
async def video_content(
    job_id: str,
    variant: int = 0,
    session: AsyncSession = Depends(get_session),
):
    """Serve the finished mp4, fetching it from the upstream the first time.

    Returned as a file response so the browser can range-request it and the
    ``<video>`` element can seek.
    """
    job = await _row(job_id, session)
    path = await stored_clip(job, session, variant)
    return FileResponse(
        path,
        media_type=media_store.mime_for_path(path),
        filename=f"{job_id}.mp4",
        # Passing `filename` alone would make this an attachment, which is wrong
        # for the <video> element that is the main consumer.
        content_disposition_type="inline",
    )


def _apply(job: VideoJob, payload: Any) -> None:
    """Fold an upstream status body into the row, leaving unknown fields alone.

    One function for both sources. ``status``/``progress``/``error`` are spelled
    the same way by each; the last two blocks are OpenRouter-only and are simply
    absent from a laios body, so there is no branch to write.
    """
    if not isinstance(payload, dict):
        return
    if (state := payload.get("status")) is not None:
        job.status = str(state)
    if (progress := _as_float(payload.get("progress"))) is not None:
        job.progress = progress
    # The engine reports failure detail under either key depending on the stage.
    error = payload.get("error") or payload.get("failure_reason")
    if isinstance(error, dict):
        error = error.get("message")
    if error:
        job.error = str(error)

    # OpenRouter: where the clip can be fetched from, and what it cost. The URL
    # expires, which is why the caller downloads on the poll that first sees it
    # rather than on first view (see the module docstring).
    urls = payload.get("unsigned_urls")
    if isinstance(urls, list) and urls and isinstance(urls[0], str):
        job.content_url = urls[0]
    usage = payload.get("usage")
    if isinstance(usage, dict):
        if (cost := _as_float(usage.get("cost"))) is not None:
            job.cost_usd = cost


def _as_float(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None
