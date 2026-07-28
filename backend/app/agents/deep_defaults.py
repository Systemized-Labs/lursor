"""View / override the pydantic-deep *subagent* defaults.

pydantic-deep ships two built-in subagents (``general-purpose`` and ``research``)
and a handful of subagent-governing knobs, all hardcoded in the library. This
module surfaces those library defaults so the UI can display them, and resolves
the effective value from a global override stored on :class:`AppConfig`.

Resolution is a two-step chain:

    global override (AppConfig.deep_defaults)  →  library default

A key absent from the override blob means "inherit the library default". A built-in
subagent is otherwise take-it-or-leave-it: it can be *disabled* (listed in
``disabled_builtins``) but not edited — to change what one does, disable it and
create an ordinary :class:`Subagent`, which can express strictly more. Everything
here is intentionally scoped to subagents; the wider ``create_deep_agent`` surface
is left at library defaults for now.
"""

from __future__ import annotations

from typing import TypedDict

from pydantic_deep.subagents import BUILTIN_SUBAGENTS

# --- Library defaults ----------------------------------------------------------

# create_deep_agent(max_nesting_depth=1) — how deep subagent delegation may nest.
LIBRARY_MAX_NESTING_DEPTH = 1


class BuiltinSubagentDefault(TypedDict):
    """A pydantic-deep built-in subagent as the library ships it."""

    name: str
    description: str
    instructions: str


def builtin_subagent_defaults() -> list[BuiltinSubagentDefault]:
    """The library's built-in subagents (name/description/instructions)."""
    return [
        {
            "name": b["name"],
            "description": b["description"],
            "instructions": b["instructions"],
        }
        for b in BUILTIN_SUBAGENTS
    ]


BUILTIN_SUBAGENT_NAMES: frozenset[str] = frozenset(
    b["name"] for b in BUILTIN_SUBAGENTS
)


# --- Resolution ----------------------------------------------------------------


class ResolvedSubagentDefaults(TypedDict):
    max_nesting_depth: int
    disabled_builtins: list[str]


def resolve_subagent_defaults(
    overrides: dict | None,
) -> ResolvedSubagentDefaults:
    """Fold a ``AppConfig.deep_defaults`` blob over the library defaults."""
    overrides = overrides or {}

    depth = overrides.get("max_nesting_depth")
    if not isinstance(depth, int) or depth < 0:
        depth = LIBRARY_MAX_NESTING_DEPTH

    disabled = overrides.get("disabled_builtins")
    if not isinstance(disabled, list):
        disabled = []
    # Only names that are actually built-ins are meaningful.
    disabled = [n for n in disabled if n in BUILTIN_SUBAGENT_NAMES]

    return {"max_nesting_depth": depth, "disabled_builtins": disabled}
