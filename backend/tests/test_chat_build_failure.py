"""When the agent can't be built, the user has to be told what broke.

Assembling the agent reads most of the user's own configuration — the model
string, custom providers, subagent overrides, and every skill folder in scope —
so it is the step most likely to fail on something they can fix. It used to fail
as a bare 500: no CORS headers, so the browser reported ``Failed to fetch``, and
the reason (a malformed ``SKILL.md``, in the case that prompted this) existed only
in the server's terminal.

It also left a mark. The user's turn is persisted *before* the run starts, so it
survives a run that errors mid-stream — but a run that never started leaves that
message dangling at the end of the thread, and the retry the user then makes
duplicates it.
"""

from __future__ import annotations

import json

from ag_ui.core import RunAgentInput, UserMessage
from httpx import AsyncClient

ORIGIN = "http://localhost:8888"


def _explode(*args, **kwargs):
    """Stand-in for the real builder, failing the way a bad skill folder does."""
    raise ValueError("Failed to parse YAML frontmatter: mapping values are not allowed")


async def _thread(client: AsyncClient) -> dict:
    agent = (await client.post("/agents", json={"name": "Builder"})).json()
    ws = (await client.post("/workspaces", json={"name": "BuildWS"})).json()
    return (
        await client.post(
            "/threads", json={"workspace_id": ws["id"], "agent_id": agent["id"]}
        )
    ).json()


def _turn(thread_id: str, text: str) -> str:
    return RunAgentInput(
        thread_id=thread_id,
        run_id="run-1",
        state=None,
        messages=[UserMessage(id="m1", role="user", content=text)],
        tools=[],
        context=[],
        forwarded_props={"turn": "chat"},
    ).model_dump_json(by_alias=True)


async def test_a_failed_build_reports_the_reason(
    raising_client: AsyncClient, monkeypatch
) -> None:
    monkeypatch.setattr("app.api.chat.build_deep_agent", _explode)
    thread = await _thread(raising_client)

    response = await raising_client.post(
        f"/threads/{thread['id']}/chat",
        content=_turn(thread["id"], "hello"),
        headers={
            "accept": "text/event-stream",
            "content-type": "application/json",
            "origin": ORIGIN,
        },
    )

    assert response.status_code == 500
    detail = response.json()["detail"]
    assert "Could not start the run" in detail
    assert "Failed to parse YAML frontmatter" in detail, (
        "the actual cause never reached the client"
    )
    # An HTTPException is raised inside the middleware stack, so CORS applies —
    # this is what stops the browser from reporting it as a network failure.
    assert response.headers.get("access-control-allow-origin") == ORIGIN


async def test_a_failed_build_withdraws_the_user_turn(
    raising_client: AsyncClient, monkeypatch
) -> None:
    monkeypatch.setattr("app.api.chat.build_deep_agent", _explode)
    thread = await _thread(raising_client)

    failed = await raising_client.post(
        f"/threads/{thread['id']}/chat",
        content=_turn(thread["id"], "hello"),
        headers={"accept": "text/event-stream", "content-type": "application/json"},
    )
    assert failed.status_code == 500

    msgs = (await raising_client.get(f"/threads/{thread['id']}/messages")).json()
    assert msgs == [], f"a run that never started left a turn behind: {msgs}"


async def test_repeated_failures_do_not_pile_up_messages(
    raising_client: AsyncClient, monkeypatch
) -> None:
    """The retry loop a user actually does when a send keeps failing."""
    monkeypatch.setattr("app.api.chat.build_deep_agent", _explode)
    thread = await _thread(raising_client)

    for _ in range(3):
        await raising_client.post(
            f"/threads/{thread['id']}/chat",
            content=_turn(thread["id"], "hello"),
            headers={"accept": "text/event-stream", "content-type": "application/json"},
        )

    msgs = (await raising_client.get(f"/threads/{thread['id']}/messages")).json()
    assert msgs == [], f"{len(msgs)} orphan turns after three failed sends"


async def test_the_thread_is_left_idle_and_usable(
    raising_client: AsyncClient, monkeypatch
) -> None:
    """No half-started run: the thread must not be stuck showing a live status."""
    monkeypatch.setattr("app.api.chat.build_deep_agent", _explode)
    thread = await _thread(raising_client)

    await raising_client.post(
        f"/threads/{thread['id']}/chat",
        content=_turn(thread["id"], "hello"),
        headers={"accept": "text/event-stream", "content-type": "application/json"},
    )

    refreshed = (await raising_client.get(f"/threads/{thread['id']}")).json()
    assert refreshed["status"] == "idle"
    active = (await raising_client.get("/threads/active-runs")).json()
    assert thread["id"] not in json.dumps(active)
