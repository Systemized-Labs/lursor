"""On-disk store for chat media (image attachments).

Attachments are kept on disk rather than in the database so message rows stay
small. Each file is named by the SHA-256 of its bytes (content-addressed, so the
same image attached twice is stored once) under a per-thread folder::

    {settings.media_dir}/{thread_id}/{sha256}.{ext}

The stored ``media_id`` (``"{sha256}.{ext}"``) is what the DB and the frontend
carry around; :func:`media_path` turns it back into an absolute path for
serving or for the ``view_image`` tool to read.
"""

from __future__ import annotations

import base64
import hashlib
import re
from pathlib import Path

from app.config import get_settings

# A media_id is a sha256 hex digest, optionally with a file extension. The regex
# is the single guard against path traversal in the serving endpoint.
MEDIA_ID_RE = re.compile(r"^[0-9a-f]{64}(\.[A-Za-z0-9]+)?$")

# Extension per MIME type; the fallback keeps files identifiable even for exotic
# image types. Only images are accepted as attachments today.
_EXT_BY_MIME: dict[str, str] = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
}
_MIME_BY_EXT: dict[str, str] = {v: k for k, v in _EXT_BY_MIME.items()}

# Reject oversized payloads before they hit disk / the vision endpoint (base64
# inflates ~33%, and vision APIs reject very large images).
MAX_IMAGE_BYTES = 20 * 1024 * 1024


def ext_for_mime(mime_type: str) -> str:
    """File extension (with dot) for an image MIME type."""
    return _EXT_BY_MIME.get(mime_type.lower(), ".bin")


def mime_for_path(path: str | Path) -> str:
    """Best-effort MIME type from a file extension."""
    return _MIME_BY_EXT.get(Path(path).suffix.lower(), "application/octet-stream")


def media_path(thread_id: str, media_id: str) -> Path:
    """Absolute path a ``media_id`` resolves to within a thread's folder."""
    return get_settings().media_dir / thread_id / media_id


def save_image(thread_id: str, data: bytes, mime_type: str) -> str:
    """Persist image ``data`` under ``thread_id`` and return its ``media_id``.

    Content-addressed by SHA-256, so re-attaching the same image is a no-op
    write. Raises ``ValueError`` if the payload exceeds :data:`MAX_IMAGE_BYTES`.
    """
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError(
            f"image is {len(data)} bytes, over the {MAX_IMAGE_BYTES}-byte limit"
        )
    digest = hashlib.sha256(data).hexdigest()
    media_id = f"{digest}{ext_for_mime(mime_type)}"
    dest = media_path(thread_id, media_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        dest.write_bytes(data)
    return media_id


def save_base64_image(thread_id: str, b64: str, mime_type: str) -> str:
    """Decode a base64 image (no data-URI prefix) and store it."""
    return save_image(thread_id, base64.b64decode(b64), mime_type)
