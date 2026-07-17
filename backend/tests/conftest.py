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
