"""Shared pytest setup — enforces DB/workspace isolation before any app import.

pytest imports ``conftest.py`` before it collects or imports any test module, so
this is the one place that can *guarantee* the app binds to a throwaway SQLite
file instead of the real ``lursor.db``.

Why it matters: ``app.config.get_settings`` is ``lru_cache``d and
``app.db.session`` builds the engine at *import* time, so the FIRST module to
import the app (directly, or transitively via e.g. ``app.agents.builder``, which
calls ``get_settings()`` at import) permanently binds the engine. When each test
file set ``DATABASE_URL`` itself this was order-fragile: any module that imported
app code without setting it first (``test_goal_loop``, ``test_tolerant_model``)
bound the engine to the real ``lursor.db`` and leaked test rows into it. Setting
the env here — once, up front — removes the ordering dependency entirely.
"""

from __future__ import annotations

import os
import tempfile

import pytest
from httpx import ASGITransport, AsyncClient

# Point the app at throwaway DB + workspace/skill dirs BEFORE it is imported.
_TMP = tempfile.mkdtemp(prefix="lursor-tests-")
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_TMP}/test.db"
os.environ["WORKSPACES_DIR"] = f"{_TMP}/workspaces"
os.environ["SKILLS_DIR"] = f"{_TMP}/skills"
# The developer running the suite almost certainly has a populated
# ``~/.claude/skills``; left at its default, skill discovery would index it and
# every scope assertion would depend on whose machine ran the tests. Tests that
# need a personal root point the setting at a tmp_path themselves.
os.environ["USER_SKILL_ROOTS"] = "[]"
# Auto-linking is on in production, where it is what puts every personal skill in
# the Skill Studio. Off by default here because it *rewrites* the state most of
# these tests are about: a suite asserting that a discovered skill stays
# ``external`` in the root that owns it would instead find a linked catalog row.
# The tests that cover auto-linking turn it on with the ``auto_link`` fixture.
os.environ["AUTO_LINK_USER_SKILLS"] = "false"
# Dummy key so provider construction succeeds offline (no network call is made).
os.environ.setdefault("OPENROUTER_API_KEY", "test-key-not-used")
# No LAIOS daemon in tests: drop any connection config the prod supervisor may
# have injected so the startup seed is a no-op and tests start from an empty
# connections table (see ``test_laios``).
os.environ.pop("LAIOS_URL", None)
os.environ.pop("LAIOS_MASTER_KEY", None)

# Warm the settings cache now, while the env above is guaranteed in place, so no
# later import can bind the engine to a different (or the real) database — and
# fail loudly if isolation is ever broken instead of silently writing to it.
from app.config import get_settings  # noqa: E402

_db_url = get_settings().database_url
if _TMP not in _db_url:
    raise RuntimeError(
        f"Test DB isolation failed: engine would bind to {_db_url!r} instead of a "
        f"temp file under {_TMP!r}. Something imported the app before conftest set "
        "DATABASE_URL."
    )

from app.db.session import init_db  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture
async def client() -> AsyncClient:
    """An ``httpx`` client bound to the ASGI app over a freshly-initialized DB."""
    await init_db()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test/api") as c:
        yield c


@pytest.fixture
async def raising_client() -> AsyncClient:
    """Like ``client``, but returns the app's error *response* on a 500.

    ``ASGITransport`` re-raises an unhandled exception to the caller by default,
    which is what you want almost everywhere — and exactly wrong when the response
    to that exception is the thing under test. What the browser receives is the
    only thing that matters for those, so this hands it back unchanged.
    """
    await init_db()
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test/api") as c:
        yield c


@pytest.fixture
def user_root(tmp_path, monkeypatch):
    """A stand-in for ``~/.claude/skills``, pointed at by the settings object.

    Lives here rather than in one test module because several now need it, and a
    fixture imported across modules shadows itself on every use. ``get_settings``
    is ``lru_cache``d, so the live instance is patched in place rather than
    rebuilt — that is the same object every request reads.
    """
    root = tmp_path / "home-claude" / "skills"
    root.mkdir(parents=True)
    monkeypatch.setattr(
        get_settings(), "user_skill_roots", [str(root)], raising=False
    )
    return root


@pytest.fixture
def auto_link(monkeypatch):
    """Turn on production's auto-linking of personal skills into the catalog."""
    monkeypatch.setattr(
        get_settings(), "auto_link_user_skills", True, raising=False
    )
