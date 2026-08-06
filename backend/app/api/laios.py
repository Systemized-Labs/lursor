"""laios control plane — connection management + a thin proxy to the daemon.

Lursor's FastAPI app is an *application plane*: model pull/serve/VRAM/keys all
live in the laios daemon. This module does not reimplement any of that; it holds
the ``master_key`` server-side (never exposed to the browser) and forwards
requests to the daemon's control-plane API (``:7420``) with a Bearer token.

Every model-lifecycle route is scoped to a :class:`LaiosConnection` so Lursor
can drive several daemons — local or remote — from one UI.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, NamedTuple
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.config import get_settings
from app.db.models import CustomProvider, LaiosConnection
from app.db.session import async_session_factory, get_session
from app.schemas.laios import (
    LaiosConnectionCreate,
    LaiosConnectionRead,
    LaiosConnectionStatus,
    LaiosConnectionUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/laios", tags=["laios"])

# serve/pull can take a while; the daemon promotes instances to ready in the
# background and the client polls, so this only needs to cover the initial POST.
_DEFAULT_TIMEOUT = httpx.Timeout(30.0)


def _to_read(conn: LaiosConnection) -> LaiosConnectionRead:
    """Project a row to its API shape, hiding the raw master_key."""
    return LaiosConnectionRead(
        id=conn.id,
        name=conn.name,
        base_url=conn.base_url,
        gateway_url=conn.gateway_url,
        has_master_key=bool(conn.master_key),
        created_at=conn.created_at,
        updated_at=conn.updated_at,
    )


def _client(conn: LaiosConnection, timeout: httpx.Timeout | None = None) -> httpx.AsyncClient:
    base = conn.base_url.rstrip("/")
    headers = {"Accept": "application/json"}
    if conn.master_key:
        headers["Authorization"] = f"Bearer {conn.master_key}"
    return httpx.AsyncClient(base_url=base, headers=headers, timeout=timeout or _DEFAULT_TIMEOUT)


async def _get_conn(cid: str, session: AsyncSession) -> LaiosConnection:
    conn = await session.get(LaiosConnection, cid)
    if conn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "laios connection not found")
    return conn


async def _forward(
    conn: LaiosConnection,
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json_body: Any | None = None,
    timeout: httpx.Timeout | None = None,
) -> Response:
    """Proxy a request to the daemon and relay its JSON response / error.

    Translates transport failures (unreachable / timeout) into 502/504 with a
    clear message, and daemon error bodies (``{error:{code,message}}``) into an
    HTTPException carrying the same detail so the UI can show why an op failed.
    """
    if not conn.base_url.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "connection has no base URL")
    try:
        async with _client(conn, timeout=timeout) as client:
            resp = await client.request(method, path, params=params, json=json_body)
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT,
            f"laios daemon at {conn.base_url} timed out",
        ) from exc
    except httpx.RequestError as exc:
        logger.warning("laios %r unreachable: %s", conn.name, exc)
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"could not reach laios daemon at {conn.base_url} — is it running?",
        ) from exc

    if resp.status_code >= 400:
        detail = _daemon_error_detail(resp)
        raise HTTPException(resp.status_code, detail)

    if resp.status_code == status.HTTP_204_NO_CONTENT or not resp.content:
        return Response(status_code=resp.status_code)
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/json"),
    )


def _daemon_error_detail(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return f"laios daemon returned HTTP {resp.status_code}"
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        code = err.get("code")
        msg = err.get("message") or ""
        return f"{msg} ({code})" if code else msg or f"HTTP {resp.status_code}"
    return f"laios daemon returned HTTP {resp.status_code}"


# --- Model picker linking -------------------------------------------------------
#
# A control connection (:7420) knows its LiteLLM inference gateway (:4000). We
# mirror that gateway as a CustomProvider so the models it serves flow into the
# existing model picker (models.py merges every CustomProvider's /models). The
# provider is created/updated/removed alongside the connection and excluded from
# the manual Providers tab so it is managed only from the laios surface.

# Path prefix lastway publishes a box's *control* plane under, mirroring
# ``lastway_proto::routes::CONTROL_PATH_PREFIX``. A connection whose base URL
# ends in this is reached through a tunnel rather than directly, which changes
# where its inference gateway lives (see :func:`_derive_gateway_base`).
TUNNEL_CONTROL_PREFIX = "/control"


async def _derive_gateway_base(conn: LaiosConnection) -> str | None:
    """OpenAI-compatible gateway base URL for a connection.

    The control plane and the inference gateway are **independent**: managing a
    box (serve/stop/inventory) is a LAN-side operation on ``:7420``, while
    reaching its models can go somewhere else entirely — over a lastway tunnel,
    say, where the box is published on a public hostname but its control plane
    stays closed. So this resolves in three steps, most explicit first:

    1. ``gateway_url`` if set. Whatever the operator entered wins; nothing is
       inferred from the control-plane URL, because the two need not be related.
    2. Otherwise, if the control base is itself tunnelled (path ends in
       ``/control``, lastway's ``CONTROL_PATH_PREFIX``), the gateway is that same
       origin with the prefix stripped — the tunnel publishes both origins on one
       hostname split by path. Deriving a port there would be actively wrong:
       nothing listens on ``:4000`` at the tunnel edge, and the daemon's
       ``gateway_listen`` reports a box-local address.
    3. Otherwise the historical derivation: the control host, with the port from
       ``/v1/route`` (``gateway_listen``), defaulting to 4000 when the daemon is
       unreachable.

    The scheme is carried over rather than assumed, since a tunnel is https.
    """
    if conn.gateway_url and conn.gateway_url.strip():
        return _normalize_gateway_url(conn.gateway_url)

    parsed = urlparse(conn.base_url)
    if not parsed.hostname:
        return None

    control_path = parsed.path.rstrip("/")
    if control_path.endswith(TUNNEL_CONTROL_PREFIX):
        root = control_path[: -len(TUNNEL_CONTROL_PREFIX)]
        return f"{parsed.scheme}://{parsed.netloc}{root}/v1"

    port = 4000
    try:
        async with _client(conn, timeout=httpx.Timeout(3.0)) as client:
            resp = await client.get("/v1/route")
        if resp.status_code < 400:
            listen = resp.json().get("gateway_listen") or ""
            tail = listen.rsplit(":", 1)[-1]
            if tail.isdigit():
                port = int(tail)
    except (httpx.RequestError, ValueError):
        pass
    return f"{parsed.scheme or 'http'}://{parsed.hostname}:{port}/v1"


def _normalize_gateway_url(raw: str) -> str:
    """Coerce an operator-entered gateway URL to an OpenAI base ending in ``/v1``.

    Both ``https://host`` and ``https://host/v1`` are things a person reasonably
    types for the same endpoint, and every caller downstream appends paths
    relative to ``/v1``.
    """
    trimmed = raw.strip().rstrip("/")
    return trimmed if trimmed.endswith("/v1") else f"{trimmed}/v1"


def _same_endpoint(a: str, b: str) -> bool:
    return a.rstrip("/").lower() == b.rstrip("/").lower()


async def sync_linked_provider(session: AsyncSession, conn: LaiosConnection) -> None:
    """Create/update the CustomProvider mirroring this connection's gateway.

    Skips creating a new provider when a (manually-added) provider already
    targets the same endpoint, so we don't duplicate picker groups.
    """
    gateway = await _derive_gateway_base(conn)
    if not gateway:
        return

    existing = (
        await session.get(CustomProvider, conn.linked_provider_id)
        if conn.linked_provider_id
        else None
    )
    if existing is not None:
        existing.name = conn.name
        existing.base_url = gateway
        existing.api_key = conn.master_key
        session.add(existing)
        await session.commit()
        return

    # Dedup against any provider already pointing at this gateway.
    others = (await session.execute(select(CustomProvider))).scalars().all()
    if any(_same_endpoint(p.base_url, gateway) for p in others):
        return

    provider = CustomProvider(
        name=conn.name, base_url=gateway, api_key=conn.master_key
    )
    session.add(provider)
    await session.commit()
    await session.refresh(provider)
    conn.linked_provider_id = provider.id
    session.add(conn)
    await session.commit()


async def remove_linked_provider(session: AsyncSession, conn: LaiosConnection) -> None:
    if not conn.linked_provider_id:
        return
    provider = await session.get(CustomProvider, conn.linked_provider_id)
    if provider is not None:
        await session.delete(provider)
        await session.commit()


async def managed_provider_ids(session: AsyncSession) -> set[str]:
    """CustomProvider ids that are auto-managed by a laios connection.

    Used by the Providers tab to hide these from manual management.
    """
    result = await session.execute(
        select(LaiosConnection.linked_provider_id).where(
            LaiosConnection.linked_provider_id.is_not(None)
        )
    )
    return {pid for (pid,) in result.all() if pid}


# --- Shared with api/videos.py --------------------------------------------------
#
# The video surface is connection-scoped in exactly the same way as everything
# here, but it talks to the *inference* gateway rather than the control plane. It
# needs connection lookup and gateway-base derivation; re-deriving either there
# would be two ways to answer "where is this box".

load_connection = _get_conn
gateway_base = _derive_gateway_base


async def non_chat_served_names(conn: LaiosConnection) -> set[str]:
    """Served names on this box that are **not** chat models.

    The gateway's ``/v1/models`` is a flat OpenAI list with no capability field,
    so a generative-media model — MiniMax-H3, which speaks ``/v1/videos`` and has
    no chat surface at all — is indistinguishable from an LLM there. Left alone it
    lands in the chat picker, where selecting it makes every message fail.

    The control plane's inventory *does* carry ``capabilities`` per recipe plus
    the live instance's served name, so the join belongs here rather than in the
    picker: this module already owns talking to the daemon.

    Keyed on the absence of ``chat`` rather than the presence of ``video``, since
    the same bug applies to any non-conversational surface (embeddings next), and
    a model declaring both stays selectable.

    **Fails open.** An unreachable or unauthorised control plane — a tunnelled box
    without ``expose_control`` — returns an empty set, so a box we cannot classify
    shows all of its models rather than none of them.
    """
    try:
        async with _client(conn, timeout=httpx.Timeout(5.0)) as client:
            resp = await client.get("/v1/models")
        if resp.status_code >= 400:
            return set()
        inventory = resp.json()
    except (httpx.RequestError, ValueError):
        return set()

    if not isinstance(inventory, list):
        return set()

    excluded: set[str] = set()
    for model in inventory:
        if not isinstance(model, dict):
            continue
        capabilities = model.get("capabilities")
        # Unknown or unstated capabilities are unclassifiable, and hiding a model
        # on a guess is worse than showing one that might not chat.
        if not isinstance(capabilities, list) or not capabilities:
            continue
        if "chat" in capabilities:
            continue
        # The gateway advertises the *served* name, which is what the picker sees.
        instance = model.get("running_instance") or {}
        candidates = (
            instance.get("served_name") if isinstance(instance, dict) else None,
            model.get("served_model_name"),
        )
        for name in candidates:
            if isinstance(name, str) and name:
                excluded.add(name)
    return excluded


class ServedModel(NamedTuple):
    """One model with a given capability that a box is actually serving.

    ``served_name`` is what the gateway routes on. ``profile`` is the recipe's
    declaration block for that capability when the operator wrote one — for video
    that is ``video_profile`` (see ``docs/upstream/laios-video-profile.patch``), the
    only thing that says *how* to ask this model for a clip. Images have no such
    block and always get ``None``. ``model_id``/``recipe_id`` are identity, used to
    recognise a model whose profile is missing.
    """

    served_name: str
    model_id: str
    recipe_id: str
    profile: dict[str, Any] | None


# The name this was born as, kept so ``agents/video_runtime.py`` reads in its own
# terms. Images made the type generic; video is still its only profiled user.
VideoServedModel = ServedModel


async def _served_with_capability(
    conn: LaiosConnection, capability: str, *, profile_key: str | None = None
) -> list[ServedModel]:
    """Models this box is serving that declare ``capability``.

    The sibling of :func:`non_chat_served_names`, over the same control-plane
    inventory join, and deliberately not the same question: that one asks "what must
    the chat picker hide" and answers by the *absence* of ``chat``; this asks "is
    there something here we can drive" and answers by the *presence* of a capability
    plus a running instance.

    **Fails closed**, which is the opposite of its sibling and is the point. The
    picker hides on a guess and so must guess generously; a generation tool built
    for a box we cannot even reach would fail on every call, and an absent tool is
    strictly better than one that always fails. What each caller then *does* with an
    unprofiled model is its own policy — video refuses to drive one and images fall
    back to conservative defaults — and that divergence lives in the runtimes, not
    here.

    Sorted by served name so the caller's choice among several is stable.
    """
    try:
        async with _client(conn, timeout=httpx.Timeout(5.0)) as client:
            resp = await client.get("/v1/models")
        if resp.status_code >= 400:
            return []
        inventory = resp.json()
    except (httpx.RequestError, ValueError):
        return []

    if not isinstance(inventory, list):
        return []

    served: list[ServedModel] = []
    for model in inventory:
        if not isinstance(model, dict):
            continue
        capabilities = model.get("capabilities")
        if not isinstance(capabilities, list) or capability not in capabilities:
            continue
        # Only a *serving* model can take a job. ``running_instance`` is present
        # for any active instance (the daemon counts pending/pulling/starting as
        # active), so the status is checked too: a box 20 minutes into loading 95 GB
        # of weights has an instance but no gateway route yet, and a tool built on
        # that is the always-400 tool this function exists to avoid.
        instance = model.get("running_instance")
        if not isinstance(instance, dict) or instance.get("status") != "running":
            continue
        name = instance.get("served_name") or model.get("served_model_name")
        if not isinstance(name, str) or not name:
            continue
        profile = model.get(profile_key) if profile_key else None
        served.append(
            ServedModel(
                served_name=name,
                model_id=str(model.get("model_id") or ""),
                recipe_id=str(model.get("recipe_id") or model.get("id") or ""),
                profile=profile if isinstance(profile, dict) else None,
            )
        )
    return sorted(served, key=lambda m: m.served_name)


async def video_served_models(conn: LaiosConnection) -> list[ServedModel]:
    """Video-capable models this box is serving, with their request profiles.

    The profile is what ``agents/video_runtime.py`` needs to know *how* to ask: the
    request surface is per-model, so an undeclared model is one it will refuse to
    drive.
    """
    return await _served_with_capability(conn, "video", profile_key="video_profile")


async def image_served_models(conn: LaiosConnection) -> list[ServedModel]:
    """Image-capable models this box is serving.

    No profile key, because there is no ``image_profile`` to read: every image
    recipe speaks the same ``/v1/images/generations`` surface and takes the same
    fields, so the per-model knowledge is only about sensible *values*. That table
    lives in ``agents/image_runtime.py`` (and its frontend twin), keyed on the
    served name this returns.
    """
    return await _served_with_capability(conn, "image")


# --- Connection CRUD ------------------------------------------------------------


@router.get("/connections", response_model=list[LaiosConnectionRead])
async def list_connections(session: AsyncSession = Depends(get_session)):
    result = await session.execute(
        select(LaiosConnection).order_by(LaiosConnection.created_at)
    )
    return [_to_read(c) for c in result.scalars().all()]


@router.post(
    "/connections",
    response_model=LaiosConnectionRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_connection(
    payload: LaiosConnectionCreate, session: AsyncSession = Depends(get_session)
):
    conn = LaiosConnection(**payload.model_dump())
    session.add(conn)
    await session.commit()
    await session.refresh(conn)
    await sync_linked_provider(session, conn)
    return _to_read(conn)


@router.get("/connections/{cid}", response_model=LaiosConnectionRead)
async def get_connection(cid: str, session: AsyncSession = Depends(get_session)):
    return _to_read(await _get_conn(cid, session))


@router.patch("/connections/{cid}", response_model=LaiosConnectionRead)
async def update_connection(
    cid: str,
    payload: LaiosConnectionUpdate,
    session: AsyncSession = Depends(get_session),
):
    conn = await _get_conn(cid, session)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(conn, key, value)
    session.add(conn)
    await session.commit()
    await session.refresh(conn)
    await sync_linked_provider(session, conn)
    return _to_read(conn)


@router.delete("/connections/{cid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_connection(cid: str, session: AsyncSession = Depends(get_session)):
    conn = await _get_conn(cid, session)
    await remove_linked_provider(session, conn)
    await session.delete(conn)
    await session.commit()


# --- Status probe ---------------------------------------------------------------


@router.get("/connections/{cid}/status", response_model=LaiosConnectionStatus)
async def connection_status(cid: str, session: AsyncSession = Depends(get_session)):
    """Probe the daemon's ``/health`` and (best-effort) ``/v1/route``."""
    conn = await _get_conn(cid, session)
    if not conn.base_url.strip():
        return LaiosConnectionStatus(status="error", error="No base URL configured.")

    try:
        async with _client(conn, timeout=httpx.Timeout(5.0)) as client:
            health = await client.get("/health")
    except httpx.TimeoutException:
        return LaiosConnectionStatus(status="error", error="Timed out reaching the daemon (5s).")
    except httpx.RequestError:
        return LaiosConnectionStatus(
            status="error",
            error="Could not reach the daemon — check the URL and that it is running.",
        )

    if health.status_code >= 400:
        return LaiosConnectionStatus(
            status="error",
            reachable=True,
            error=f"Daemon health returned HTTP {health.status_code}.",
        )

    try:
        h = health.json()
    except ValueError:
        return LaiosConnectionStatus(
            status="error", reachable=True, error="Health response was not valid JSON."
        )

    result = LaiosConnectionStatus(
        status="ok",
        reachable=True,
        role=h.get("role"),
        node_id=h.get("node_id"),
        version=h.get("version"),
    )
    # Best-effort auth check via a protected route; missing/invalid key -> flag it.
    try:
        async with _client(conn, timeout=httpx.Timeout(5.0)) as client:
            route = await client.get("/v1/route")
        if route.status_code == 401:
            result.status = "error"
            result.master_key_set = False
            result.error = "Reachable, but the master key is missing or invalid."
        elif route.status_code < 400:
            result.master_key_set = bool(route.json().get("master_key_set"))
    except httpx.RequestError:
        pass
    return result


# --- Model lifecycle proxy (scoped to a connection) -----------------------------


@router.get("/connections/{cid}/catalog")
async def catalog(cid: str, session: AsyncSession = Depends(get_session)):
    return await _forward(await _get_conn(cid, session), "GET", "/v1/catalog")


@router.get("/connections/{cid}/catalog/{recipe_id}")
async def catalog_recipe(
    cid: str, recipe_id: str, session: AsyncSession = Depends(get_session)
):
    return await _forward(await _get_conn(cid, session), "GET", f"/v1/catalog/{recipe_id}")


# --- Model inventory proxy (installed weights + run stats) -----------------------
#
# The catalog above is the *recipe* list (what could run); this is the *inventory*
# (what is downloaded on disk), carrying per-model run stats (#36), on-disk size,
# and any live instance. ``/models/partial`` surfaces orphaned/incomplete
# downloads (#35) and ``DELETE /models/{id}`` reclaims disk (id may be a recipe
# id OR a raw model-dir name; 409 if the model is in use).
#
# Route order matters: ``/models/partial`` is declared before ``/models/{id}`` so
# the literal path isn't captured as a model id by the parameterized route.


@router.get("/connections/{cid}/models")
async def models(cid: str, session: AsyncSession = Depends(get_session)):
    return await _forward(await _get_conn(cid, session), "GET", "/v1/models")


@router.get("/connections/{cid}/models/partial")
async def partial_models(cid: str, session: AsyncSession = Depends(get_session)):
    return await _forward(await _get_conn(cid, session), "GET", "/v1/models/partial")


@router.get("/connections/{cid}/models/{model_id:path}")
async def model_detail(
    cid: str, model_id: str, session: AsyncSession = Depends(get_session)
):
    return await _forward(
        await _get_conn(cid, session), "GET", f"/v1/models/{model_id}"
    )


@router.delete("/connections/{cid}/models/{model_id:path}")
async def delete_model(
    cid: str, model_id: str, session: AsyncSession = Depends(get_session)
):
    return await _forward(
        await _get_conn(cid, session),
        "DELETE",
        f"/v1/models/{model_id}",
        timeout=httpx.Timeout(60.0),
    )


@router.get("/connections/{cid}/instances")
async def instances(cid: str, session: AsyncSession = Depends(get_session)):
    return await _forward(await _get_conn(cid, session), "GET", "/v1/instances")


@router.get("/connections/{cid}/instances/{instance_id}")
async def instance(
    cid: str, instance_id: str, session: AsyncSession = Depends(get_session)
):
    return await _forward(
        await _get_conn(cid, session), "GET", f"/v1/instances/{instance_id}"
    )


@router.post("/connections/{cid}/serve")
async def serve(cid: str, body: dict, session: AsyncSession = Depends(get_session)):
    return await _forward(
        await _get_conn(cid, session),
        "POST",
        "/v1/serve",
        json_body=body,
        timeout=httpx.Timeout(120.0),
    )


@router.post("/connections/{cid}/instances/{instance_id}/stop")
async def stop_instance(
    cid: str, instance_id: str, session: AsyncSession = Depends(get_session)
):
    return await _forward(
        await _get_conn(cid, session),
        "POST",
        f"/v1/instances/{instance_id}/stop",
        timeout=httpx.Timeout(60.0),
    )


@router.delete("/connections/{cid}/instances/{instance_id}")
async def remove_instance(
    cid: str, instance_id: str, session: AsyncSession = Depends(get_session)
):
    return await _forward(
        await _get_conn(cid, session),
        "DELETE",
        f"/v1/instances/{instance_id}",
        timeout=httpx.Timeout(60.0),
    )


@router.get("/connections/{cid}/instances/{instance_id}/logs")
async def instance_logs(
    cid: str,
    instance_id: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    tail = request.query_params.get("tail")
    params = {"tail": tail} if tail is not None else None
    return await _forward(
        await _get_conn(cid, session),
        "GET",
        f"/v1/instances/{instance_id}/logs",
        params=params,
    )


@router.post("/connections/{cid}/pull")
async def pull(cid: str, body: dict, session: AsyncSession = Depends(get_session)):
    return await _forward(
        await _get_conn(cid, session), "POST", "/v1/pull", json_body=body
    )


@router.get("/connections/{cid}/jobs")
async def jobs(cid: str, session: AsyncSession = Depends(get_session)):
    """List the daemon's background jobs (model pulls, with live byte progress).

    The download UI polls this to render in-flight pulls as first-class cards —
    the daemon is the source of truth, so a pull started elsewhere (or before a
    page reload) still shows up.
    """
    return await _forward(await _get_conn(cid, session), "GET", "/v1/jobs")


@router.get("/connections/{cid}/jobs/{job_id}")
async def job(cid: str, job_id: str, session: AsyncSession = Depends(get_session)):
    return await _forward(await _get_conn(cid, session), "GET", f"/v1/jobs/{job_id}")


@router.post("/connections/{cid}/jobs/{job_id}/cancel")
async def cancel_job(
    cid: str, job_id: str, session: AsyncSession = Depends(get_session)
):
    """Cancel an in-flight pull. The daemon returns 409 if it already finished."""
    return await _forward(
        await _get_conn(cid, session), "POST", f"/v1/jobs/{job_id}/cancel"
    )


@router.get("/connections/{cid}/budget")
async def budget(cid: str, session: AsyncSession = Depends(get_session)):
    return await _forward(await _get_conn(cid, session), "GET", "/v1/budget")


@router.get("/connections/{cid}/doctor")
async def doctor(cid: str, session: AsyncSession = Depends(get_session)):
    return await _forward(await _get_conn(cid, session), "GET", "/v1/doctor")


@router.get("/connections/{cid}/metrics")
async def metrics_summary(cid: str, session: AsyncSession = Depends(get_session)):
    """Per-served-model request/token/throughput rollup from the gateway."""
    return await _forward(await _get_conn(cid, session), "GET", "/v1/metrics/summary")


@router.get("/connections/{cid}/cluster")
async def cluster_status(cid: str, session: AsyncSession = Depends(get_session)):
    """Cluster membership + aggregate resources across head and live workers.

    The daemon's ``/v1/cluster/status`` embeds a ``resources`` rollup that only
    counts online (recently-heartbeating) nodes, so a stale worker never
    inflates the reported capacity shown in the UI.
    """
    return await _forward(await _get_conn(cid, session), "GET", "/v1/cluster/status")


@router.get("/connections/{cid}/cluster/token")
async def cluster_token(cid: str, session: AsyncSession = Depends(get_session)):
    """The head's join token — what a new worker needs to join the cluster."""
    return await _forward(await _get_conn(cid, session), "GET", "/v1/cluster/token")


@router.delete("/connections/{cid}/cluster/workers/{worker_id}")
async def remove_worker(
    cid: str, worker_id: str, session: AsyncSession = Depends(get_session)
):
    """Drop a worker from the cluster (id or unique prefix).

    The daemon returns 404 if no such worker and 409 if an active instance is
    still placed on it — both surface to the UI via the shared error relay.
    """
    return await _forward(
        await _get_conn(cid, session),
        "DELETE",
        f"/v1/cluster/workers/{worker_id}",
        timeout=httpx.Timeout(30.0),
    )


# --- Daemon lifecycle proxy (version / restart / update) ------------------------
#
# The daemon owns the lifecycle logic (it shells out to the tested CLI/scripts);
# Lursor only forwards. Restart is special: the daemon returns 202 and then dies
# ~1s later, so a transport failure right after the request is expected, not an
# error — we surface it as "restart initiated" so the UI can move into a
# reconnecting state and re-probe `/status`.


@router.get("/connections/{cid}/daemon/version")
async def daemon_version(
    cid: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    # `?check=true` makes the daemon `git fetch` + count commits behind; keep it
    # opt-in so the badge's default poll stays cheap.
    check = request.query_params.get("check")
    params = {"check": check} if check is not None else None
    return await _forward(
        await _get_conn(cid, session), "GET", "/v1/daemon/version", params=params
    )


@router.post("/connections/{cid}/daemon/restart")
async def daemon_restart(cid: str, session: AsyncSession = Depends(get_session)):
    conn = await _get_conn(cid, session)
    try:
        return await _forward(
            conn, "POST", "/v1/daemon/restart", timeout=httpx.Timeout(15.0)
        )
    except HTTPException as exc:
        # The daemon may drop the connection as it shuts down before/while
        # replying. That still means the restart was accepted, so don't surface
        # it as a failure — tell the UI to start reconnecting.
        transient = (
            status.HTTP_502_BAD_GATEWAY,
            status.HTTP_504_GATEWAY_TIMEOUT,
        )
        if exc.status_code in transient:
            body = b'{"restarting": true, "note": "daemon closed the connection"}'
            return Response(
                content=body,
                status_code=status.HTTP_202_ACCEPTED,
                media_type="application/json",
            )
        raise


@router.post("/connections/{cid}/daemon/update")
async def daemon_update(cid: str, session: AsyncSession = Depends(get_session)):
    return await _forward(
        await _get_conn(cid, session),
        "POST",
        "/v1/daemon/update",
        timeout=httpx.Timeout(30.0),
    )


@router.get("/connections/{cid}/daemon/update/log")
async def daemon_update_log(
    cid: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    params: dict[str, Any] = {}
    log = request.query_params.get("log")
    if log is not None:
        params["log"] = log
    tail = request.query_params.get("tail")
    if tail is not None:
        params["tail"] = tail
    return await _forward(
        await _get_conn(cid, session),
        "GET",
        "/v1/daemon/update/log",
        params=params or None,
    )


# --- Auto-seed a "local" connection ---------------------------------------------


def _master_key_from_config(config_path: str) -> str | None:
    """Parse ``[gateway].master_key`` from the daemon TOML, if present."""
    path = Path(os.path.expanduser(config_path))
    if not path.is_file():
        return None
    try:
        import tomllib

        data = tomllib.loads(path.read_text())
    except (OSError, ValueError):
        return None
    gateway = data.get("gateway") if isinstance(data, dict) else None
    if isinstance(gateway, dict):
        key = gateway.get("master_key")
        return key if isinstance(key, str) and key else None
    return None


async def _ensure_schema() -> None:
    """Add columns introduced after a table was first created.

    ``create_all`` never alters existing tables and the app has no migration
    framework, so a DB that predates ``linked_provider_id`` or ``gateway_url``
    would be missing them. This is a narrow, idempotent backfill for our own
    (new) table.
    """
    from sqlalchemy import text

    added = ("linked_provider_id", "gateway_url")
    try:
        async with async_session_factory() as session:
            info = await session.execute(text("PRAGMA table_info(laios_connections)"))
            columns = {row[1] for row in info}
            if not columns:
                return
            for column in added:
                if column not in columns:
                    await session.execute(
                        text(
                            f"ALTER TABLE laios_connections ADD COLUMN {column} VARCHAR"
                        )
                    )
                    logger.info("added laios_connections.%s column", column)
            await session.commit()
    except Exception as exc:  # pragma: no cover - startup must not fail on this
        logger.warning("laios schema check skipped: %s", exc)


async def _backfill_links() -> None:
    """Ensure every existing connection has its picker provider linked.

    Covers connections created before auto-linking existed (e.g. a ``local``
    seeded by an earlier version). Idempotent and never fatal.
    """
    try:
        async with async_session_factory() as session:
            result = await session.execute(
                select(LaiosConnection).where(
                    LaiosConnection.linked_provider_id.is_(None)
                )
            )
            for conn in result.scalars().all():
                await sync_linked_provider(session, conn)
    except Exception as exc:  # pragma: no cover - startup must not fail on this
        logger.warning("laios link backfill skipped: %s", exc)


async def seed_local_laios() -> None:
    """Insert a ``local`` connection when Lursor runs alongside a daemon.

    Idempotent: skips if any connection already targets the resolved base URL.
    Runs on startup from the app lifespan. Never raises into startup.
    """
    await _ensure_schema()
    await _backfill_links()
    settings = get_settings()
    base_url = settings.laios_url or (
        "http://127.0.0.1:7420"
        if (settings.laios_master_key or _config_file_exists(settings.laios_config_path))
        else None
    )
    if not base_url:
        return  # no signal that a daemon exists; leave connections empty

    master_key = settings.laios_master_key or _master_key_from_config(
        settings.laios_config_path
    )

    try:
        base_norm = base_url.rstrip("/")
        async with async_session_factory() as session:
            result = await session.execute(select(LaiosConnection))
            for existing in result.scalars().all():
                if existing.base_url.rstrip("/") == base_norm:
                    return  # already seeded (or user-added)
            conn = LaiosConnection(
                name="local", base_url=base_url, master_key=master_key
            )
            session.add(conn)
            await session.commit()
            await session.refresh(conn)
            await sync_linked_provider(session, conn)
            logger.info("seeded local laios connection -> %s", base_url)
    except Exception as exc:  # pragma: no cover - startup must not fail on this
        logger.warning("laios seed skipped: %s", exc)


def _config_file_exists(config_path: str) -> bool:
    return Path(os.path.expanduser(config_path)).is_file()
