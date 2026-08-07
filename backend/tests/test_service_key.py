"""Inferred service identity for a long-running command.

The rules that matter are the *collapses* (spellings of one server that must
compare equal) and the *separations* (different servers that must not) — a wrong
collapse gets a live server killed by ``preview_service._retire_superseded``, so
the separations are the load-bearing half.
"""

from __future__ import annotations

import pytest

from app.agents.service_key import canonical, service_key, spawn_key

# Spellings that all mean "the dev server in ./frontend".
_FRONTEND_DEV = [
    "cd frontend && npm run dev",
    "cd ./frontend && npm run dev",
    "cd frontend/ && npm run dev",
    "cd './frontend' && npm run dev",
    "(cd frontend && npm run dev)",
    "cd frontend && npm run dev 2>&1",
    "cd  frontend  &&  npm   run  dev",
    "npm run dev --prefix frontend",
    "npm run dev --prefix=frontend",
    "npm run dev --cwd frontend",
]


@pytest.mark.parametrize("command", _FRONTEND_DEV)
def test_spellings_of_one_server_collapse(command):
    assert spawn_key(command) == spawn_key("cd frontend && npm run dev")


@pytest.mark.parametrize(
    "command", ["npm run dev", "cd . && npm run dev", "cd ./ && npm run dev"]
)
def test_workspace_root_is_the_empty_directory(command):
    """`.`, `./` and no directory at all are the same place, and the key for it
    carries no separator — so a root-level command reads as its own text."""
    assert spawn_key(command) == "npm run dev"


def test_different_directories_are_different_services():
    """The monorepo case: one command, two packages, two servers."""
    assert spawn_key("npm run dev") != spawn_key("cd frontend && npm run dev")
    assert spawn_key("cd api && npm run dev") != spawn_key("cd web && npm run dev")


def test_different_programs_in_one_directory_are_different_services():
    """A Vite server and a uvicorn server in the same root are both legitimate;
    collapsing them would have `_retire_superseded` kill one of them."""
    assert service_key("npm run dev") != service_key("uvicorn app.main:app")


def test_spawn_key_keeps_a_requested_port_but_service_key_does_not():
    """The two-key split. Asking for `--port 3001` must spawn its own process
    rather than silently reusing the server on 3000 — but once both are up they
    are still one service, and the older is the one to retire."""
    pinned = "npm run dev -- --port 3001"
    assert spawn_key(pinned) != spawn_key("npm run dev")
    assert service_key(pinned) == service_key("npm run dev")


@pytest.mark.parametrize(
    "pinned",
    [
        "npm run dev -- --port 3001",
        "npm run dev --port=3001",
        "vite -p 3001",
        "PORT=3001 npm run dev",
    ],
)
def test_port_spellings_are_all_dropped_from_the_service_key(pinned):
    unpinned = pinned.replace(" -- --port 3001", "")
    unpinned = unpinned.replace(" --port=3001", "").replace(" -p 3001", "")
    unpinned = unpinned.replace("PORT=3001 ", "")
    assert service_key(pinned) == service_key(unpinned)


def test_canonical_removes_the_directory_from_the_command():
    """Both halves are reported separately, and the command half is free of the
    navigation — otherwise the two spellings could never compare equal."""
    assert canonical("cd frontend && npm run dev") == ("frontend", "npm run dev")
    assert canonical("npm run dev --prefix frontend") == ("frontend", "npm run dev")
    assert canonical("npm run dev") == ("", "npm run dev")


def test_a_cd_wins_over_a_redundant_prefix_flag():
    """`cd frontend && npm run dev --prefix frontend` names one directory twice.
    The flag still has to leave the command text, or this would not match the
    plain `cd` spelling."""
    assert canonical("cd frontend && npm run dev --prefix frontend") == (
        "frontend",
        "npm run dev",
    )
