"""Unit coverage for the chat turn persistence helpers.

These guard the regression where a goal turn's streamed tool calls lived only in
the in-memory run buffer and were never written to the DB, so a reopened thread
came back empty. ``_tee_events`` must fold tool-call events into the accumulator,
and ``_persist_message`` must save a turn that produced tool calls even when its
final text is empty.
"""

from __future__ import annotations

from ag_ui.core import (
    EventType,
    ToolCallArgsEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)

from app.api.chat import _persist_message, _tee_events


async def _collect(events, *, strip_lifecycle=False):
    accumulated: list[str] = []
    tool_calls: dict[str, dict] = {}

    async def _gen():
        for e in events:
            yield e

    async for _ in _tee_events(
        _gen(), accumulated, tool_calls, strip_lifecycle=strip_lifecycle
    ):
        pass
    return accumulated, tool_calls


async def test_tee_events_accumulates_tool_calls():
    events = [
        ToolCallStartEvent(
            type=EventType.TOOL_CALL_START, tool_call_id="t1", tool_call_name="write_file"
        ),
        ToolCallArgsEvent(type=EventType.TOOL_CALL_ARGS, tool_call_id="t1", delta='{"path":'),
        ToolCallArgsEvent(type=EventType.TOOL_CALL_ARGS, tool_call_id="t1", delta='"a.txt"}'),
        ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            tool_call_id="t1",
            content="written",
            message_id="m1",
        ),
    ]
    _, tool_calls = await _collect(events)

    assert list(tool_calls) == ["t1"]
    call = tool_calls["t1"]
    assert call["name"] == "write_file"
    assert call["arguments"] == '{"path":"a.txt"}'
    assert call["result"] == "written"


async def test_persist_message_saves_tool_only_turn(client, monkeypatch):
    """A turn with no final text but real tool calls must still persist."""
    # A workspace + agent + thread to hang the message off (FK to threads).
    agent = (await client.post("/agents", json={"name": "A"})).json()
    ws = (await client.post("/workspaces", json={"name": "W"})).json()
    thread = (
        await client.post(
            "/threads", json={"workspace_id": ws["id"], "agent_id": agent["id"]}
        )
    ).json()

    await _persist_message(
        thread["id"],
        "assistant",
        "",
        tool_calls=[{"id": "t1", "name": "run", "arguments": "{}", "result": "ok"}],
    )

    msgs = (await client.get(f"/threads/{thread['id']}/messages")).json()
    assert len(msgs) == 1
    assert msgs[0]["role"] == "assistant"
    assert msgs[0]["content"] == ""
    assert msgs[0]["tool_calls"] == [
        {"id": "t1", "name": "run", "arguments": "{}", "result": "ok"}
    ]


async def test_persist_message_skips_fully_empty_turn(client):
    """No text and no tool calls → nothing written (unchanged guard behavior)."""
    agent = (await client.post("/agents", json={"name": "B"})).json()
    ws = (await client.post("/workspaces", json={"name": "W2"})).json()
    thread = (
        await client.post(
            "/threads", json={"workspace_id": ws["id"], "agent_id": agent["id"]}
        )
    ).json()

    await _persist_message(thread["id"], "assistant", "", tool_calls=[])

    msgs = (await client.get(f"/threads/{thread['id']}/messages")).json()
    assert msgs == []
