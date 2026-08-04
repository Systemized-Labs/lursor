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

Everything is scoped to a :class:`~app.db.models.LaiosConnection` and reaches the
gateway through :func:`~app.api.laios.gateway_base`, which resolves both direct
(``:4000``) and lastway-tunnelled (apex root) topologies. Nothing here knows
which of the two it is talking to.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app import media_store
from app.api.laios import gateway_base, load_connection
from app.db.models import LaiosConnection, VideoJob
from app.db.session import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/laios/connections", tags=["videos"])

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


def _unreachable(conn: LaiosConnection, exc: Exception) -> HTTPException:
    logger.warning("laios gateway for %r unreachable: %s", conn.name, exc)
    return HTTPException(
        status.HTTP_502_BAD_GATEWAY,
        f"could not reach the inference gateway for {conn.name} — "
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


def _to_read(job: VideoJob) -> dict[str, Any]:
    return {
        "id": job.id,
        "connection_id": job.connection_id,
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


async def _row(cid: str, job_id: str, session: AsyncSession) -> VideoJob:
    result = await session.execute(
        select(VideoJob).where(
            VideoJob.connection_id == cid, VideoJob.job_id == job_id
        )
    )
    job = result.scalars().first()
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "video job not found")
    return job


@router.get("/{cid}/videos")
async def list_videos(cid: str, session: AsyncSession = Depends(get_session)):
    """Every job we've submitted to this connection, newest first.

    Served from our own table rather than the gateway: the engine's own
    ``GET /v1/videos`` is deliberately not proxied by laios (across several
    backends it would have to be merged rather than routed), and our rows outlive
    the gateway's in-memory map anyway.

    Non-terminal rows are refreshed first (see :func:`_refresh_active`). Nothing
    advances a job server-side, so without this a run whose submitter went away —
    an agent that was stopped, a browser tab that was closed — sits at ``queued``
    forever while the box happily finishes the render. Opening this list is what
    reconciles it.
    """
    result = await session.execute(
        select(VideoJob)
        .where(VideoJob.connection_id == cid)
        .order_by(VideoJob.created_at.desc())
    )
    jobs = list(result.scalars().all())
    await _refresh_active(cid, jobs, session)
    return [_to_read(job) for job in jobs]


async def _refresh_active(
    cid: str, jobs: list[VideoJob], session: AsyncSession
) -> None:
    """Poll every non-terminal row on this connection and fold in what came back.

    Bounded by the rows themselves rather than by a cap: a job runs for minutes, so
    "active" is a handful at most, and a silent cap here would read as "these are
    up to date" when some of them weren't. Every failure leaves the row alone —
    an unreachable box means we don't know yet, not that the job died.
    """
    active = [job for job in jobs if job.status not in TERMINAL]
    if not active:
        return

    try:
        conn = await load_connection(cid, session)
        client = await _gateway(conn)
    except HTTPException:
        # No such connection, or no usable gateway base. Listing the history must
        # still work — that is the surface where the operator would notice.
        return

    changed = False
    async with client:
        for job in active:
            try:
                resp = await client.get(f"/videos/{job.job_id}")
            except (httpx.TimeoutException, httpx.RequestError) as exc:
                logger.debug("refreshing %s: gateway unreachable: %s", job.job_id, exc)
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


@router.post("/{cid}/videos", status_code=status.HTTP_201_CREATED)
async def create_video(
    cid: str, body: dict, session: AsyncSession = Depends(get_session)
):
    """Submit a generation and record the job the gateway hands back.

    ``body`` is the engine's schema and is relayed as given — ``model``,
    ``prompt``, ``task``, ``target{short_edge,aspect_ratio,duration_seconds}``,
    ``num_inference_steps``, ``seed``. We read ``model``/``prompt``/``task`` only
    to label the row.

    First/last-frame conditioning (``task: "fl2va"``) rides the same JSON path: the
    keyframes are ``conditions`` entries whose ``uri`` may be a ``data:`` URI, so
    nothing here needs a multipart branch and an off-box Lursor can still supply
    frames the engine never had on disk. Only the *stored* body differs — see
    :func:`_storable_request`.
    """
    model = str(body.get("model") or "").strip()
    if not model:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "model is required")

    conn = await load_connection(cid, session)
    try:
        async with await _gateway(conn) as client:
            resp = await client.post("/videos", json=body)
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT, "submitting the video job timed out"
        ) from exc
    except httpx.RequestError as exc:
        raise _unreachable(conn, exc) from exc

    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, _gateway_error_detail(resp))

    try:
        created = resp.json()
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "gateway returned a non-JSON job"
        ) from exc

    job_id = str(created.get("id") or "").strip()
    if not job_id:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "gateway accepted the job but returned no id"
        )

    job = VideoJob(
        connection_id=cid,
        job_id=job_id,
        model=model,
        prompt=str(body.get("prompt") or ""),
        task=str(body.get("task") or ""),
        request=_storable_request(body),
        status=str(created.get("status") or "queued"),
        progress=_as_float(created.get("progress")),
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)
    return _to_read(job)


@router.get("/{cid}/videos/{job_id}")
async def video_status(
    cid: str, job_id: str, session: AsyncSession = Depends(get_session)
):
    """Poll the gateway and fold the result into our row.

    A job already in a terminal state is answered from the row without touching
    the network — polling a finished clip forever is how a page left open becomes
    load on the box.
    """
    job = await _row(cid, job_id, session)
    if job.status in TERMINAL:
        return _to_read(job)

    conn = await load_connection(cid, session)
    try:
        async with await _gateway(conn) as client:
            resp = await client.get(f"/videos/{job_id}")
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT, "polling the video job timed out"
        ) from exc
    except httpx.RequestError as exc:
        raise _unreachable(conn, exc) from exc

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


@router.delete("/{cid}/videos/{job_id}")
async def cancel_video(
    cid: str, job_id: str, session: AsyncSession = Depends(get_session)
):
    """Cancel a running job. Keeps the row so the attempt stays in the history."""
    job = await _row(cid, job_id, session)
    conn = await load_connection(cid, session)
    try:
        async with await _gateway(conn) as client:
            resp = await client.delete(f"/videos/{job_id}")
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT, "cancelling the video job timed out"
        ) from exc
    except httpx.RequestError as exc:
        raise _unreachable(conn, exc) from exc

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

    conn = await load_connection(job.connection_id, session)
    try:
        async with await _gateway(conn, timeout=_CONTENT_TIMEOUT) as client:
            resp = await client.get(
                f"/videos/{job.job_id}/content", params={"variant": variant}
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT, "downloading the clip timed out"
        ) from exc
    except httpx.RequestError as exc:
        raise _unreachable(conn, exc) from exc

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


@router.get("/{cid}/videos/{job_id}/content")
async def video_content(
    cid: str,
    job_id: str,
    variant: int = 0,
    session: AsyncSession = Depends(get_session),
):
    """Serve the finished mp4, fetching it from the gateway the first time.

    Returned as a file response so the browser can range-request it and the
    ``<video>`` element can seek.
    """
    job = await _row(cid, job_id, session)
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
    """Fold a gateway status body into the row, leaving unknown fields alone."""
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


def _as_float(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None
