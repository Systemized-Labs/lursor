"""``view_image`` reports every failure as text, never by raising.

An exception escaping a tool body aborts the agent run, so this tool's contract is
that it always returns a string — the docstring on ``make_view_image_tool`` says as
much ("so a bad path doesn't burn the agent's retry budget"). The read itself was
the one unguarded step: ``is_file()`` passing doesn't make ``read_bytes()`` safe
(permissions, a delete race, an unreadable mount).
"""

from __future__ import annotations

from pathlib import Path

from app.agents import vision
from app.agents.vision import make_view_image_tool


async def test_missing_file_is_reported_as_text(tmp_path):
    view_image = make_view_image_tool(tmp_path)

    result = await view_image("nope.png")

    assert result.startswith("Error:")
    assert "nope.png" in result


async def test_unreadable_file_is_reported_as_text(tmp_path, monkeypatch):
    """The regression: a readable-looking file that fails to open."""
    image = tmp_path / "shot.png"
    image.write_bytes(b"not really a png")

    def boom(self):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(Path, "read_bytes", boom)
    view_image = make_view_image_tool(tmp_path)

    result = await view_image("shot.png")

    assert result.startswith("Error:")
    assert "shot.png" in result
    assert "Permission denied" in result


async def test_vision_call_failure_is_reported_as_text(tmp_path, monkeypatch):
    """A read that succeeds but a vision model that doesn't is still text."""
    image = tmp_path / "shot.png"
    image.write_bytes(b"bytes")

    async def failing_describe(raw, mime, question):
        return "Error: vision model call failed: boom"

    monkeypatch.setattr(vision, "describe_image_bytes", failing_describe)
    view_image = make_view_image_tool(tmp_path)

    assert (await view_image("shot.png")).startswith("Error:")
