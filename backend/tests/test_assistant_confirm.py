"""The confirmation protocol: a destructive tool blocks until the user answers.

The mechanism is a tool that ``await``\\ s an ``asyncio.Event`` while a card rides
out on the run's SSE stream. What has to hold: the card is published *before* the
wait (or nobody can answer it), a denial and a timeout both leave the target
alone, and the card is sticky so a reconnecting client still sees it.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from app.agents.chat_run_manager import chat_run_manager
from app.assistant import confirm as confirm_mod
from app.assistant.confirm import CONFIRM_EVENT_NAME, Confirmations


def _cards(thread_id: str) -> list[dict]:
    """What a reconnecting client would end up rendering, keyed by token.

    ``subscribe`` replays the buffer *and then* the sticky snapshot, so a live
    card legitimately arrives twice — the sticky copy is deliberately last so it
    wins when the buffer holds a staler version of the same token. Last-write
    per token is therefore the client's contract, and modelling it here is what
    makes these assertions about what the user sees rather than about frame
    counts.
    """
    queue, replay = chat_run_manager.subscribe(thread_id)
    chat_run_manager.unsubscribe(thread_id, queue)
    latest: dict[str, dict] = {}
    for line in replay:
        payload = json.loads(line.removeprefix("data: ").strip())
        if payload.get("name") == CONFIRM_EVENT_NAME:
            latest[payload["value"]["token"]] = payload["value"]
    return list(latest.values())


@pytest.fixture
def confirmations():
    """A fresh registry per test — the production one is a process singleton."""
    return Confirmations()


async def test_approval_unblocks_the_tool(confirmations):
    thread = "thread-approve"
    task = asyncio.create_task(
        confirmations.request(thread, action="lursor_delete_workspace", summary="s", impact="i")
    )
    await asyncio.sleep(0)  # let the request register and publish

    pending = confirmations.pending(thread)
    assert len(pending) == 1
    assert confirmations.resolve(pending[0]["token"], approved=True)
    assert await task is True


async def test_denial_leaves_the_target_alone(confirmations):
    thread = "thread-deny"
    task = asyncio.create_task(
        confirmations.request(thread, action="lursor_delete_agent", summary="s", impact="i")
    )
    await asyncio.sleep(0)

    token = confirmations.pending(thread)[0]["token"]
    assert confirmations.resolve(token, approved=False)
    assert await task is False


async def test_timeout_is_a_denial_never_a_default_yes(confirmations):
    """An abandoned card releases the run, and releases it as "no"."""
    result = await confirmations.request(
        "thread-timeout",
        action="lursor_delete_thread",
        summary="s",
        impact="i",
        timeout=0.01,
    )
    assert result is False
    # And the registry does not leak the entry.
    assert confirmations.pending("thread-timeout") == []


async def test_the_card_is_published_before_the_wait(confirmations):
    """A card that arrives after the block would be unanswerable."""
    thread = "thread-publish"
    task = asyncio.create_task(
        confirmations.request(
            thread,
            action="lursor_delete_workspace",
            summary='Delete the workspace "Scratch"',
            impact="3 conversation(s) go with it.",
        )
    )
    await asyncio.sleep(0)

    cards = _cards(thread)
    assert len(cards) == 1
    assert cards[0]["status"] == "pending"
    assert cards[0]["summary"] == 'Delete the workspace "Scratch"'
    assert cards[0]["impact"].startswith("3 conversation")

    confirmations.resolve(cards[0]["token"], approved=False)
    await task


async def test_a_settled_card_is_replayed_as_settled(confirmations):
    """A reconnect after the answer must not re-prompt.

    The outcome is published under the *same* sticky key, so it overwrites the
    live card rather than queueing behind it.
    """
    thread = "thread-settled"
    task = asyncio.create_task(
        confirmations.request(thread, action="lursor_delete_agent", summary="s", impact="i")
    )
    await asyncio.sleep(0)
    token = confirmations.pending(thread)[0]["token"]
    confirmations.resolve(token, approved=True)
    await task

    settled = [c for c in _cards(thread) if c["token"] == token]
    assert [c["status"] for c in settled] == ["approved"]


async def test_resolving_an_unknown_token_is_false(confirmations):
    """Covers "already settled" and "never existed" — both are a 404 upstream."""
    assert confirmations.resolve("no-such-token", approved=True) is False


async def test_double_resolution_only_lands_once(confirmations):
    thread = "thread-double"
    task = asyncio.create_task(
        confirmations.request(thread, action="lursor_delete_agent", summary="s", impact="i")
    )
    await asyncio.sleep(0)
    token = confirmations.pending(thread)[0]["token"]

    assert confirmations.resolve(token, approved=False) is True
    # A second click must not flip a denial into an approval.
    assert confirmations.resolve(token, approved=True) is False
    assert await task is False


async def test_the_module_singleton_exists():
    """Tools reach the registry through the module-level instance."""
    assert isinstance(confirm_mod.confirmations, Confirmations)
