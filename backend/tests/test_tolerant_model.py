"""Unit tests for the message normalizers in ``app.agents.tolerant_model``.

These guard the shapes strict local chat templates (Qwen/Mistral via
vLLM/llama.cpp/LM Studio, often behind a LiteLLM proxy) reject: more than one
leading system message, non-JSON tool-call arguments, and requests with no user
turn.
"""

from __future__ import annotations

import json

from app.agents.tolerant_model import (
    _coalesce_leading_system_messages as coalesce,
)
from app.agents.tolerant_model import (
    _ensure_user_message_present as ensure_user,
)
from app.agents.tolerant_model import (
    _normalize_tool_call_arguments as normalize_args,
)


def test_coalesce_merges_two_leading_system_messages():
    msgs = [
        {"role": "system", "content": "A"},
        {"role": "system", "content": "B"},
        {"role": "user", "content": "hey"},
    ]
    out = coalesce(msgs)
    assert [m["role"] for m in out] == ["system", "user"]
    assert out[0]["content"] == "A\n\nB"


def test_coalesce_single_system_is_noop():
    msgs = [{"role": "system", "content": "A"}, {"role": "user", "content": "x"}]
    assert coalesce(msgs) == msgs


def test_coalesce_flattens_multipart_system_content():
    msgs = [
        {"role": "system", "content": [{"type": "text", "text": "A"}]},
        {"role": "system", "content": "B"},
        {"role": "user", "content": "x"},
    ]
    assert coalesce(msgs)[0]["content"] == "A\n\nB"


def test_coalesce_stops_at_first_non_system():
    # A system message appearing after a user turn is left where it is (the
    # producer never emits this; the helper only collapses a *leading* run).
    msgs = [
        {"role": "system", "content": "A"},
        {"role": "user", "content": "x"},
        {"role": "system", "content": "B"},
    ]
    assert coalesce(msgs) == msgs


def test_coalesce_preserves_developer_role():
    msgs = [
        {"role": "developer", "content": "A"},
        {"role": "developer", "content": "B"},
        {"role": "user", "content": "x"},
    ]
    out = coalesce(msgs)
    assert out[0]["role"] == "developer"
    assert out[0]["content"] == "A\n\nB"


def test_normalize_tool_call_arguments():
    msgs = [
        {
            "role": "assistant",
            "tool_calls": [
                {"id": "1", "type": "function", "function": {"name": "f", "arguments": "  "}},
                {"id": "2", "type": "function", "function": {"name": "g", "arguments": "not json"}},
                {"id": "3", "type": "function", "function": {"name": "h", "arguments": '{"a":1}'}},
            ],
        }
    ]
    calls = normalize_args(msgs)[0]["tool_calls"]
    assert calls[0]["function"]["arguments"] == "{}"
    assert json.loads(calls[1]["function"]["arguments"])["__raw_arguments__"] == "not json"
    assert calls[2]["function"]["arguments"] == '{"a":1}'


def test_normalize_leaves_non_tool_messages_untouched():
    msgs = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "yo"}]
    assert normalize_args(msgs) == msgs


def test_ensure_user_message_inserts_after_leading_system_block():
    msgs = [{"role": "system", "content": "s"}, {"role": "assistant", "content": "a"}]
    out = ensure_user(msgs)
    assert [m["role"] for m in out] == ["system", "user", "assistant"]


def test_ensure_user_message_noop_when_user_present():
    msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "x"}]
    assert ensure_user(msgs) == msgs
