"""Serving media bytes for the editor's inline preview (``/files/raw``).

The editor shows images, video and audio in a player rather than in Monaco, and
the bytes come from ``/raw`` (or ``/serve``, the same thing with the path in the
URL). Two things have to hold for a player to work: the ``Content-Type`` has to
be one a browser will accept for playback, and the response has to honour
``Range`` so seeking in a video fetches a window instead of the whole file.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from app.api.files import _media_type


async def _workspace(client: AsyncClient, name: str) -> str:
    return (await client.post("/workspaces", json={"name": name})).json()["id"]


async def _upload(client: AsyncClient, wid: str, name: str, data: bytes) -> None:
    """Put raw bytes in the workspace — ``/write`` is text-only."""
    r = await client.post(
        f"/workspaces/{wid}/files/upload",
        files={"files": (name, data, "application/octet-stream")},
        data={"path": ""},
    )
    assert r.status_code == 201, r.text


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        # Guessed by the stdlib and already fine.
        ("clip.mp4", "video/mp4"),
        ("clip.webm", "video/webm"),
        ("clip.mov", "video/quicktime"),
        ("track.mp3", "audio/mpeg"),
        ("track.ogg", "audio/ogg"),
        # Overridden: the stdlib's names for these are ones a media element may
        # refuse outright (``audio/mp4a-latm``, the ``x-`` experimental forms).
        ("track.m4a", "audio/mp4"),
        ("clip.m4v", "video/mp4"),
        ("track.aac", "audio/aac"),
        ("track.flac", "audio/flac"),
        ("track.wav", "audio/wav"),
        ("track.weba", "audio/webm"),
        # Images keep working, and an unknown extension stays a generic download.
        ("shot.png", "image/png"),
        ("mystery.bin", "application/octet-stream"),
    ],
)
def test_media_type_is_one_a_player_accepts(tmp_path, name: str, expected: str):
    assert _media_type(tmp_path / name) == expected


def test_media_type_ignores_extension_case():
    """A file off a camera is often ``.MOV``/``.MP4``; that is the same type."""
    from pathlib import Path

    assert _media_type(Path("CLIP.MOV")) == "video/quicktime"
    assert _media_type(Path("TRACK.M4A")) == "audio/mp4"


async def test_raw_serves_video_bytes_with_a_playable_type(client: AsyncClient):
    wid = await _workspace(client, "media-raw")
    await _upload(client, wid, "clip.mp4", b"\x00\x00\x00\x18ftypmp42" + b"x" * 200)

    r = await client.get(f"/workspaces/{wid}/files/raw", params={"path": "clip.mp4"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "video/mp4"
    assert len(r.content) == 212


async def test_raw_honours_a_range_request(client: AsyncClient):
    """Seeking in a long video must not re-download it from the start."""
    wid = await _workspace(client, "media-range")
    body = bytes(range(256)) * 8  # 2048 bytes of known content
    await _upload(client, wid, "clip.mp4", body)

    r = await client.get(
        f"/workspaces/{wid}/files/raw",
        params={"path": "clip.mp4"},
        headers={"Range": "bytes=1000-1099"},
    )
    assert r.status_code == 206, r.text
    assert r.headers["content-range"] == f"bytes 1000-1099/{len(body)}"
    assert r.content == body[1000:1100]


async def test_read_still_reports_media_as_binary(client: AsyncClient):
    """The JSON endpoint can't carry these; the editor relies on it saying so."""
    wid = await _workspace(client, "media-read")
    await _upload(client, wid, "track.mp3", b"ID3\x04\x00\x00\x00" + b"\x00" * 64)

    r = await client.get(f"/workspaces/{wid}/files/read", params={"path": "track.mp3"})
    assert r.status_code == 200, r.text
    assert r.json()["is_binary"] is True
    assert r.json()["content"] == ""


async def test_media_path_cannot_escape_the_workspace(client: AsyncClient):
    """The preview URL is client-supplied, so it gets the same guard as ``/read``."""
    wid = await _workspace(client, "media-escape")
    r = await client.get(
        f"/workspaces/{wid}/files/raw", params={"path": "../../etc/passwd"}
    )
    assert r.status_code == 400, r.text
