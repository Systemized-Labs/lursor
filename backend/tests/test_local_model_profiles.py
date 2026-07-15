"""Tests for local (custom-provider) model capability profiles.

Local models are served through a generic ``OpenAIProvider``, which profiles by
OpenAI's own model-name allowlist. Without an explicit profile, a non-OpenAI
reasoning model (e.g. DeepSeek-V4) is treated as non-reasoning: its unified
``thinking`` setting is stripped before the request and its ``reasoning_content``
output is not mapped. ``builder._local_model_profile`` fixes that by reusing the
vendor profiles pydantic-ai ships.
"""

from __future__ import annotations

import os
import tempfile

_tmp = tempfile.mkdtemp(prefix="lursor-test-profiles-")
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_tmp}/test.db"
os.environ["WORKSPACES_DIR"] = f"{_tmp}/workspaces"
os.environ.setdefault("OPENROUTER_API_KEY", "test-key-not-used")

from app.agents.builder import (  # noqa: E402
    _local_model_profile,
    _reasoning_chat_template_kwargs,
    build_deep_agent,
    resolve_model,
)
from app.agents.tolerant_model import TolerantOpenAIChatModel  # noqa: E402
from app.db.models import Agent, CustomProvider, ThinkingLevel  # noqa: E402


def test_deepseek_v4_profile_enables_reasoning():
    profile = _local_model_profile("deepseek-v4-flash")
    assert profile is not None
    # Reasoning is honored (so the UI thinking level reaches the server) ...
    assert profile.get("supports_thinking") is True
    # ... thinking is parsed from DeepSeek's non-standard field ...
    assert profile.get("openai_chat_thinking_field") == "reasoning_content"
    # ... and tool_choice=required is disabled (DeepSeek-V4 rejects it).
    assert profile.get("openai_supports_tool_choice_required") is False


def test_deepseek_reasoner_profile():
    profile = _local_model_profile("deepseek-r1")
    assert profile is not None
    assert profile.get("supports_thinking") is True


def test_non_deepseek_models_use_provider_default():
    # Unrecognized models return None, preserving prior provider-default behavior.
    assert _local_model_profile("glm-5.2-quanttrio") is None
    assert _local_model_profile("qwen3-coder") is None
    assert _local_model_profile("gpt-4o") is None


def test_resolve_model_attaches_deepseek_profile():
    providers = {
        "p1": CustomProvider(name="Local", base_url="http://127.0.0.1:4000/v1")
    }
    model = resolve_model("custom:p1:deepseek-v4-flash", providers)
    assert isinstance(model, TolerantOpenAIChatModel)
    # The attached profile — not OpenAI's name-allowlist default — governs it.
    assert model.profile.get("supports_thinking") is True
    assert model.profile.get("openai_supports_tool_choice_required") is False


def test_resolve_model_non_deepseek_unchanged():
    providers = {
        "p1": CustomProvider(name="Local", base_url="http://127.0.0.1:4000/v1")
    }
    model = resolve_model("custom:p1:glm-5.2-quanttrio", providers)
    assert isinstance(model, TolerantOpenAIChatModel)
    # Falls back to the generic OpenAI profile (no reasoning for unknown names).
    assert model.profile.get("supports_thinking") is False


def _deepseek_model():
    providers = {
        "p1": CustomProvider(name="Local", base_url="http://127.0.0.1:4000/v1")
    }
    return resolve_model("custom:p1:deepseek-v4-flash", providers)


def test_chat_template_kwargs_for_deepseek_levels():
    model = _deepseek_model()
    # A concrete level enables thinking and carries the effort.
    assert _reasoning_chat_template_kwargs(model, "medium") == {
        "thinking": True,
        "reasoning_effort": "medium",
    }
    assert _reasoning_chat_template_kwargs(model, "high") == {
        "thinking": True,
        "reasoning_effort": "high",
    }
    # "off" (thinking=False) disables it — only expressible via chat_template_kwargs.
    assert _reasoning_chat_template_kwargs(model, False) == {"thinking": False}


def test_chat_template_kwargs_skips_non_deepseek():
    providers = {
        "p1": CustomProvider(name="Local", base_url="http://127.0.0.1:4000/v1")
    }
    glm = resolve_model("custom:p1:glm-5.2-quanttrio", providers)
    assert _reasoning_chat_template_kwargs(glm, "high") is None
    # Cloud strings resolve to a plain name (no model_name attr) -> honored natively.
    assert _reasoning_chat_template_kwargs("openrouter:deepseek/deepseek-chat", "high") is None


def test_build_deep_agent_injects_deepseek_chat_template_kwargs(tmp_path):
    prov = {"p1": CustomProvider(name="Local", base_url="http://127.0.0.1:4000/v1")}
    row = Agent(
        name="orchestrator",
        model="custom:p1:deepseek-v4-flash",
        thinking=ThinkingLevel.medium,
    )
    agent, _ = build_deep_agent(row, str(tmp_path), prov, [])
    ctk = (agent.model_settings or {}).get("extra_body", {}).get("chat_template_kwargs")
    assert ctk == {"thinking": True, "reasoning_effort": "medium"}


def test_build_deep_agent_off_disables_thinking(tmp_path):
    prov = {"p1": CustomProvider(name="Local", base_url="http://127.0.0.1:4000/v1")}
    row = Agent(
        name="orchestrator",
        model="custom:p1:deepseek-v4-flash",
        thinking=ThinkingLevel.off,
    )
    agent, _ = build_deep_agent(row, str(tmp_path), prov, [])
    ctk = (agent.model_settings or {}).get("extra_body", {}).get("chat_template_kwargs")
    assert ctk == {"thinking": False}


def test_build_deep_agent_non_deepseek_no_injection(tmp_path):
    prov = {"p1": CustomProvider(name="Local", base_url="http://127.0.0.1:4000/v1")}
    row = Agent(
        name="orchestrator",
        model="custom:p1:glm-5.2-quanttrio",
        thinking=ThinkingLevel.high,
    )
    agent, _ = build_deep_agent(row, str(tmp_path), prov, [])
    assert "chat_template_kwargs" not in (agent.model_settings or {}).get("extra_body", {})
