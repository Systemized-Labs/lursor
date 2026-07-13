from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class SubagentCreate(BaseModel):
    name: str
    description: str = ""
    instructions: str = ""
    model: str | None = None


class SubagentUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    instructions: str | None = None
    model: str | None = None


class SubagentRead(BaseModel):
    id: str
    name: str
    description: str
    instructions: str
    model: str | None
    builtin_name: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# --- Subagent defaults (pydantic-deep built-ins + governing knobs) -------------


class ResolvedInt(BaseModel):
    """A single integer knob: what the library ships vs. the effective value."""

    library_default: int
    override: int | None
    effective: int


class BuiltinSubagentRead(BaseModel):
    """A pydantic-deep built-in subagent: its library default + current state."""

    name: str
    # Library defaults (read-only reference the UI shows and seeds edits from).
    default_description: str
    default_instructions: str
    # True unless the user disabled it.
    enabled: bool
    # The user's override, if any (an editable copy that wins at build time).
    override: SubagentRead | None = None


class SubagentDefaultsRead(BaseModel):
    max_nesting_depth: ResolvedInt
    builtins: list[BuiltinSubagentRead]


class SubagentDefaultsUpdate(BaseModel):
    """Partial update of the global subagent defaults.

    ``max_nesting_depth=None`` clears the override (revert to the library
    default). ``disabled_builtins`` replaces the disabled set wholesale.
    """

    max_nesting_depth: int | None = None
    clear_max_nesting_depth: bool = False
    disabled_builtins: list[str] | None = None


class BuiltinOverrideUpdate(BaseModel):
    """Create/update an editable override of a built-in subagent."""

    description: str
    instructions: str
    model: str | None = None
