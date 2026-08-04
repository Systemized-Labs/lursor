"""On-disk store for chat media (image attachments) and generated video.

Attachments are kept on disk rather than in the database so message rows stay
small. Each file is named by the SHA-256 of its bytes (content-addressed, so the
same image attached twice is stored once) under a per-thread folder::

    {settings.media_dir}/{thread_id}/{sha256}.{ext}

The stored ``media_id`` (``"{sha256}.{ext}"``) is what the DB and the frontend
carry around; :func:`media_path` turns it back into an absolute path for
serving or for the ``view_image`` tool to read.

Generated clips use the same layout with :data:`VIDEO_FOLDER` in place of a
thread id — they belong to a :class:`~app.db.models.VideoJob`, not a
conversation, but they want the same content-addressing and the same
traversal guard. Generated *images* do the same under
:data:`GEN_IMAGE_FOLDER`, kept separate from attachments so a generation and a
chat upload of the same bytes never collide on a thread's folder.
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
# image types. Images arrive as chat attachments, video as generator output.
_EXT_BY_MIME: dict[str, str] = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
}
_MIME_BY_EXT: dict[str, str] = {v: k for k, v in _EXT_BY_MIME.items()}
# Two MIME types map to ``.jpg`` above, so inverting the table picks whichever came
# last — which was ``image/jpg``, a type that does not exist. Browsers tolerate it,
# but it is what every served jpeg (chat attachment and generated image alike) was
# labelled, so the canonical name is restored explicitly rather than by relying on
# the order of the dict above.
_MIME_BY_EXT[".jpg"] = "image/jpeg"

# Reject oversized payloads before they hit disk / the vision endpoint (base64
# inflates ~33%, and vision APIs reject very large images).
MAX_IMAGE_BYTES = 20 * 1024 * 1024

# Folder generated clips live under, in place of a thread id — they belong to a
# video job rather than a conversation.
VIDEO_FOLDER = "videos"

# A 15s 768p H.264 clip is single-digit MB, so this is a sanity bound on a
# runaway or mis-decoded response body rather than a real constraint.
MAX_VIDEO_BYTES = 512 * 1024 * 1024

# Folder generated images live under, in place of a thread id — they belong to an
# image generation rather than a conversation.
GEN_IMAGE_FOLDER = "generated-images"


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


def save_video(data: bytes, mime_type: str = "video/mp4") -> str:
    """Persist a generated clip under :data:`VIDEO_FOLDER`, returning its media_id.

    Content-addressed like images, so re-downloading a job's output is a no-op
    write. Raises ``ValueError`` past :data:`MAX_VIDEO_BYTES`.
    """
    if len(data) > MAX_VIDEO_BYTES:
        raise ValueError(
            f"video is {len(data)} bytes, over the {MAX_VIDEO_BYTES}-byte limit"
        )
    digest = hashlib.sha256(data).hexdigest()
    media_id = f"{digest}{ext_for_mime(mime_type)}"
    dest = media_path(VIDEO_FOLDER, media_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        dest.write_bytes(data)
    return media_id


def video_path(media_id: str) -> Path:
    """Absolute path for a stored clip. Caller must validate against MEDIA_ID_RE."""
    return media_path(VIDEO_FOLDER, media_id)


def save_generated_image(data: bytes, mime_type: str = "image/jpeg") -> str:
    """Persist a generated image under :data:`GEN_IMAGE_FOLDER`.

    Its own folder rather than a thread's: a generation belongs to an
    :class:`~app.db.models.ImageGeneration`, not a conversation. Otherwise
    identical to an attachment — same content-addressing, so re-storing the same
    bytes is a no-op write, and the same :data:`MAX_IMAGE_BYTES` bound.

    The default mime is jpeg because that is what the SGLang diffusion server
    returns unless ``output_format`` asks otherwise; callers that know better
    (a sniffed magic number, a response ``content-type``) should say so.
    """
    return save_image(GEN_IMAGE_FOLDER, data, mime_type)


def generated_image_path(media_id: str) -> Path:
    """Absolute path for a stored generation. Validate against MEDIA_ID_RE first."""
    return media_path(GEN_IMAGE_FOLDER, media_id)
