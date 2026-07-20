"""Vision support for agents: the ``view_image`` tool + model capability check.

``view_image`` is how a text-only agent *understands* an image. It makes an
isolated one-shot call to a vision-capable model (``settings.vision_model``,
served through OpenRouter) with the image plus the agent's question and returns
only the text answer. This keeps the calling agent's context lean and works
regardless of whether the agent's own chat model accepts image input.

``model_supports_vision`` lets the chat route decide whether to hand images to
the agent's model inline (native vision) or strip them and rely on this tool.
"""

from __future__ import annotations

import base64
import logging
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx
from openai import AsyncOpenAI

from app.config import get_settings
from app.media_store import mime_for_path

logger = logging.getLogger(__name__)

_MAX_IMAGE_BYTES = 20 * 1024 * 1024

# Cache of OpenRouter model ids that accept image input, refreshed lazily.
_vision_ids: set[str] | None = None
_vision_ids_fetched_at: float = 0.0
_VISION_CACHE_TTL = 3600.0  # seconds

OPENROUTER_PREFIX = "openrouter:"
CUSTOM_PREFIX = "custom:"


async def describe_image_bytes(raw: bytes, mime: str, question: str) -> str:
    """Answer ``question`` about raw image ``bytes`` via the vision model.

    The shared core behind :func:`make_view_image_tool` and the browser-QA
    ``view_app`` tool: it makes one isolated call to ``settings.vision_model``
    (through OpenRouter) with the image plus the question and returns only the
    text answer, so image bytes never enter a text-only agent's context and it
    works regardless of the agent model's own modalities. Never raises — every
    failure is returned as an ``"Error: ..."`` string so a caller can surface it
    without crashing the run.
    """
    settings = get_settings()
    if not settings.openrouter_api_key:
        return "Error: no OpenRouter API key configured; cannot read images."
    if len(raw) > _MAX_IMAGE_BYTES:
        return (
            f"Error: image is {len(raw)} bytes, over the "
            f"{_MAX_IMAGE_BYTES}-byte limit."
        )

    data_url = f"data:{mime};base64,{base64.b64encode(raw).decode()}"
    client = AsyncOpenAI(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
    )
    try:
        completion = await client.chat.completions.create(
            model=settings.vision_model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": question},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
            max_tokens=1500,
        )
    except Exception as exc:  # noqa: BLE001 - surface as text, don't crash the run
        logger.warning("describe_image_bytes: vision call failed: %s", exc)
        return f"Error: vision model call failed: {exc}"

    answer = (completion.choices[0].message.content or "").strip()
    return answer or "Error: vision model returned an empty response."


def make_view_image_tool(
    workspace_path: str | Path,
) -> Callable[..., Awaitable[str]]:
    """Build a ``view_image`` tool bound to ``workspace_path``.

    The returned coroutine is registered as an agent tool. Relative paths are
    resolved against the workspace; absolute paths are used as-is (attachments
    live under the media dir, outside the workspace). Errors are returned as
    ``"Error: ..."`` strings rather than raised, so a bad path doesn't burn the
    agent's retry budget.
    """
    root = Path(workspace_path)

    async def view_image(
        image_path: str, question: str = "Describe this image in detail."
    ) -> str:
        """Inspect an image file and answer a question about it.

        Use this whenever you need to understand the contents of an image the
        user attached or that exists in the workspace (screenshots, diagrams,
        photos, UI mockups). Pass a specific ``question`` for best results —
        e.g. "What error is shown?", "Transcribe all text", "What colors are
        used?". Returns a text description from a vision model.

        Args:
            image_path: Path to the image. Absolute, or relative to the workspace.
            question: What you want to know about the image.
        """
        settings = get_settings()
        if not settings.openrouter_api_key:
            return "Error: no OpenRouter API key configured; cannot read images."

        candidate = Path(image_path)
        resolved = candidate if candidate.is_absolute() else (root / candidate)
        try:
            resolved = resolved.resolve()
        except OSError as exc:
            return f"Error: could not resolve path {image_path!r}: {exc}"

        if not resolved.is_file():
            return f"Error: no such image file: {image_path}"
        raw = resolved.read_bytes()
        return await describe_image_bytes(raw, mime_for_path(resolved), question)

    return view_image


async def _refresh_vision_ids() -> set[str]:
    """Fetch the set of OpenRouter model ids that accept image input."""
    settings = get_settings()
    ids: set[str] = set()
    headers = (
        {"Authorization": f"Bearer {settings.openrouter_api_key}"}
        if settings.openrouter_api_key
        else {}
    )
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{settings.openrouter_base_url}/models", headers=headers
        )
        resp.raise_for_status()
        for m in resp.json().get("data", []) or []:
            modalities = (m.get("architecture") or {}).get("input_modalities") or []
            if "image" in modalities and m.get("id"):
                ids.add(m["id"])
    return ids


async def model_supports_vision(model_str: str) -> bool:
    """Whether ``model_str``'s model accepts image input.

    Returns ``False`` for locally-hosted ``custom:`` models (modalities
    unknown) and whenever the OpenRouter catalogue can't be reached — the safe
    default, since the ``view_image`` tool covers the fallback either way.
    """
    global _vision_ids, _vision_ids_fetched_at

    if model_str.startswith(CUSTOM_PREFIX):
        return False
    model_id = model_str[len(OPENROUTER_PREFIX) :] if model_str.startswith(
        OPENROUTER_PREFIX
    ) else model_str

    now = time.monotonic()
    if _vision_ids is None or now - _vision_ids_fetched_at > _VISION_CACHE_TTL:
        try:
            _vision_ids = await _refresh_vision_ids()
            _vision_ids_fetched_at = now
        except Exception as exc:  # noqa: BLE001
            logger.warning("model_supports_vision: catalogue fetch failed: %s", exc)
            if _vision_ids is None:
                return False  # never fetched successfully; assume no native vision

    return model_id in _vision_ids
