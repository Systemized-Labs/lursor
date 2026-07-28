"""Global subagents — reusable specialists any agent can delegate to.

A subagent is stored once and applies to every agent that has
``include_subagents`` enabled (there is no per-agent link — see
``db/models.py`` :class:`Subagent`). The builder turns each row into a
pydantic-deep ``SubAgentConfig`` at run time (``agents/builder.py``).

The ``/defaults`` routes expose pydantic-deep's built-in subagents
(``general-purpose``, ``research``) plus the subagent-governing knobs. A built-in
is read-only apart from a single on/off switch (``disabled_builtins``): to change
what one does, switch it off and create an ordinary subagent — that form can
express everything an editable copy could and more (see
``agents/deep_defaults.py``).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.agents.deep_defaults import (
    BUILTIN_SUBAGENT_NAMES,
    LIBRARY_MAX_NESTING_DEPTH,
    builtin_subagent_defaults,
    resolve_subagent_defaults,
)
from app.db.models import AppConfig, Subagent, Tool
from app.db.session import get_session
from app.schemas.subagent import (
    BuiltinSubagentRead,
    ResolvedInt,
    SubagentCreate,
    SubagentDefaultsRead,
    SubagentDefaultsUpdate,
    SubagentRead,
    SubagentUpdate,
)

router = APIRouter(prefix="/subagents", tags=["subagents"])


async def _resolve(session: AsyncSession, model, ids: list[str]) -> list:
    """Load rows by id, 400-ing if any id is unknown (mirrors agents API)."""
    if not ids:
        return []
    result = await session.execute(select(model).where(model.id.in_(ids)))
    rows = result.scalars().all()
    missing = set(ids) - {r.id for r in rows}
    if missing:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown {model.__name__.lower()} id(s): {', '.join(sorted(missing))}",
        )
    return rows


# --- Defaults: pydantic-deep built-in subagents + governing knobs --------------


async def _get_app_config(session: AsyncSession) -> AppConfig | None:
    return (await session.execute(select(AppConfig))).scalars().first()


async def _defaults_payload(session: AsyncSession) -> SubagentDefaultsRead:
    cfg = await _get_app_config(session)
    raw = dict(cfg.deep_defaults) if cfg else {}
    resolved = resolve_subagent_defaults(raw)
    depth_override = raw.get("max_nesting_depth")
    disabled = set(resolved["disabled_builtins"])

    builtins = [
        BuiltinSubagentRead(
            name=b["name"],
            default_description=b["description"],
            default_instructions=b["instructions"],
            enabled=b["name"] not in disabled,
        )
        for b in builtin_subagent_defaults()
    ]

    return SubagentDefaultsRead(
        max_nesting_depth=ResolvedInt(
            library_default=LIBRARY_MAX_NESTING_DEPTH,
            override=depth_override if isinstance(depth_override, int) else None,
            effective=resolved["max_nesting_depth"],
        ),
        builtins=builtins,
    )


@router.get("/defaults", response_model=SubagentDefaultsRead)
async def get_defaults(session: AsyncSession = Depends(get_session)):
    return await _defaults_payload(session)


@router.put("/defaults", response_model=SubagentDefaultsRead)
async def update_defaults(
    payload: SubagentDefaultsUpdate, session: AsyncSession = Depends(get_session)
):
    cfg = await _get_app_config(session)
    if cfg is None:
        cfg = AppConfig()
    # JSON columns don't track in-place mutation; rebuild and reassign.
    defaults = dict(cfg.deep_defaults)

    if payload.clear_max_nesting_depth:
        defaults.pop("max_nesting_depth", None)
    elif payload.max_nesting_depth is not None:
        if payload.max_nesting_depth < 0:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "max_nesting_depth must be >= 0",
            )
        defaults["max_nesting_depth"] = payload.max_nesting_depth

    if payload.disabled_builtins is not None:
        unknown = set(payload.disabled_builtins) - BUILTIN_SUBAGENT_NAMES
        if unknown:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"Unknown built-in subagent(s): {', '.join(sorted(unknown))}",
            )
        defaults["disabled_builtins"] = [
            n for n in payload.disabled_builtins if n in BUILTIN_SUBAGENT_NAMES
        ]

    cfg.deep_defaults = defaults
    session.add(cfg)
    await session.commit()
    return await _defaults_payload(session)


# --- User subagent CRUD --------------------------------------------------------


@router.get("", response_model=list[SubagentRead])
async def list_subagents(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Subagent).order_by(Subagent.created_at))
    return [SubagentRead.from_subagent(sa) for sa in result.scalars().all()]


@router.post("", response_model=SubagentRead, status_code=status.HTTP_201_CREATED)
async def create_subagent(
    payload: SubagentCreate, session: AsyncSession = Depends(get_session)
):
    # Resolve links before the row joins the session, so assigning the
    # collections cannot trigger a sync lazy-load on a flushed-but-unloaded object.
    tools = await _resolve(session, Tool, payload.tool_ids)
    data = payload.model_dump(exclude={"tool_ids"})
    subagent = Subagent(**data, tools=tools)
    session.add(subagent)
    await session.commit()
    return SubagentRead.from_subagent(subagent)


@router.get("/{subagent_id}", response_model=SubagentRead)
async def get_subagent(subagent_id: str, session: AsyncSession = Depends(get_session)):
    subagent = await session.get(Subagent, subagent_id)
    if subagent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Subagent not found")
    return SubagentRead.from_subagent(subagent)


@router.patch("/{subagent_id}", response_model=SubagentRead)
async def update_subagent(
    subagent_id: str,
    payload: SubagentUpdate,
    session: AsyncSession = Depends(get_session),
):
    subagent = await session.get(Subagent, subagent_id)
    if subagent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Subagent not found")
    data = payload.model_dump(exclude_unset=True, exclude={"tool_ids"})
    for key, value in data.items():
        setattr(subagent, key, value)
    if payload.tool_ids is not None:
        subagent.tools = await _resolve(session, Tool, payload.tool_ids)
    session.add(subagent)
    await session.commit()
    return SubagentRead.from_subagent(subagent)


@router.delete("/{subagent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_subagent(
    subagent_id: str, session: AsyncSession = Depends(get_session)
):
    subagent = await session.get(Subagent, subagent_id)
    if subagent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Subagent not found")
    await session.delete(subagent)
    await session.commit()
