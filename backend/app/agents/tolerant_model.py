"""A tolerant ``OpenAIChatModel`` for strict local OpenAI-compatible servers.

Ported from swarmcore. Deep agents (via pydantic-ai) emit request shapes that
cloud providers accept but that strict local chat templates (Qwen/Mistral-style,
served through vLLM/llama.cpp/LM Studio, often behind a LiteLLM proxy) reject.
This subclass normalizes the mapped OpenAI messages just before they go on the
wire so the same agent runs unchanged against a local backend.

Normalizers, all applied in :meth:`_map_messages` (which fires for both the
streaming and non-streaming paths, since it builds the *request*):

- ``_coalesce_leading_system_messages`` — pydantic-ai emits a ``SystemPromptPart``
  (from ``system_prompt=``) at index 0 *and* a separate system message for
  ``instructions=`` right after it. Strict templates reject the second with
  ``400 "System message must be at the beginning."`` (and some, e.g. a LiteLLM
  proxy in front of vLLM, reject *any* request with more than one system
  message). Merging the leading run into one message fixes it; harmless on
  cloud providers. Applied unconditionally.
- ``_normalize_tool_call_arguments`` — coerce every assistant
  ``tool_calls[*].function.arguments`` to valid JSON so strict validators don't
  reject echoed-back history. Applied unconditionally.
- ``_ensure_user_message_present`` — guarantee at least one ``user`` turn.
  Strict local templates reject a request with none (``400 "No user query found
  in messages."``). Gated on (local-only), since cloud providers tolerate it.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence

from openai.types import chat
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.settings import ModelSettings

logger = logging.getLogger(__name__)


class TolerantOpenAIChatModel(OpenAIChatModel):
    """``OpenAIChatModel`` that normalizes messages for strict local servers.

    See the module docstring for the full rationale. All normalization happens
    in :meth:`_map_messages`; every helper is best-effort and never raises, so a
    normalization bug can only ever leave the request as pydantic-ai built it.
    """

    # Whether to guarantee at least one ``user``-role message in the outgoing
    # request. Cloud providers tolerate the absence; strict local templates
    # reject it. Set per-instance at construction; defaults off.
    _ensure_user_message: bool = False

    async def _map_messages(
        self,
        messages: Sequence[ModelMessage],
        model_request_parameters: ModelRequestParameters,
        *,
        model_settings: ModelSettings | None = None,
    ) -> list[chat.ChatCompletionMessageParam]:
        openai_messages = await super()._map_messages(
            messages, model_request_parameters, model_settings=model_settings
        )
        openai_messages = _coalesce_leading_system_messages(openai_messages)
        openai_messages = _normalize_tool_call_arguments(openai_messages)
        if self._ensure_user_message:
            openai_messages = _ensure_user_message_present(openai_messages)
        return openai_messages


def _coalesce_leading_system_messages(
    messages: list[chat.ChatCompletionMessageParam],
) -> list[chat.ChatCompletionMessageParam]:
    """Merge consecutive leading system/developer messages into one."""
    leading: list[str] = []
    role: str | None = None
    cut = 0
    for m in messages:
        m_role = m.get("role")
        if m_role not in ("system", "developer"):
            break
        content = m.get("content")
        if isinstance(content, str):
            leading.append(content)
        elif isinstance(content, list):
            for part in content:
                text = part.get("text") if isinstance(part, dict) else None
                if isinstance(text, str):
                    leading.append(text)
        role = m_role
        cut += 1

    if cut <= 1:
        return messages

    merged_content = "\n\n".join(s for s in leading if s)
    if role == "developer":
        merged: chat.ChatCompletionMessageParam = chat.ChatCompletionDeveloperMessageParam(
            role="developer", content=merged_content
        )
    else:
        merged = chat.ChatCompletionSystemMessageParam(role="system", content=merged_content)
    return [merged, *messages[cut:]]


def _coerce_json_arguments(args: str) -> str:
    """Return ``args`` if it parses as JSON, else a valid-JSON replacement."""
    stripped = args.strip()
    if not stripped:
        return "{}"
    try:
        json.loads(stripped)
        return args
    except (ValueError, TypeError):
        return json.dumps({"__raw_arguments__": args})


def _normalize_tool_call_arguments(
    messages: list[chat.ChatCompletionMessageParam],
) -> list[chat.ChatCompletionMessageParam]:
    """Coerce every assistant ``tool_calls[*].function.arguments`` to valid JSON.

    Some code-tuned models stream a tool call whose ``arguments`` is not a JSON
    object — an empty/whitespace string for a no-arg tool, or raw text.
    Pydantic-ai stores that verbatim, so on the *next* request it is echoed back
    in the history and a strict validator rejects the whole request. We rewrite
    any non-JSON ``arguments``: empty/whitespace becomes ``"{}"``; other invalid
    text is preserved (not silently dropped) by wrapping it as
    ``{"__raw_arguments__": <text>}``. Well-formed arguments are left untouched.
    Best-effort: any failure returns the messages unchanged.
    """
    try:
        out: list[chat.ChatCompletionMessageParam] = []
        for msg in messages:
            tool_calls = msg.get("role") == "assistant" and msg.get("tool_calls")
            if not tool_calls:
                out.append(msg)
                continue
            new_calls = []
            changed = False
            for call in tool_calls:
                fn = call.get("function") if isinstance(call, dict) else None
                args = fn.get("arguments") if isinstance(fn, dict) else None
                if isinstance(args, str):
                    fixed = _coerce_json_arguments(args)
                    if fixed != args:
                        call = {**call, "function": {**fn, "arguments": fixed}}
                        changed = True
                new_calls.append(call)
            out.append({**msg, "tool_calls": new_calls} if changed else msg)
        return out
    except Exception:  # noqa: BLE001 — message normalization must never break a run
        logger.debug("tool-call argument normalization skipped", exc_info=True)
        return messages


# Continuation nudge inserted when a request would otherwise carry no user turn.
# Kept terse so it adds negligible context and reads as a natural prompt.
_CONTINUATION_USER_MESSAGE = (
    "Continue from the conversation summarized above and proceed with the task."
)


def _ensure_user_message_present(
    messages: list[chat.ChatCompletionMessageParam],
) -> list[chat.ChatCompletionMessageParam]:
    """Guarantee at least one ``user``-role message for strict local templates.

    Context compaction can fold the original user task into a system message and
    leave only assistant/tool messages behind — a shape strict local chat
    templates reject (``400 "No user query found in messages."``). When no user
    turn is present, insert a minimal continuation message immediately after the
    leading system/developer block so role ordering stays valid.

    Best-effort: any failure returns the messages untouched.
    """
    try:
        if any(m.get("role") == "user" for m in messages):
            return messages
        insert_at = 0
        for m in messages:
            if m.get("role") not in ("system", "developer"):
                break
            insert_at += 1
        user_msg = chat.ChatCompletionUserMessageParam(
            role="user", content=_CONTINUATION_USER_MESSAGE
        )
        return [*messages[:insert_at], user_msg, *messages[insert_at:]]
    except Exception:  # noqa: BLE001 — message normalization must never break a run
        logger.debug("ensure-user-message skipped", exc_info=True)
        return messages
