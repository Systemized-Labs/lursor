"""Lursor plugin for Hermes.

Wires Hermes to a local Lursor instance so it can hand real work to a Lursor
agent — one rooted in a directory on this machine, with a shell, a filesystem and
a git working tree — and then read back what happened.

``register`` is called once at startup. If it raises, Hermes disables the plugin
and carries on, so nothing here does I/O: reachability is discovered when a tool
is actually called, and reported as a readable error rather than by making the
tools disappear (a vanished tool teaches the model nothing).
"""

from __future__ import annotations

import contextlib
from pathlib import Path

from . import client, schemas, tools

TOOLSET = "lursor"

_TOOLS = (
    (schemas.WORKSPACES, tools.workspaces),
    (schemas.AGENTS, tools.agents),
    (schemas.THREADS, tools.threads),
    (schemas.MESSAGES, tools.messages),
    (schemas.DELEGATE, tools.delegate),
    (schemas.RUN_STATUS, tools.run_status),
    (schemas.STOP_RUN, tools.stop_run),
    (schemas.DIFF, tools.diff),
    (schemas.LIST_FILES, tools.list_files),
    (schemas.READ_FILE, tools.read_file),
)


def _on_pre_llm_call(*args, **kwargs):
    """Tell the agent when a background delegation has landed.

    Only does anything when this session has a delegation in flight, so an
    ordinary turn costs nothing. A finished run is announced once and then
    forgotten — the agent can read the result properly with lursor_run_status.
    """
    watched = tools.watched_threads()
    if not watched:
        return None
    try:
        active = set(client.request("GET", "/threads/active-runs") or [])
    except client.LursorError:
        return None  # Lursor went away; not worth interrupting the turn over

    landed = [tid for tid in watched if tid not in active]
    if not landed:
        return None
    for tid in landed:
        tools.forget(tid)
    lines = [
        "A Lursor run you delegated has finished: {ids}. Read the outcome with "
        "lursor_run_status, then check lursor_diff if it was meant to change "
        "files.".format(ids=", ".join(landed))
    ]
    still = [tid for tid in watched if tid in active]
    if still:
        lines.append("Still running: {ids}.".format(ids=", ".join(still)))
    return {"context": "\n".join(lines)}


def _slash_status(raw_args):
    """`/lursor` — where Lursor is, what it has, and what is running."""
    return tools.status_text()


def _setup_cli(parser):
    sub = parser.add_subparsers(dest="lursor_cmd")
    sub.add_parser("status", help="Show Lursor's address, inventory and live runs")
    sub.add_parser("workspaces", help="List Lursor workspaces")
    sub.add_parser("agents", help="List Lursor agents")


def _handle_cli(args):
    command = getattr(args, "lursor_cmd", None) or "status"
    if command == "workspaces":
        print(tools.workspaces({}))
    elif command == "agents":
        print(tools.agents({}))
    else:
        print(tools.status_text())
    return 0


def _register_skills(ctx):
    skills_dir = Path(__file__).parent / "skills"
    if not skills_dir.is_dir():
        return
    for child in sorted(skills_dir.iterdir()):
        skill_md = child / "SKILL.md"
        if child.is_dir() and skill_md.exists():
            ctx.register_skill(child.name, skill_md)


def register(ctx):
    for schema, fn in _TOOLS:
        ctx.register_tool(
            name=schema["name"], toolset=TOOLSET, schema=schema, handler=fn
        )

    ctx.register_hook("pre_llm_call", _on_pre_llm_call)

    # The surfaces below are conveniences, not the plugin's reason to exist — an
    # older Hermes that lacks any of them should still get the tools.
    with contextlib.suppress(AttributeError, TypeError):
        ctx.register_command(
            "lursor",
            handler=_slash_status,
            description="Show Lursor status and any runs in flight",
        )
    with contextlib.suppress(AttributeError, TypeError):
        ctx.register_cli_command(
            name="lursor",
            help="Inspect the local Lursor instance",
            setup_fn=_setup_cli,
            handler_fn=_handle_cli,
        )
    with contextlib.suppress(AttributeError, TypeError):
        _register_skills(ctx)
