"""The video tools an agent gets: submit, poll, cancel, see.

The dividing line against the ``video-production`` skill is *credentials, rows and
app state*. Generation needs all three — the gateway's ``master_key`` is
deliberately server-side, the job belongs in a :class:`~app.db.models.VideoJob` row,
and the clip belongs in the media store — so it is a tool. ffmpeg needs none of
them: it is ``execute`` plus knowledge, so trimming, concatenating and overlaying
stay in the skill rather than becoming a worse CLI over a good one.

Three shapes carried over from :func:`~app.agents.vision.make_view_image_tool`,
which is the template here:

* **factories bound to a workspace**, so relative paths mean what the agent thinks
  they mean;
* **every failure returned as an ``"Error: ..."`` string**, never raised — an
  exception escaping a tool body aborts the run, and a bad path should cost one
  step, not the turn;
* **one vision call**, so understanding a clip does not flood the context with
  image bytes.

The one thing these do differently: **no tool call waits for a render.** At ~44 s
per denoise step a draft is ~6 minutes and a 50-step final ~35, so
``generate_video`` returns a job id and an estimate immediately and ``video_status``
takes a *bounded* wait. A tool that blocks for half an hour makes the run look
hung, cannot be steered, and starves the goal loop's iteration budget.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import math
import shutil
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlmodel import select

from app.agents.video_runtime import (
    SCHEMA_MINIMAX_H3,
    SCHEMA_SGLANG_VIDEO,
    VideoConstraints,
    VideoRuntime,
)
from app.agents.vision import describe_image_bytes
from app.agents.workspace_paths import relative_to_workspace, resolve_in_workspace, slug
from app.agents.workspace_paths import write_gitignore as _write_shared_gitignore
from app.api import videos as videos_api
from app.db.models import VideoJob
from app.db.session import async_session_factory
from app.media_store import mime_for_path

logger = logging.getLogger(__name__)

# The workspace helpers under their local names, so the call sites below read the
# way they always have. The implementations moved to ``agents/workspace_paths.py``
# when ``agents/image_tools.py`` became their third user.
_resolve = resolve_in_workspace
_relative = relative_to_workspace
_slug = slug

# Where agent-owned video state lives, relative to the workspace root. ``.agents/``
# is the established convention for agent-owned workspace state (``.agents/plan/``,
# ``.agents/skills/``).
VIDEO_DIR = ".agents/video"
GEN_DIR = f"{VIDEO_DIR}/gen"
FRAMES_DIR = f"{VIDEO_DIR}/frames"

# Hard ceiling on one ``video_status`` wait. Long enough that a draft usually
# finishes inside two calls, short enough that the model keeps the ability to
# change its mind.
MAX_WAIT_SECONDS = 300
_POLL_INTERVAL_SECONDS = 5.0

# Frame counts ``view_video`` can tile exactly. ``tile`` emits a partial frame if
# the input count does not fill the grid, so the request is snapped to one of these
# (and the snap is stated in the result rather than applied silently).
_GRIDS: dict[int, tuple[int, int]] = {
    1: (1, 1),
    2: (2, 1),
    3: (3, 1),
    4: (2, 2),
    6: (3, 2),
    8: (4, 2),
    9: (3, 3),
}
# Width each still is scaled to for the contact sheet. The stills themselves stay
# on disk at full resolution, so ``view_image`` can still read fine detail.
_SHEET_TILE_WIDTH = 640
_PROBE_TIMEOUT_SECONDS = 30
_FRAME_TIMEOUT_SECONDS = 120


def make_video_tools(
    runtime: VideoRuntime, workspace_path: str | Path
) -> list[Callable[..., Awaitable[str]]]:
    """The video toolset for one run, bound to ``runtime`` and the workspace.

    The model never sees a connection id or a model name it has to choose: the
    runtime resolved both (``agents/video_runtime.py``) and every result names what
    was used, so the agent can report it without being able to get it wrong.
    """
    root = Path(workspace_path)
    limits = runtime.constraints

    async def generate_video(
        prompt: str,
        aspect_ratio: str = "16:9",
        duration_seconds: float = 4,
        steps: int = 8,
        seed: int | None = None,
        first_frame: str | None = None,
        last_frame: str | None = None,
    ) -> str:
        """Start generating a video clip with synchronised audio. Returns a job id.

        This does NOT wait for the clip: generation runs for minutes on a GPU box
        (about 44 seconds per step, so 8 steps is ~6 minutes and 50 steps ~35
        minutes). It returns immediately with a job id; call ``video_status`` to
        wait for the result and get the file.

        Cost discipline matters. Draft at ``steps=8`` first, look at the result with
        ``view_video``, and only spend a 50-step render once the shot is right —
        keeping the same ``seed`` makes the final the same shot, sharper.

        Clips are capped at 15 seconds. Build anything longer as several shots and
        join them with ffmpeg; pass the previous shot's last frame as
        ``first_frame`` so they actually continue into each other.

        Args:
            prompt: What to generate. Describe the shot, the motion and the sound.
            aspect_ratio: "16:9", "9:16" or "1:1". Use "auto" with a supplied frame
                to inherit that frame's own geometry.
            duration_seconds: Clip length, 4 to 15.
            steps: Denoise steps, 4 to 50. 8 drafts, 50 finals.
            seed: Fixed seed for a reproducible shot. Omit to let the engine pick.
            first_frame: Image file (workspace path) to use as the clip's first
                frame — how one shot is made to continue from another.
            last_frame: Image file (workspace path) to land on as the final frame.
        """
        try:
            submission = _build_request(
                runtime,
                root,
                prompt=prompt,
                aspect_ratio=aspect_ratio,
                duration_seconds=duration_seconds,
                steps=steps,
                seed=seed,
                first_frame=first_frame,
                last_frame=last_frame,
            )
        except _Invalid as exc:
            return f"Error: {exc}"

        try:
            async with async_session_factory() as session:
                row = await videos_api.create_video(
                    runtime.connection_id, submission.body, session
                )
        except HTTPException as exc:
            # The engine is the authority on its own constraints, so its rejection
            # is returned verbatim: "target.short_edge must be 768 for minimax_h3,
            # got 1080" tells the model which knob and what value would work.
            return f"Error: {exc.detail}"
        except Exception as exc:  # noqa: BLE001 - a tool never raises
            logger.warning("generate_video failed: %s", exc)
            return f"Error: could not submit the video job: {exc}"

        job_id = str(row.get("job_id") or "")
        estimate = submission.steps * limits.seconds_per_step
        lines = [
            f"Submitted job {job_id} to {runtime.model} on {runtime.connection_name!r}.",
            f"  task: {submission.label}"
            + (f" ({', '.join(submission.notes)})" if submission.notes else ""),
            f"  {_size_for(limits, submission.aspect_ratio)} · "
            f"{_seconds(submission.duration_seconds)}s · {submission.steps} steps"
            + (f" · seed {seed}" if seed is not None else " · seed: engine's choice"),
            f"  estimated wall clock: {_estimate(estimate)} "
            f"({submission.steps} steps × {limits.seconds_per_step}s)",
            "",
            "Nothing advances until you poll. Next: "
            f'video_status("{job_id}", wait_seconds={MAX_WAIT_SECONDS})',
        ]
        return "\n".join(lines)

    async def video_status(job_id: str, wait_seconds: int = 0) -> str:
        """Check on a video job, optionally waiting, and get the finished file.

        When the clip is done this copies it into the workspace under
        ``.agents/video/gen/`` and returns that path, so ffmpeg, ``ls`` and
        ``read_file`` can all reach it.

        ``wait_seconds`` blocks for up to that long (capped at 300) before
        answering, polling every few seconds. It returns as soon as the job
        finishes, and reports "still running" rather than waiting forever — a
        6-minute draft normally takes two calls.

        Args:
            job_id: The id ``generate_video`` returned.
            wait_seconds: How long to wait for a result before answering, 0-300.
        """
        job_id = (job_id or "").strip()
        if not job_id:
            return "Error: job_id is required."
        wait = max(0, min(int(wait_seconds or 0), MAX_WAIT_SECONDS))
        deadline = time.monotonic() + wait

        try:
            async with async_session_factory() as session:
                job = await _find_job(session, runtime.connection_id, job_id)
                if job is None:
                    return (
                        f"Error: no video job {job_id!r} on "
                        f"{runtime.connection_name!r}. Job ids come from "
                        "generate_video."
                    )
                payload: dict[str, Any] = {}
                while True:
                    payload = await videos_api.video_status(
                        runtime.connection_id, job_id, session
                    )
                    state = str(payload.get("status") or "")
                    if state in videos_api.TERMINAL:
                        break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    await asyncio.sleep(min(_POLL_INTERVAL_SECONDS, remaining))

                state = str(payload.get("status") or "")
                if state == "completed":
                    job = await _find_job(session, runtime.connection_id, job_id)
                    assert job is not None  # it was there a moment ago
                    return await _deliver(job, session, root, limits)
                if state == "failed":
                    reason = payload.get("error") or "the engine reported no reason"
                    return f"Job {job_id} failed: {reason}"
                if state in {"cancelled", "canceled"}:
                    return f"Job {job_id} was cancelled."
                return _still_running(payload, limits, job_id)
        except HTTPException as exc:
            return f"Error: {exc.detail}"
        except Exception as exc:  # noqa: BLE001 - a tool never raises
            logger.warning("video_status(%s) failed: %s", job_id, exc)
            return f"Error: could not check job {job_id}: {exc}"

    async def cancel_video(job_id: str) -> str:
        """Stop a video job that is still running, freeing the box.

        Use this the moment you know you do not want a render — a wrong prompt, a
        superseded shot, or a job you started before the user changed their mind.
        A generation holds the GPU for minutes, and nothing else can use it
        meanwhile.

        The job stays in the history as cancelled, with the settings it was
        submitted with. A job that already finished is not affected.

        Args:
            job_id: The id ``generate_video`` returned.
        """
        job_id = (job_id or "").strip()
        if not job_id:
            return "Error: job_id is required."
        try:
            async with async_session_factory() as session:
                job = await _find_job(session, runtime.connection_id, job_id)
                if job is None:
                    return (
                        f"Error: no video job {job_id!r} on "
                        f"{runtime.connection_name!r}."
                    )
                if job.status in videos_api.TERMINAL:
                    return (
                        f"Job {job_id} is already {job.status}; nothing to cancel."
                    )
                row = await videos_api.cancel_video(
                    runtime.connection_id, job_id, session
                )
        except HTTPException as exc:
            return f"Error: {exc.detail}"
        except Exception as exc:  # noqa: BLE001 - a tool never raises
            logger.warning("cancel_video(%s) failed: %s", job_id, exc)
            return f"Error: could not cancel job {job_id}: {exc}"
        return (
            f"Job {job_id} cancelled ({row.get('status')}). The box is free; the "
            "attempt stays in the history."
        )

    async def view_video(
        path: str, question: str = "Describe this clip.", frames: int = 4
    ) -> str:
        """Watch a video file: probe it and answer a question about what it shows.

        Samples stills evenly across the clip, tiles them into one contact sheet and
        asks a vision model about it, so this is how you see your own output — check
        a draft before spending a 50-step render, and check an assembly before
        delivering it. Also reports duration, resolution, fps and streams.

        It cannot hear the audio track. Generated clips carry one, and its presence
        is reported, but nothing in this stack listens to it.

        The individual stills are left in ``.agents/video/frames/`` — pass one to
        ``view_image`` to look at it at full resolution.

        Args:
            path: The video file. Absolute, or relative to the workspace.
            question: What you want to know about the clip.
            frames: How many stills to sample (1-9; snapped to a tileable count).
        """
        resolved = _resolve(root, path)
        if isinstance(resolved, str):
            return resolved
        if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
            return _NO_FFMPEG

        probe = await _probe(resolved)
        if isinstance(probe, str):
            return probe

        count, snapped = _tileable(frames)
        duration = probe["duration"]
        stamps = [duration * (i + 0.5) / count for i in range(count)]
        sheet_dir = Path(root) / FRAMES_DIR / _slug(resolved.stem)
        stills = await _extract_stills(resolved, stamps, sheet_dir)
        if isinstance(stills, str):
            return stills
        sheet = await _contact_sheet(stills, sheet_dir, count)
        if isinstance(sheet, str):
            return sheet

        order = ", ".join(f"{_seconds(t)}s" for t in stamps)
        framing = (
            f"This is a contact sheet of {count} frames sampled from a "
            f"{_seconds(duration)}-second video, in reading order (left to right, "
            f"top to bottom) at {order}. Answer about the video as a whole, and "
            f"refer to those timestamps where it matters.\n\n{question}"
        )
        description = await describe_image_bytes(
            sheet.read_bytes(), "image/jpeg", framing
        )

        lines = [
            f"{_relative(root, resolved)} — {probe['summary']}",
            probe["streams"],
        ]
        if snapped:
            lines.append(
                f"Sampled {count} frames rather than {frames}: only "
                f"{', '.join(str(n) for n in sorted(_GRIDS))} tile exactly."
            )
        lines += [
            f"Stills: {_relative(root, sheet_dir)}/ (view_image any of them for "
            "full resolution)",
            "",
            description,
        ]
        if probe["has_audio"]:
            lines += [
                "",
                "Note: this clip has an audio track, which was NOT examined — "
                "nothing in this stack can listen to it. Judgements above are "
                "about the picture only.",
            ]
        return "\n".join(lines)

    return [generate_video, video_status, cancel_video, view_video]


# --- request building -----------------------------------------------------------


class _Invalid(Exception):
    """A constraint the engine would reject, caught before the round trip."""


@dataclass(frozen=True)
class _Submission:
    """A validated request: the body to send, plus what it was asked for.

    The summary the tool returns is built from these fields rather than read back
    out of ``body``, because the body's shape is per-model — ``target.aspect_ratio``
    exists in H3's schema and nowhere else, and a summary that reaches into it
    crashes the moment a second model appears.
    """

    body: dict[str, Any]
    notes: list[str]
    label: str
    aspect_ratio: str
    duration_seconds: float
    steps: int


def _build_request(
    runtime: VideoRuntime,
    root: Path,
    *,
    prompt: str,
    aspect_ratio: str,
    duration_seconds: float,
    steps: int,
    seed: int | None,
    first_frame: str | None,
    last_frame: str | None,
) -> _Submission:
    """The engine body for these arguments, or raise :class:`_Invalid`.

    Validated locally *before* submitting, because a 400 round trip through a
    tunnel costs more than a local check and the useful part of the message
    ("duration must be in [4, 15]") is knowable here. The engine stays the
    authority: anything it rejects anyway comes back verbatim from the caller.
    """
    limits = runtime.constraints
    if not (prompt or "").strip():
        raise _Invalid("prompt is required — describe the shot, motion and sound.")

    ratio = (aspect_ratio or "").strip() or "16:9"
    # An empty ``aspect_ratios`` means the model's profile does not constrain them,
    # so there is nothing to check against — the engine stays the authority.
    if limits.aspect_ratios and ratio not in limits.aspect_ratios and ratio != "auto":
        allowed = ", ".join(limits.aspect_ratios)
        raise _Invalid(
            f"aspect_ratio {ratio!r} is not supported by {runtime.model}; "
            f'use one of {allowed}, or "auto" with a supplied frame.'
        )

    try:
        duration = float(duration_seconds)
    except (TypeError, ValueError) as exc:
        raise _Invalid(f"duration_seconds must be a number, got {duration_seconds!r}") from exc
    if not limits.min_duration_seconds <= duration <= limits.max_duration_seconds:
        raise _Invalid(
            f"duration_seconds must be in "
            f"[{_seconds(limits.min_duration_seconds)}, "
            f"{_seconds(limits.max_duration_seconds)}], got {_seconds(duration)}. "
            "Longer pieces are several shots joined with ffmpeg."
        )

    try:
        step_count = int(steps)
    except (TypeError, ValueError) as exc:
        raise _Invalid(f"steps must be a whole number, got {steps!r}") from exc
    if not limits.min_steps <= step_count <= limits.max_steps:
        raise _Invalid(
            f"steps must be in [{limits.min_steps}, {limits.max_steps}], "
            f"got {step_count}."
        )

    if seed is not None:
        try:
            seed = int(seed)
        except (TypeError, ValueError) as exc:
            raise _Invalid(f"seed must be a whole number, got {seed!r}") from exc
        if seed < 0:
            raise _Invalid(f"seed must not be negative, got {seed}.")

    frames = [
        (label, candidate)
        for label, candidate in (("first_frame", first_frame), ("last_frame", last_frame))
        if candidate
    ]
    if frames and not limits.keyframes:
        raise _Invalid(
            f"{runtime.model} does not support first/last-frame conditioning, so "
            f"{frames[0][0]} cannot be used. Generate the shot from a prompt, or "
            "join shots with a crossfade instead of conditioning them."
        )

    builder = _BUILDERS.get(runtime.request_schema)
    if builder is None:  # pragma: no cover - resolution rejects unknown schemas
        raise _Invalid(
            f"this build cannot construct a request for {runtime.request_schema!r}."
        )
    body, notes = builder(
        runtime,
        root,
        prompt=prompt,
        ratio=ratio,
        duration=duration,
        steps=step_count,
        seed=seed,
        frames=frames,
    )

    # Checked on the assembled body, not per frame: two keyframes that each fit can
    # still bust the budget together, and the gateway's 413 says nothing about which
    # one to shrink.
    if frames:
        size = len(json.dumps(body))
        if size > _GATEWAY_BODY_LIMIT:
            raise _Invalid(
                f"the request is {size} bytes with the frame(s) inlined, over the "
                f"gateway's {_GATEWAY_BODY_LIMIT}-byte body limit. {_REENCODE_HINT}."
            )
    # A neutral label: H3 names its own task, other schemas do not have the concept.
    label = str(body.get("task") or ("image-to-video" if frames else "text-to-video"))
    return _Submission(
        body=body,
        notes=notes,
        label=label,
        aspect_ratio=ratio,
        duration_seconds=duration,
        steps=step_count,
    )


def _build_minimax_h3(
    runtime: VideoRuntime,
    root: Path,
    *,
    prompt: str,
    ratio: str,
    duration: float,
    steps: int,
    seed: int | None,
    frames: list[tuple[str, str]],
) -> tuple[dict[str, Any], list[str]]:
    """MiniMax-H3's canonical body (``minimax_h3.request/v1``).

    ``task``/``target``/``conditions`` are H3's own extras, not the generic video
    API — which is exactly why the schema has to be declared before this is used.
    """
    limits = runtime.constraints
    body: dict[str, Any] = {
        "model": runtime.model,
        "prompt": prompt,
        "task": "t2va",
        "target": {
            "short_edge": limits.short_edge,
            "aspect_ratio": ratio,
            "duration_seconds": duration,
        },
        "num_inference_steps": steps,
    }
    if seed is not None:
        body["seed"] = seed

    # ``frame_index`` is the whole keyframe contract: 0 is the first frame, -1 the
    # last, and [0, -1] both — the engine accepts exactly those three signatures, in
    # that order (verified against a running box).
    conditions = []
    notes = []
    for label, candidate in frames:
        conditions.append(
            {
                "type": "image",
                "uri": _data_uri(root, candidate, label),
                "role": "keyframe",
                "frame_index": 0 if label == "first_frame" else -1,
            }
        )
        notes.append(f"{label}={candidate}")
    if conditions:
        body["task"] = "fl2va"
        body["conditions"] = conditions
    return body, notes


def _build_sglang_video(
    runtime: VideoRuntime,
    root: Path,
    *,
    prompt: str,
    ratio: str,
    duration: float,
    steps: int,
    seed: int | None,
    frames: list[tuple[str, str]],
) -> tuple[dict[str, Any], list[str]]:
    """The generic SGLang video body (``sglang.video/v1``).

    For a model whose profile declares this shape rather than H3's. The knobs the
    engine actually reads are ``seconds`` and ``size``/``width``/``height`` — sending
    H3's ``target`` block instead is the silent-wrong-clip failure this whole
    resolution path exists to prevent.

    Image conditioning here is ``input_reference``, which is a *first* frame only:
    the generic API has no last-frame concept, so asking for one is refused rather
    than quietly dropped.

    Untested against a real second model — no video recipe other than H3 exists yet
    — so it is written to the engine's source and kept deliberately small.
    """
    limits = runtime.constraints
    body: dict[str, Any] = {
        "model": runtime.model,
        "prompt": prompt,
        # Integer seconds: the generic path derives num_frames as fps * seconds.
        "seconds": int(round(duration)),
        "num_inference_steps": steps,
    }
    if seed is not None:
        body["seed"] = seed
    # Only when the profile said what this ratio means in pixels. Inventing a size
    # would be the same guess, one layer down.
    size = limits.sizes.get(ratio, "").replace(" ", "")
    if size:
        body["size"] = size

    notes = []
    for label, candidate in frames:
        if label == "last_frame":
            raise _Invalid(
                f"{runtime.model} takes a first frame only ({SCHEMA_SGLANG_VIDEO} has "
                "no last-frame conditioning), so last_frame cannot be used."
            )
        body["input_reference"] = _data_uri(root, candidate, label)
        notes.append(f"{label}={candidate}")
    return body, notes


_BUILDERS: dict[str, Any] = {
    SCHEMA_MINIMAX_H3: _build_minimax_h3,
    SCHEMA_SGLANG_VIDEO: _build_sglang_video,
}


# Accepted keyframe types, keyed by what ``mime_for_path`` actually returns and
# mapped to the canonical type sent on the wire. ``.jpg`` resolves to ``image/jpg``
# there (the shared extension table inverts a dict in which that alias comes last),
# and a JPEG is exactly what a frame extracted for continuity should be — so
# rejecting it would have refused the format this feature recommends. Normalised
# rather than passed through, because the engine derives a temp-file suffix from the
# media type in the data URI and should be handed the real name.
_IMAGE_MIMES = {
    "image/png": "image/png",
    "image/jpeg": "image/jpeg",
    "image/jpg": "image/jpeg",
    "image/webp": "image/webp",
}

# The laios gateway buffers the request body behind axum's default limit and answers
# ``413 Failed to buffer the request body: length limit exceeded`` above it. Measured
# against a running box, not assumed: 2,090,000 bytes went through and 2,200,000 did
# not. This is the real ceiling on a keyframe — tighter than anything the engine
# itself imposes, and invisible until you send a photographic frame, because a
# synthetic one compresses to a tenth of the size.
_GATEWAY_BODY_LIMIT = 2 * 1024 * 1024

# Base64 inflates by 4/3, so one frame can never exceed three quarters of the body
# budget. Two frames share it, which the assembled-body check below is for.
_MAX_FRAME_BYTES = (_GATEWAY_BODY_LIMIT * 3) // 4

_REENCODE_HINT = (
    "Re-encode it smaller — a JPEG of a 768p frame is a few hundred KB: "
    "`ffmpeg -nostdin -y -i frame.png -q:v 3 frame.jpg`"
)


def _data_uri(root: Path, candidate: str, label: str) -> str:
    """Read a workspace image and inline it as a ``data:`` URI.

    The engine resolves a condition's ``uri`` as a local path, an ``http(s)`` URL or
    an inline ``data:``/``base64://`` payload. Lursor does not run on the box, so a
    path would name a file the engine cannot see and a URL would need us to serve
    one: inlining is the only transport that works for a frame that exists only in
    the workspace.
    """
    resolved = _resolve(root, candidate)
    if isinstance(resolved, str):
        raise _Invalid(f"{label}: {resolved.removeprefix('Error: ')}")
    mime = _IMAGE_MIMES.get(mime_for_path(resolved))
    if mime is None:
        raise _Invalid(
            f"{label} must be a PNG, JPEG or WebP image; {candidate!r} looks like "
            f"{mime_for_path(resolved)}. Pull a frame out of a clip with "
            "`ffmpeg -nostdin -y -sseof -0.1 -i in.mp4 -frames:v 1 -update 1 "
            "-q:v 3 last.jpg`."
        )
    try:
        raw = resolved.read_bytes()
    except OSError as exc:
        raise _Invalid(f"{label}: could not read {candidate!r}: {exc}") from exc
    if len(raw) > _MAX_FRAME_BYTES:
        raise _Invalid(
            f"{label} is {len(raw)} bytes, over the {_MAX_FRAME_BYTES}-byte limit for "
            f"an inlined frame (the gateway caps the whole request at "
            f"{_GATEWAY_BODY_LIMIT} bytes and base64 adds a third). {_REENCODE_HINT}."
        )
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


# --- delivery -------------------------------------------------------------------


async def _find_job(session, connection_id: str, job_id: str) -> VideoJob | None:
    result = await session.execute(
        select(VideoJob).where(
            VideoJob.connection_id == connection_id, VideoJob.job_id == job_id
        )
    )
    return result.scalars().first()


async def _deliver(
    job: VideoJob, session, root: Path, limits: VideoConstraints
) -> str:
    """Materialize a finished clip into the workspace and describe what landed."""
    try:
        source = await videos_api.stored_clip(job, session)
    except HTTPException as exc:
        return f"Error: job {job.job_id} finished but the clip could not be fetched: {exc.detail}"

    dest = _materialize(root, job, source)
    if isinstance(dest, str):
        return dest

    # Measured beats requested, but a missing (or unhappy) ffprobe must not turn a
    # delivered clip into an error: fall back to the submitted target and say which
    # of the two this is, so nobody reads "requested" as "verified".
    probe = await _probe(dest) if shutil.which("ffprobe") else None
    if isinstance(probe, dict):
        shape = probe["summary"]
    else:
        target = job.request.get("target") if isinstance(job.request, dict) else {}
        target = target if isinstance(target, dict) else {}
        try:
            duration = float(target.get("duration_seconds") or 0)
        except (TypeError, ValueError):
            duration = 0.0
        why = (
            "ffprobe could not read the file"
            if probe is not None
            else "ffprobe is not installed"
        )
        shape = (
            f"{_size_for(limits, str(target.get('aspect_ratio') or ''))} · "
            f"{_seconds(duration)}s as submitted ({why}, so this is what was asked "
            "for rather than what was measured)"
        )

    return "\n".join(
        [
            f"Job {job.job_id} completed.",
            f"  {_relative(root, dest)} — {shape}",
            "",
            "Look at it with view_video before using it. Edit with ffmpeg, writing "
            "to a new file — never in place over a generation.",
        ]
    )


def _materialize(root: Path, job: VideoJob, source: Path) -> Path | str:
    """Copy the stored clip into ``.agents/video/gen/``, once.

    A copy rather than a hardlink: clips are single-digit MB, and a link shares fate
    with the cache the media store exists to protect. The filename embeds the job
    id, so a second materialize of the same job finds its own file already there.
    """
    gen = root / GEN_DIR
    try:
        gen.mkdir(parents=True, exist_ok=True)
        _write_gitignore(root / VIDEO_DIR)
    except OSError as exc:
        return f"Error: could not create {GEN_DIR} in the workspace: {exc}"

    dest = gen / f"{_slug(job.prompt) or 'clip'}-{_slug(job.job_id)}.mp4"
    if dest.is_file() and dest.stat().st_size == source.stat().st_size:
        return dest
    try:
        shutil.copyfile(source, dest)
    except OSError as exc:
        return f"Error: could not copy the clip into the workspace: {exc}"
    return dest


def _write_gitignore(video_dir: Path) -> None:
    """Ignore this whole tree, on first use."""
    _write_shared_gitignore(video_dir, "Agent-generated clips and frames; not source.")


def _still_running(
    payload: dict[str, Any], limits: VideoConstraints, job_id: str
) -> str:
    request = payload.get("request") if isinstance(payload, dict) else {}
    steps = 0
    if isinstance(request, dict):
        try:
            steps = int(request.get("num_inference_steps") or 0)
        except (TypeError, ValueError):
            steps = 0
    estimate = steps * limits.seconds_per_step
    elapsed = _elapsed(payload.get("created_at"))
    parts = [f"Job {job_id} is {payload.get('status') or 'running'}."]
    if elapsed is not None:
        line = f"  elapsed {_duration(elapsed)}"
        if estimate:
            line += f" of an estimated {_estimate(estimate)}"
        parts.append(line)
    elif estimate:
        parts.append(f"  estimated {_estimate(estimate)} in total")
    parts.append(
        "  H3 reports no incremental progress — elapsed against the estimate is "
        "the whole signal."
    )
    parts.append(
        f'Call video_status("{job_id}", wait_seconds={MAX_WAIT_SECONDS}) again, or '
        "go do something else and come back to it."
    )
    return "\n".join(parts)


# --- ffmpeg ---------------------------------------------------------------------


_NO_FFMPEG = (
    "Error: ffmpeg and ffprobe are required and were not found on PATH. "
    "Install them (`brew install ffmpeg` on macOS, `apt install ffmpeg` on "
    "Debian/Ubuntu) and try again."
)


async def _run(*args: str, timeout: int) -> tuple[int, str]:
    """Run a command, returning (exit code, stdout+stderr). Never raises."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except OSError as exc:
        return 127, str(exc)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, f"timed out after {timeout}s"
    return proc.returncode or 0, out.decode(errors="replace").strip()


async def _probe(path: Path) -> dict[str, Any] | str:
    """ffprobe a file into a one-line summary plus a stream list."""
    code, out = await _run(
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
        timeout=_PROBE_TIMEOUT_SECONDS,
    )
    if code != 0:
        return f"Error: ffprobe could not read {path.name}: {out or code}"
    try:
        data = json.loads(out)
    except ValueError:
        return f"Error: ffprobe returned output that is not JSON for {path.name}."

    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    if video is None:
        return f"Error: {path.name} has no video stream."

    try:
        duration = float((data.get("format") or {}).get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0
    if duration <= 0:
        # A stream-copied cut can leave the container duration unset; fall back to
        # the video stream's own, and refuse rather than sample a zero-length clip.
        try:
            duration = float(video.get("duration") or 0.0)
        except (TypeError, ValueError):
            duration = 0.0
    if duration <= 0:
        return (
            f"Error: {path.name} reports no duration — it may be truncated or "
            "0 bytes. Check the encode that produced it."
        )

    fps = _fps(video.get("avg_frame_rate") or video.get("r_frame_rate"))
    size = f"{video.get('width')} x {video.get('height')}"
    summary = f"{size} · {_seconds(duration)}s · {fps} · {video.get('codec_name')}"
    stream_lines = [
        f"  streams: {len(streams)} "
        f"({sum(1 for s in streams if s.get('codec_type') == 'video')} video, "
        f"{len(audio)} audio)"
    ]
    for track in audio:
        stream_lines.append(
            f"  audio: {track.get('codec_name')} "
            f"{track.get('channels')}ch {track.get('sample_rate')}Hz"
        )
    return {
        "duration": duration,
        "summary": summary,
        "streams": "\n".join(stream_lines),
        "has_audio": bool(audio),
    }


async def _extract_stills(
    source: Path, stamps: list[float], out_dir: Path
) -> list[Path] | str:
    """One still per timestamp, at full resolution, kept on disk."""
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        _write_gitignore(out_dir.parent.parent)
    except OSError as exc:
        return f"Error: could not create {out_dir}: {exc}"

    stills: list[Path] = []
    for index, stamp in enumerate(stamps, start=1):
        dest = out_dir / f"frame_{index:02d}.png"
        code, out = await _run(
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-y",
            # Before -i: seek by keyframe first, which is what keeps this fast on a
            # long file. Accuracy inside a frame does not matter for a contact sheet.
            "-ss",
            f"{stamp:.3f}",
            "-i",
            str(source),
            "-frames:v",
            "1",
            str(dest),
            timeout=_FRAME_TIMEOUT_SECONDS,
        )
        if code != 0 or not dest.is_file():
            return f"Error: ffmpeg could not extract a frame at {stamp:.1f}s: {out or code}"
        stills.append(dest)
    return stills


async def _contact_sheet(stills: list[Path], out_dir: Path, count: int) -> Path | str:
    """Tile the stills into one JPEG, so understanding a clip is one vision call."""
    cols, rows = _GRIDS[count]
    sheet = out_dir / "contact-sheet.jpg"
    code, out = await _run(
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-start_number",
        "1",
        "-i",
        str(out_dir / "frame_%02d.png"),
        "-frames:v",
        "1",
        "-vf",
        # -2 keeps the height even, which the scaler requires; tile then lays the
        # already-downscaled frames out in reading order.
        f"scale={_SHEET_TILE_WIDTH}:-2,tile={cols}x{rows}",
        "-q:v",
        "3",
        str(sheet),
        timeout=_FRAME_TIMEOUT_SECONDS,
    )
    if code != 0 or not sheet.is_file():
        return f"Error: ffmpeg could not build the contact sheet: {out or code}"
    return sheet


# --- formatting -----------------------------------------------------------------


def _tileable(frames: Any) -> tuple[int, bool]:
    """The nearest frame count that tiles exactly, and whether it was snapped."""
    try:
        requested = int(frames)
    except (TypeError, ValueError):
        return 4, True
    if requested in _GRIDS:
        return requested, False
    clamped = max(1, min(requested, max(_GRIDS)))
    nearest = min(_GRIDS, key=lambda n: (abs(n - clamped), n))
    return nearest, True


def _size_for(limits: VideoConstraints, aspect_ratio: str) -> str:
    """The pixel size the engine returns for a ratio, or the ratio itself."""
    known = limits.sizes.get(aspect_ratio)
    if known:
        return f"{known} ({aspect_ratio})"
    return f"{limits.short_edge}p {aspect_ratio or 'auto'}"


def _seconds(value: float) -> str:
    """Drops a trailing ".0" so 4 reads as "4" but 4.5 survives."""
    return str(int(value)) if float(value).is_integer() else f"{float(value):.1f}"


def _duration(total_seconds: float) -> str:
    minutes, seconds = divmod(int(total_seconds), 60)
    return f"{minutes}m {seconds}s" if minutes else f"{seconds}s"


def _estimate(total_seconds: float) -> str:
    minutes = total_seconds / 60
    return "under a minute" if minutes < 1 else f"~{round(minutes)} min"


def _fps(rate: Any) -> str:
    """"24 fps" from ffprobe's "24/1"."""
    try:
        num, _, den = str(rate).partition("/")
        value = float(num) / float(den or 1)
    except (TypeError, ValueError, ZeroDivisionError):
        return "fps unknown"
    if not math.isfinite(value) or value <= 0:
        return "fps unknown"
    return f"{value:.0f} fps" if float(value).is_integer() else f"{value:.2f} fps"


def _elapsed(created_at: Any) -> float | None:
    """Seconds since the job row was created, tolerating a naive timestamp."""
    if isinstance(created_at, str):
        try:
            created_at = datetime.fromisoformat(created_at)
        except ValueError:
            return None
    if not isinstance(created_at, datetime):
        return None
    # SQLite hands back what it stored, which has no offset; the writer used UTC.
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=UTC)
    return max(0.0, (datetime.now(UTC) - created_at).total_seconds())
