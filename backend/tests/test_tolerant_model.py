"""Unit tests for the message normalizers in ``app.agents.tolerant_model``.

These guard the shapes strict local chat templates (Qwen/Mistral via
vLLM/llama.cpp/LM Studio, often behind a LiteLLM proxy) reject: more than one
leading system message, non-JSON tool-call arguments, and requests with no user
turn.
"""

from __future__ import annotations

import json

from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.settings import ModelSettings

from app.agents.tolerant_model import (
    TolerantOpenAIChatModel,
    _local_family_profile,
)
from app.agents.tolerant_model import (
    _coalesce_leading_system_messages as coalesce,
)
from app.agents.tolerant_model import (
    _ensure_user_message_present as ensure_user,
)
from app.agents.tolerant_model import (
    _normalize_tool_call_arguments as normalize_args,
)


def _local_model(model_name: str) -> TolerantOpenAIChatModel:
    """A tolerant model wired to a fake local OpenAI-compatible endpoint."""
    return TolerantOpenAIChatModel(
        model_name,
        provider=OpenAIProvider(base_url="http://127.0.0.1:4000/v1", api_key="x"),
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


# --- reasoning model-profile restoration -----------------------------------
#
# A local reasoning model reached through the generic OpenAIProvider would get
# supports_thinking=False, so pydantic-ai strips the unified `thinking` setting
# and the UI's effort choice never reaches the server. These guard that the
# family profile is restored and the effort actually survives onto the wire.


def test_family_profile_enables_thinking_for_deepseek_v4():
    prof = _local_family_profile("deepseek-v4-flash")
    assert prof is not None
    assert prof.get("supports_thinking") is True
    # Reasoning tokens come back in `reasoning_content` on vLLM for this family.
    assert prof.get("openai_chat_thinking_field") == "reasoning_content"


def test_family_profile_matches_path_qualified_name_case_insensitively():
    prof = _local_family_profile("deepseek-ai/DeepSeek-V4-Flash")
    assert prof is not None and prof.get("supports_thinking") is True


def test_family_profile_none_for_unknown_model():
    assert _local_family_profile("some-random-llm") is None


def test_resolved_profile_enables_thinking_but_keeps_forcing_disabled():
    prof = _local_model("deepseek-v4-flash").profile
    assert prof.get("supports_thinking") is True
    # The tolerant hack must still win: forced tool choice stays off.
    assert prof.get("openai_supports_tool_choice_required") is False


def test_ui_effort_survives_to_reasoning_effort_for_deepseek_v4():
    model = _local_model("deepseek-v4-flash")
    settings, params = model.prepare_request(
        ModelSettings(thinking="medium"), ModelRequestParameters()
    )
    assert model._translate_thinking(settings or {}, params) == "medium"


def test_unknown_model_still_drops_thinking_but_disables_forcing():
    model = _local_model("some-random-llm")
    assert model.profile.get("supports_thinking") is False
    assert model.profile.get("openai_supports_tool_choice_required") is False
    settings, params = model.prepare_request(
        ModelSettings(thinking="medium"), ModelRequestParameters()
    )
    # No family profile -> thinking is stripped -> no reasoning_effort emitted.
    from pydantic_ai.models.openai import OMIT

    assert model._translate_thinking(settings or {}, params) is OMIT
