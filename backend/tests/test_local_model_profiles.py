"""Tests for local (custom-provider) model reasoning wiring in ``builder``.

Local models are served through a generic ``OpenAIProvider``, which profiles by
OpenAI's own model-name allowlist. Without help, a non-OpenAI reasoning model
(e.g. DeepSeek-V4) is treated as non-reasoning: its unified ``thinking`` setting
is stripped before the request and its ``reasoning_content`` output is not
mapped. Two pieces cooperate to fix this:

- ``tolerant_model._local_family_profile`` (exercised here via ``resolve_model``)
  restores the vendor profile so ``supports_thinking`` / ``reasoning_content`` are
  honored. Its per-family unit coverage lives in ``test_tolerant_model.py``.
- ``builder._reasoning_chat_template_kwargs`` translates the UI thinking level
  into ``extra_body.chat_template_kwargs`` — the control knob a DeepSeek-V4 vLLM
  actually reads (the top-level ``reasoning_effort`` is ignored on this cluster).
"""

from __future__ import annotations

# DB / workspace isolation is handled in ``conftest.py`` before any app import.
from app.agents.builder import (
    _reasoning_chat_template_kwargs,
    build_deep_agent,
    resolve_model,
)
from app.agents.tolerant_model import TolerantOpenAIChatModel
from app.db.models import Agent, CustomProvider, ThinkingLevel


def test_resolve_model_attaches_deepseek_profile():
    providers = {
        "p1": CustomProvider(name="Local", base_url="http://127.0.0.1:4000/v1")
    }
    model = resolve_model("custom:p1:deepseek-v4-flash", providers)
    assert isinstance(model, TolerantOpenAIChatModel)
    # The restored family profile — not OpenAI's name-allowlist default — governs
    # it: reasoning on, reasoning tokens parsed, forced tool choice disabled.
    assert model.profile.get("supports_thinking") is True
    assert model.profile.get("openai_chat_thinking_field") == "reasoning_content"
    assert model.profile.get("openai_supports_tool_choice_required") is False


def test_resolve_model_attaches_glm_profile():
    providers = {
        "p1": CustomProvider(name="Local", base_url="http://127.0.0.1:4000/v1")
    }
    model = resolve_model("custom:p1:glm-5.2-quanttrio", providers)
    assert isinstance(model, TolerantOpenAIChatModel)
    # Multi-family coverage: GLM is a reasoning family too, so the profile turns
    # thinking on (the top-level reasoning_effort is emitted). NOTE: unlike
    # DeepSeek, GLM gets no chat_template_kwargs override (see below) — it is not
    # verified whether GLM's vLLM honors the top-level field.
    assert model.profile.get("supports_thinking") is True


def test_resolve_model_unknown_family_unchanged():
    providers = {
        "p1": CustomProvider(name="Local", base_url="http://127.0.0.1:4000/v1")
    }
    model = resolve_model("custom:p1:qwen3-coder", providers)
    assert isinstance(model, TolerantOpenAIChatModel)
    # An unrecognized family falls back to the generic OpenAI profile (no reasoning).
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
