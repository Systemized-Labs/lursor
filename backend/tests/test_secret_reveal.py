"""The reveal routes hand a stored secret back in full, on explicit request.

Every other read of these secrets is a hint ("…9xyz"), so these two endpoints
are the only place a key can leave the server intact — worth pinning down that
they return the *effective* value and stay shut when nothing is stored.
"""

from __future__ import annotations


async def test_reveal_openrouter_returns_the_saved_key(client):
    await client.put("/settings/openrouter", json={"api_key": "sk-or-secret-9xyz"})

    resp = await client.get("/settings/openrouter/reveal")
    assert resp.status_code == 200
    assert resp.json() == {"api_key": "sk-or-secret-9xyz", "source": "database"}

    # The status route still only ever hints at it.
    status_body = (await client.get("/settings/openrouter")).json()
    assert status_body["key_hint"] == "…9xyz"
    assert "sk-or-secret-9xyz" not in str(status_body)


async def test_reveal_openrouter_falls_back_to_the_env_key(client):
    """Clearing a saved key reverts to the environment's — reveal follows it."""
    await client.put("/settings/openrouter", json={"api_key": "sk-or-secret-9xyz"})
    await client.delete("/settings/openrouter")

    from app.config import get_settings

    body = (await client.get("/settings/openrouter/reveal")).json()
    assert body["source"] == "env"
    # Whatever the environment supplies (conftest guarantees *something*), never
    # the key that was just deleted.
    assert body["api_key"] == get_settings().openrouter_api_key
    assert body["api_key"] != "sk-or-secret-9xyz"


async def test_reveal_web_search_keys(client, monkeypatch):
    """Both keyed providers reveal independently; unkeyed ones have no route."""
    from app.config import get_settings

    # The developer's own .env may well hold real search keys; blank them so
    # "nothing stored" means nothing stored.
    monkeypatch.setattr(get_settings(), "tavily_api_key", None, raising=False)
    monkeypatch.setattr(get_settings(), "exa_api_key", None, raising=False)
    assert (await client.get("/settings/web-search/tavily/reveal")).status_code == 404

    await client.put("/settings/web-search", json={"tavily_api_key": "tvly-abc123"})
    await client.put("/settings/web-search", json={"exa_api_key": "exa_def456"})

    tavily = (await client.get("/settings/web-search/tavily/reveal")).json()
    assert tavily == {
        "provider": "tavily",
        "api_key": "tvly-abc123",
        "source": "database",
    }
    exa = (await client.get("/settings/web-search/exa/reveal")).json()
    assert exa["api_key"] == "exa_def456"

    # ``native``/``duckduckgo`` hold no key, so the path type rejects them.
    assert (
        await client.get("/settings/web-search/duckduckgo/reveal")
    ).status_code == 422

    # Saving one key must not have clobbered the other, and the status route
    # still only hints at both.
    status_body = (await client.get("/settings/web-search")).json()
    assert status_body["tavily_key_hint"] == "…c123"
    assert status_body["exa_key_hint"] == "…f456"

    # The suite shares one database file; leave the keys as found.
    await client.put(
        "/settings/web-search", json={"tavily_api_key": None, "exa_api_key": None}
    )


async def test_reveal_github_token(client):
    from sqlmodel import select

    from app.db.models import GitHubConfig
    from app.db.session import async_session_factory

    # Nothing connected yet: no secret to hand over.
    assert (await client.get("/github/config/token")).status_code == 400

    # Written directly rather than via PUT /github/config, which validates the
    # token against the real GitHub API and rewrites the git config on disk.
    async with async_session_factory() as session:
        session.add(GitHubConfig(token="ghp_secret_a1b2", login="ada"))
        await session.commit()

    resp = await client.get("/github/config/token")
    assert resp.status_code == 200
    assert resp.json() == {"token": "ghp_secret_a1b2"}
    assert (await client.get("/github/config")).json()["token_hint"] == "…a1b2"

    # The suite shares one database file; leave the connection table as found.
    async with async_session_factory() as session:
        cfg = (await session.execute(select(GitHubConfig))).scalars().first()
        await session.delete(cfg)
        await session.commit()
