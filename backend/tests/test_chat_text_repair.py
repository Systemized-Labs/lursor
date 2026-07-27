"""Unit coverage for ``_repair_text_messages``.

Guards the regression where a local Qwen model killed the live SSE subscription
mid-reply with ``Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message
found with ID '<uuid>'``. pydantic-ai's AG-UI stream stamps every text delta with
one "current" message id while its parts manager keys text on a stable vendor id,
so an earlier text part can be appended to after a tool call (or interleaved
``reasoning_content``) already closed it. The `@ag-ui/client` verifier *throws* on
that, tearing the stream down.

The invariant these tests encode is the verifier's own rule: every
TEXT_MESSAGE_CONTENT sits inside an open START…END pair, no END without a
matching START, and nothing after the terminal lifecycle event.
"""

from __future__ import annotations

from ag_ui.core import (
    EventType,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
)

from app.api.chat import _repair_text_messages


def start(message_id: str) -> TextMessageStartEvent:
    return TextMessageStartEvent(
        type=EventType.TEXT_MESSAGE_START, message_id=message_id
    )


def content(message_id: str, delta: str) -> TextMessageContentEvent:
    return TextMessageContentEvent(
        type=EventType.TEXT_MESSAGE_CONTENT, message_id=message_id, delta=delta
    )


def end(message_id: str) -> TextMessageEndEvent:
    return TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id)


async def repair(events: list) -> list:
    async def _gen():
        for e in events:
            yield e

    return [e async for e in _repair_text_messages(_gen())]


def assert_protocol_valid(events: list) -> None:
    """Mirror the `@ag-ui/client` verifier's text-message rules."""
    open_ids: set[str] = set()
    finished = False
    for event in events:
        etype = event.type
        assert not finished, f"{etype} sent after the run finished"
        message_id = getattr(event, "message_id", None)
        if etype == EventType.TEXT_MESSAGE_START:
            assert message_id not in open_ids, f"{message_id} already in progress"
            open_ids.add(message_id)
        elif etype == EventType.TEXT_MESSAGE_CONTENT:
            assert message_id in open_ids, f"no active text message {message_id}"
        elif etype == EventType.TEXT_MESSAGE_END:
            assert message_id in open_ids, f"no active text message {message_id}"
            open_ids.discard(message_id)
        elif etype in (EventType.RUN_FINISHED, EventType.RUN_ERROR):
            finished = True
    assert not open_ids, f"text messages left open: {open_ids}"


async def test_content_after_close_reopens_the_same_message():
    """The Qwen shape: text → tool call → more text on the *same* message id.

    The reopened id must be the original one, not a fresh one: the AG-UI client
    keeps one message per id and only creates it when absent, so reusing it keeps
    the trailing prose in the same assistant bubble — matching the single message
    we persist for the turn.
    """
    out = await repair(
        [
            RunStartedEvent(type=EventType.RUN_STARTED, thread_id="t", run_id="r"),
            start("m1"),
            content("m1", "Let me read the file."),
            end("m1"),
            ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id="c1",
                tool_call_name="read_file",
            ),
            ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id="c1"),
            content("m1", "\n\n"),  # server flushed trailing content
            content("m1", "Done."),
            RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id="t", run_id="r"),
        ]
    )

    assert_protocol_valid(out)
    types = [e.type for e in out]
    # Exactly one injected START, and it reuses the original id.
    assert types.count(EventType.TEXT_MESSAGE_START) == 2
    reopened = out[types.index(EventType.TOOL_CALL_END) + 1]
    assert reopened.type == EventType.TEXT_MESSAGE_START
    assert reopened.message_id == "m1"
    # The reopened message is closed before RUN_FINISHED, not after.
    assert types[-2:] == [EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED]


async def test_content_without_any_start_opens_a_message():
    """A delta for a never-started id still gets a START (not just a reopen)."""
    out = await repair(
        [
            RunStartedEvent(type=EventType.RUN_STARTED, thread_id="t", run_id="r"),
            content("m1", "hello"),
            RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id="t", run_id="r"),
        ]
    )

    assert_protocol_valid(out)
    assert [e.type for e in out] == [
        EventType.RUN_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.RUN_FINISHED,
    ]


async def test_orphan_end_is_dropped():
    """An END for a message that isn't open closes nothing and is equally fatal."""
    out = await repair([start("m1"), content("m1", "hi"), end("m1"), end("m1")])

    assert_protocol_valid(out)
    assert [e.type for e in out].count(EventType.TEXT_MESSAGE_END) == 1


async def test_open_message_closed_before_run_error():
    """RUN_ERROR is terminal for the verifier too — flush before it, not after."""
    out = await repair(
        [
            start("m1"),
            content("m1", "partial"),
            RunErrorEvent(type=EventType.RUN_ERROR, message="boom"),
        ]
    )

    assert_protocol_valid(out)
    assert [e.type for e in out][-2:] == [
        EventType.TEXT_MESSAGE_END,
        EventType.RUN_ERROR,
    ]


async def test_open_message_closed_at_stream_end_when_lifecycle_stripped():
    """Goal/plan mode strips the per-turn lifecycle, so the flush lands at EOF.

    Each turn is wrapped separately, so a turn that ends mid-text must not leak an
    open message into the next turn's events on the same SSE stream.
    """
    out = await repair([start("m1"), content("m1", "partial")])

    assert_protocol_valid(out)
    assert [e.type for e in out] == [
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
    ]


async def test_wellformed_stream_is_untouched():
    """The cloud-model path must pass through byte-identical."""
    events = [
        RunStartedEvent(type=EventType.RUN_STARTED, thread_id="t", run_id="r"),
        start("m1"),
        content("m1", "hello"),
        end("m1"),
        ToolCallStartEvent(
            type=EventType.TOOL_CALL_START, tool_call_id="c1", tool_call_name="ls"
        ),
        ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id="c1"),
        start("m2"),
        content("m2", "done"),
        end("m2"),
        RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id="t", run_id="r"),
    ]

    out = await repair(list(events))

    assert_protocol_valid(out)
    assert out == events
