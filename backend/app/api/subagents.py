"""Global subagents — reusable specialists any agent can delegate to.

A subagent is stored once and applies to every agent that has
``include_subagents`` enabled (there is no per-agent link — see
``db/models.py`` :class:`Subagent`). The builder turns each row into a
pydantic-deep ``SubAgentConfig`` at run time (``agents/builder.py``).

The ``/defaults`` and ``/builtins`` routes expose pydantic-deep's built-in
subagents (``general-purpose``, ``research``) plus the subagent-governing knobs,
so they can be viewed, overridden (an editable copy), or disabled. Overrides are
stored as ordinary :class:`Subagent` rows with ``builtin_name`` set; they are
hidden from the normal roster listing and win over the library default at build
time (see ``agents/deep_defaults.py``).
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
from app.db.models import AppConfig, Subagent
from app.db.session import get_session
from app.schemas.subagent import (
    BuiltinOverrideUpdate,
    BuiltinSubagentRead,
    ResolvedInt,
    SubagentCreate,
    SubagentDefaultsRead,
    SubagentDefaultsUpdate,
    SubagentRead,
    SubagentUpdate,
)

router = APIRouter(prefix="/subagents", tags=["subagents"])


# --- Defaults: pydantic-deep built-in subagents + governing knobs --------------


async def _get_app_config(session: AsyncSession) -> AppConfig | None:
    return (await session.execute(select(AppConfig))).scalars().first()


async def _override_rows(session: AsyncSession) -> dict[str, Subagent]:
    """Built-in override rows keyed by the built-in name they replace."""
    result = await session.execute(
        select(Subagent).where(Subagent.builtin_name.is_not(None))
    )
    return {sa.builtin_name: sa for sa in result.scalars().all()}


async def _defaults_payload(session: AsyncSession) -> SubagentDefaultsRead:
    cfg = await _get_app_config(session)
    raw = dict(cfg.deep_defaults) if cfg else {}
    resolved = resolve_subagent_defaults(raw)
    depth_override = raw.get("max_nesting_depth")
    disabled = set(resolved["disabled_builtins"])
    overrides = await _override_rows(session)

    builtins = [
        BuiltinSubagentRead(
            name=b["name"],
            default_description=b["description"],
            default_instructions=b["instructions"],
            enabled=b["name"] not in disabled,
            override=(
                SubagentRead.model_validate(overrides[b["name"]])
                if b["name"] in overrides
                else None
            ),
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


def _require_builtin(name: str) -> None:
    if name not in BUILTIN_SUBAGENT_NAMES:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"No built-in subagent named '{name}'"
        )


@router.put("/builtins/{name}", response_model=SubagentDefaultsRead)
async def upsert_builtin_override(
    name: str,
    payload: BuiltinOverrideUpdate,
    session: AsyncSession = Depends(get_session),
):
    """Create or update an editable override of a built-in subagent."""
    _require_builtin(name)
    overrides = await _override_rows(session)
    row = overrides.get(name)
    if row is None:
        row = Subagent(name=name, builtin_name=name)
    row.description = payload.description
    row.instructions = payload.instructions
    row.model = payload.model
    session.add(row)
    await session.commit()
    return await _defaults_payload(session)


@router.delete("/builtins/{name}", response_model=SubagentDefaultsRead)
async def delete_builtin_override(
    name: str, session: AsyncSession = Depends(get_session)
):
    """Remove a built-in's override, reverting it to the library default."""
    _require_builtin(name)
    overrides = await _override_rows(session)
    row = overrides.get(name)
    if row is not None:
        await session.delete(row)
        await session.commit()
    return await _defaults_payload(session)


# --- User subagent CRUD --------------------------------------------------------


@router.get("", response_model=list[SubagentRead])
async def list_subagents(session: AsyncSession = Depends(get_session)):
    # Built-in override rows (builtin_name set) are managed under /defaults; keep
    # them out of the user-authored roster.
    result = await session.execute(
        select(Subagent)
        .where(Subagent.builtin_name.is_(None))
        .order_by(Subagent.created_at)
    )
    return result.scalars().all()


@router.post("", response_model=SubagentRead, status_code=status.HTTP_201_CREATED)
async def create_subagent(
    payload: SubagentCreate, session: AsyncSession = Depends(get_session)
):
    subagent = Subagent(**payload.model_dump())
    session.add(subagent)
    await session.commit()
    await session.refresh(subagent)
    return subagent


@router.get("/{subagent_id}", response_model=SubagentRead)
async def get_subagent(subagent_id: str, session: AsyncSession = Depends(get_session)):
    subagent = await session.get(Subagent, subagent_id)
    if subagent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Subagent not found")
    return subagent


@router.patch("/{subagent_id}", response_model=SubagentRead)
async def update_subagent(
    subagent_id: str,
    payload: SubagentUpdate,
    session: AsyncSession = Depends(get_session),
):
    subagent = await session.get(Subagent, subagent_id)
    if subagent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Subagent not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(subagent, key, value)
    session.add(subagent)
    await session.commit()
    await session.refresh(subagent)
    return subagent


@router.delete("/{subagent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_subagent(
    subagent_id: str, session: AsyncSession = Depends(get_session)
):
    subagent = await session.get(Subagent, subagent_id)
    if subagent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Subagent not found")
    await session.delete(subagent)
    await session.commit()
