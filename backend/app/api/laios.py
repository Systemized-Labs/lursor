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
from typing import Any
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
    except httpx.TimeoutException:
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT,
            f"laios daemon at {conn.base_url} timed out",
        )
    except httpx.RequestError as exc:
        logger.warning("laios %r unreachable: %s", conn.name, exc)
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"could not reach laios daemon at {conn.base_url} — is it running?",
        )

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


async def _derive_gateway_base(conn: LaiosConnection) -> str | None:
    """Best-effort OpenAI-compatible gateway base URL for a connection.

    Host comes from the control-plane URL; the gateway port from ``/v1/route``
    (``gateway_listen``), defaulting to 4000 when the daemon is unreachable.
    """
    host = urlparse(conn.base_url).hostname
    if not host:
        return None
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
    return f"http://{host}:{port}/v1"


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


@router.get("/connections/{cid}/budget")
async def budget(cid: str, session: AsyncSession = Depends(get_session)):
    return await _forward(await _get_conn(cid, session), "GET", "/v1/budget")


@router.get("/connections/{cid}/doctor")
async def doctor(cid: str, session: AsyncSession = Depends(get_session)):
    return await _forward(await _get_conn(cid, session), "GET", "/v1/doctor")


@router.get("/connections/{cid}/cluster")
async def cluster_status(cid: str, session: AsyncSession = Depends(get_session)):
    """Cluster membership + aggregate resources across head and live workers.

    The daemon's ``/v1/cluster/status`` embeds a ``resources`` rollup that only
    counts online (recently-heartbeating) nodes, so a stale worker never
    inflates the reported capacity shown in the UI.
    """
    return await _forward(await _get_conn(cid, session), "GET", "/v1/cluster/status")


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
    framework, so a DB that predates ``linked_provider_id`` would be missing it.
    This is a narrow, idempotent backfill for our own (new) table.
    """
    from sqlalchemy import text

    try:
        async with async_session_factory() as session:
            info = await session.execute(text("PRAGMA table_info(laios_connections)"))
            columns = {row[1] for row in info}
            if columns and "linked_provider_id" not in columns:
                await session.execute(
                    text(
                        "ALTER TABLE laios_connections ADD COLUMN linked_provider_id VARCHAR"
                    )
                )
                await session.commit()
                logger.info("added laios_connections.linked_provider_id column")
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
