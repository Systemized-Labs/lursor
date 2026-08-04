"""Image generation against a laios gateway's ``/v1/images``.

The sibling of ``api/videos.py``, and the differences are all downstream of one
fact: **the image API is synchronous.** A clip is a job — submit, poll, download,
cancel. An image is one call that returns the pixels, in ~6.5 s for
``z-image-turbo`` (6B, 9 distilled steps, no CFG) and ~58–116 s for
``qwen-image-2512`` (20B, and its default 50 steps run CFG, so 100 forward
passes). There is no upstream job id to bind, nothing to poll, and nothing to
cancel.

That leaves a choice about who waits. Holding the browser's request open for the
whole denoise is what the engine does, but it makes a reload mid-generation lose
an image that cost two minutes of someone's GPU. So the wait lives here instead:
:func:`create_image` writes the row, hands the gateway call to a background task
and returns immediately; the page polls the row. The generation survives the tab
closing, exactly as a video job does, and the page's history is complete whether
or not anyone watched.

The cost of that choice is orphans. A ``running`` row is only meaningful while
this process holds a task for it, so a restart mid-generation would leave a row
spinning forever. :func:`_reap_orphans` closes that on the next list — the row is
failed, not silently left pending, because "we do not know what happened to this"
and "this is still working" are different answers.

Two things are *not* passed through, against this module's otherwise strict
relay-it-unaltered stance (see ``api/videos.py``):

* ``response_format`` is forced to ``b64_json``. The engine's default is ``url``,
  which returns a relative ``/v1/images/{id}/content`` whose bytes live in the
  container's own output directory — they do not survive the instance being
  recreated, and the point of this module is a durable history.
* ``n`` is pinned to 1. One row holds one ``media_id``.

Everything else — ``size``, ``num_inference_steps``, ``seed``,
``negative_prompt``, ``true_cfg_scale``, ``output_format`` — is the engine's
schema and is relayed as sent, so a new knob works here the day it works there.
"""

from __future__ import annotations

import asyncio
import base64
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
from app.api.videos import gateway_error_detail
from app.db.models import ImageGeneration, LaiosConnection
from app.db.session import async_session_factory, get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/laios/connections", tags=["images"])

# Our own vocabulary (see :class:`ImageGeneration`), not the engine's — it has no
# job states to report.
TERMINAL = frozenset({"completed", "failed"})

# The one call that actually waits for a GPU. Measured worst case is
# ``qwen-image-2512`` at 50 CFG steps and 1024×1024: 116 s. This leaves room for
# a larger size, a colder cache and a slow tunnel without turning a working
# generation into a timeout.
_GENERATE_TIMEOUT = httpx.Timeout(600.0, connect=30.0)

# Fetching bytes we already know exist, on the ``url`` fallback path below.
_CONTENT_TIMEOUT = httpx.Timeout(120.0, connect=30.0)

# Row id → the task holding its gateway call open. The single source of truth for
# "is this row's generation actually alive", which is what makes orphan reaping
# exact rather than a timeout heuristic. Process-local by design: Lursor runs one
# backend process, and a second one would have its own tasks and its own view of
# which rows they belong to.
_active: dict[str, asyncio.Task[None]] = {}


async def _gateway(
    conn: LaiosConnection, timeout: httpx.Timeout | None = None
) -> httpx.AsyncClient:
    """Client bound to this connection's inference gateway.

    The same resolution ``api/videos.py`` uses, and for the same reason: the
    gateway authenticates the ``master_key`` and it is held server-side, so the
    browser never sees it.

    Deliberately its own copy rather than an import. The default timeout differs by
    an order of magnitude (a video submit returns in milliseconds; an image request
    *is* the render), and this name is the seam the tests replace to run the module
    against a fake gateway.
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
        base_url=base.rstrip("/"), headers=headers, timeout=timeout or _GENERATE_TIMEOUT
    )


def _to_read(row: ImageGeneration) -> dict[str, Any]:
    return {
        "id": row.id,
        "connection_id": row.connection_id,
        "model": row.model,
        "prompt": row.prompt,
        "upstream_id": row.upstream_id,
        "request": row.request,
        "status": row.status,
        "error": row.error,
        "media_id": row.media_id,
        "inference_time_s": row.inference_time_s,
        "peak_memory_mb": row.peak_memory_mb,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


async def _row(cid: str, run_id: str, session: AsyncSession) -> ImageGeneration:
    result = await session.execute(
        select(ImageGeneration).where(
            ImageGeneration.connection_id == cid, ImageGeneration.id == run_id
        )
    )
    row = result.scalars().first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "image generation not found")
    return row


@router.get("/{cid}/images")
async def list_images(cid: str, session: AsyncSession = Depends(get_session)):
    """Every generation submitted to this connection, newest first.

    Read from our own table — the engine keeps no list, and a synchronous API has
    nothing to reconcile against. The one repair is :func:`_reap_orphans`.
    """
    result = await session.execute(
        select(ImageGeneration)
        .where(ImageGeneration.connection_id == cid)
        .order_by(ImageGeneration.created_at.desc())
    )
    rows = list(result.scalars().all())
    await _reap_orphans(rows, session)
    return [_to_read(row) for row in rows]


async def _reap_orphans(rows: list[ImageGeneration], session: AsyncSession) -> None:
    """Fail any ``running`` row this process is not actually generating.

    The only way a row reaches this state is a restart (or a crash) while a
    generation was in flight: the task died with the process, the row did not.
    Nothing will ever advance it, so leaving it at ``running`` would show a
    spinner forever for an image that is never arriving.

    Marked failed rather than deleted — the attempt, its prompt and its settings
    are exactly what the history is for, and "reuse" still works on it. The box
    itself may well have finished the render; we simply no longer have the call
    that would have returned it.
    """
    orphans = [r for r in rows if r.status not in TERMINAL and r.id not in _active]
    if not orphans:
        return
    for row in orphans:
        row.status = "failed"
        row.error = (
            "the backend restarted while this image was generating, so the result "
            "was lost — the box may have finished it. Reuse to run it again."
        )
        session.add(row)
    await session.commit()


@router.post("/{cid}/images", status_code=status.HTTP_201_CREATED)
async def create_image(
    cid: str, body: dict, session: AsyncSession = Depends(get_session)
):
    """Start a generation and return its row immediately.

    The gateway call is *not* awaited here — see the module docstring. What is
    checked first is everything that can fail cheaply and deterministically: the
    model name, the connection, and whether it resolves to a usable gateway. A
    row is only written once the request is one that could plausibly succeed, so
    the history does not fill up with attempts that never left the building.
    """
    model = str(body.get("model") or "").strip()
    if not model:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "model is required")
    if not str(body.get("prompt") or "").strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "prompt is required")

    conn = await load_connection(cid, session)
    if not await gateway_base(conn):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "connection has no usable base URL for its inference gateway",
        )

    # The two overrides, applied to the body that is both sent and stored so the
    # row is a faithful record of the request the engine actually saw.
    request = {**body, "model": model, "response_format": "b64_json", "n": 1}

    row = ImageGeneration(
        connection_id=cid,
        model=model,
        prompt=str(body.get("prompt") or ""),
        request=request,
        status="running",
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)

    # `create_task` only schedules — the body cannot run until this coroutine
    # yields, and there is no await between here and the registration below. That
    # ordering matters: a list arriving with the row `running` but absent from
    # `_active` would reap the generation that is about to start.
    task = asyncio.create_task(_run_generation(row.id, cid, request))
    _active[row.id] = task
    task.add_done_callback(lambda _t, rid=row.id: _active.pop(rid, None))

    return _to_read(row)


async def _run_generation(run_id: str, cid: str, request: dict[str, Any]) -> None:
    """Hold the gateway call open, then fold the result into the row.

    Runs detached from any request, so it owns a session of its own — the one the
    route used is closed by the time this starts. Every exit path writes a
    terminal status: a row left at ``running`` by an unhandled error here is
    exactly the orphan state that has no natural repair.
    """
    try:
        async with async_session_factory() as session:
            try:
                await _generate(run_id, cid, request, session)
            except asyncio.CancelledError:
                # Cancelled by DELETE, which deletes the row on its way out.
                # Nothing to record.
                raise
            except Exception as exc:  # noqa: BLE001 — the row must reach a terminal state
                logger.exception("image generation %s failed", run_id)
                await _fail(run_id, session, str(exc) or exc.__class__.__name__)
    except asyncio.CancelledError:
        pass


async def _generate(
    run_id: str, cid: str, request: dict[str, Any], session: AsyncSession
) -> None:
    """The actual call, and the storing of what came back."""
    conn = await load_connection(cid, session)
    try:
        async with await _gateway(conn) as client:
            resp = await client.post("/images/generations", json=request)
    except httpx.TimeoutException:
        await _fail(
            run_id,
            session,
            "the generation timed out. qwen-image-2512 at 50 steps runs CFG "
            "(two forward passes per step) — try fewer steps, or true_cfg_scale 1.",
        )
        return
    except httpx.RequestError as exc:
        logger.warning("laios gateway for %r unreachable: %s", conn.name, exc)
        await _fail(
            run_id,
            session,
            f"could not reach the inference gateway for {conn.name} — "
            "is the model serving, and the tunnel up?",
        )
        return

    if resp.status_code >= 400:
        # The engine's own validation messages arrive here and are precise
        # ("size must be a multiple of…"), so they are surfaced verbatim.
        await _fail(run_id, session, gateway_error_detail(resp))
        return

    try:
        payload = resp.json()
    except ValueError:
        await _fail(run_id, session, "gateway returned a non-JSON response")
        return
    if not isinstance(payload, dict):
        await _fail(run_id, session, "gateway returned an unexpected response shape")
        return

    try:
        data, mime = await _image_bytes(payload, conn, request)
    except HTTPException as exc:
        await _fail(run_id, session, str(exc.detail))
        return

    try:
        media_id = media_store.save_generated_image(data, mime)
    except ValueError as exc:
        await _fail(run_id, session, str(exc))
        return

    row = await _row(cid, run_id, session)
    row.status = "completed"
    row.media_id = media_id
    row.upstream_id = str(payload.get("id") or "") or None
    row.inference_time_s = _as_float(payload.get("inference_time_s"))
    row.peak_memory_mb = _as_float(payload.get("peak_memory_mb"))
    session.add(row)
    await session.commit()


async def _image_bytes(
    payload: dict[str, Any], conn: LaiosConnection, request: dict[str, Any]
) -> tuple[bytes, str]:
    """The pixels out of a generations response, whichever form they took.

    ``b64_json`` is what we asked for and is self-contained. The ``url`` branch is
    a fallback rather than a feature: the engine's own default is ``url``, and an
    older or differently-configured serve could answer that way regardless of
    what was requested. Its value is a *relative* ``/v1/images/{id}/content``,
    which the gateway routes back to the node that produced it — so the id is all
    that is needed, and constructing the path from it beats trusting a URL that
    is documented as relative but need not be.
    """
    entries = payload.get("data")
    entry = entries[0] if isinstance(entries, list) and entries else None
    if isinstance(entry, dict):
        b64 = entry.get("b64_json")
        if isinstance(b64, str) and b64:
            try:
                raw = base64.b64decode(b64, validate=True)
            except (ValueError, TypeError) as exc:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY,
                    "gateway returned a b64_json payload that would not decode",
                ) from exc
            return raw, _sniff_mime(raw, request)

    image_id = str(payload.get("id") or "").strip()
    if not image_id:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "gateway returned neither image data nor an id to fetch it with",
        )

    try:
        async with await _gateway(conn, timeout=_CONTENT_TIMEOUT) as client:
            resp = await client.get(f"/images/{image_id}/content")
    except (httpx.TimeoutException, httpx.RequestError) as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "the image was generated but downloading it from the gateway failed. "
            "Its bytes live in the container and do not survive a restart.",
        ) from exc

    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, gateway_error_detail(resp))

    content_type = resp.headers.get("content-type", "").split(";", 1)[0].strip()
    return resp.content, content_type or _sniff_mime(resp.content, request)


# Magic numbers for the three formats the engine can emit.
_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
)


def _sniff_mime(data: bytes, request: dict[str, Any]) -> str:
    """The image's real type, read off the bytes rather than the request.

    ``output_format`` is only a request — the engine defaults to jpeg and is free
    to ignore it — and a ``b64_json`` payload carries no content type at all. The
    extension the media store derives from this is what the browser is later told
    the file is, so guessing from the request would mislabel every response that
    did not honour it. The request is consulted only when the bytes are
    unrecognisable.
    """
    for prefix, mime in _MAGIC:
        if data.startswith(prefix):
            return mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    requested = str(request.get("output_format") or "").lower()
    return {"png": "image/png", "webp": "image/webp"}.get(requested, "image/jpeg")


async def _fail(run_id: str, session: AsyncSession, message: str) -> None:
    """Put a row into ``failed`` with a reason, from inside the background task.

    Loaded fresh rather than passed in: the row may have been touched since the
    task started, and this is the last write either way. A row that has since been
    deleted (DELETE while generating) is simply gone — not an error.
    """
    result = await session.execute(
        select(ImageGeneration).where(ImageGeneration.id == run_id)
    )
    row = result.scalars().first()
    if row is None:
        return
    row.status = "failed"
    row.error = message
    session.add(row)
    await session.commit()


@router.get("/{cid}/images/{run_id}")
async def image_status(
    cid: str, run_id: str, session: AsyncSession = Depends(get_session)
):
    """The current state of one generation.

    Purely a row read — the background task is what advances it, so unlike the
    video equivalent this touches no network and costs nothing to poll.
    """
    row = await _row(cid, run_id, session)
    if row.status not in TERMINAL and row.id not in _active:
        await _reap_orphans([row], session)
    return _to_read(row)


@router.delete("/{cid}/images/{run_id}", status_code=status.HTTP_200_OK)
async def delete_image(
    cid: str, run_id: str, session: AsyncSession = Depends(get_session)
):
    """Forget a generation, stopping the wait for it if it is still running.

    Not a cancel, and the difference is worth being honest about: the engine has
    no cancel on this API, so a running generation keeps the GPU until it
    finishes. What this stops is *our* waiting for it, and it removes the row —
    which is what "delete" can actually promise here.

    The stored image is left in the media store. It is content-addressed and may
    be shared with another row, so deleting bytes on a row delete could take an
    image another run is still showing.
    """
    row = await _row(cid, run_id, session)
    if task := _active.pop(run_id, None):
        task.cancel()
    await session.delete(row)
    await session.commit()
    return {"deleted": run_id}


@router.get("/{cid}/images/{run_id}/content")
async def image_content(
    cid: str, run_id: str, session: AsyncSession = Depends(get_session)
):
    """Serve the stored image.

    Already on disk by the time a row is ``completed`` — the background task
    stores it as part of finishing, so there is no fetch-on-first-view path here
    (contrast ``videos.stored_clip``, which defers pulling a multi-megabyte mp4
    through the tunnel until something asks for it).
    """
    row = await _row(cid, run_id, session)
    if not row.media_id:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "this generation has no image"
            + (f" — it {row.status}" if row.status != "running" else " yet"),
        )
    if not media_store.MEDIA_ID_RE.match(row.media_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "malformed media id")

    path: Path = media_store.generated_image_path(row.media_id)
    if not path.is_file():
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "the stored image is missing from the media store"
        )
    return FileResponse(
        path,
        media_type=media_store.mime_for_path(path),
        filename=f"{run_id}{path.suffix}",
        # Inline: the main consumer is an <img>, and passing `filename` alone
        # would make this an attachment.
        content_disposition_type="inline",
    )


def _as_float(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None
