"""The image tool an agent gets: one call that returns a picture.

The sibling of ``agents/video_tools.py``, and the shapes carried over from it are
the ones that matter: a **factory bound to a workspace**, so relative paths mean what
the agent thinks they mean, and **every failure returned as an ``"Error: ..."``
string**, never raised — an exception escaping a tool body aborts the run, and a bad
argument should cost one step, not the turn.

The one thing this does differently is the big one. ``generate_video`` deliberately
never waits: at ~44 s a denoise step a clip is 6 to 35 minutes, and a tool call that
blocks for half an hour makes the run look hung. An image is 6.5 s on
``z-image-turbo`` and 58-116 s on ``qwen-image-2512``, which is inside the range
where waiting is simply the better interface — no job id for the model to carry
across turns, no poll tool, no half-finished state to explain. So ``generate_image``
submits, waits, copies the result into the workspace and returns the path, in one
call.

Three consequences of that choice, each handled below rather than hoped away:

* **The wait is capped** (:data:`MAX_WAIT_SECONDS`) and the generation is *not*
  cancelled when the cap is hit — the engine has no cancel on this API, and the
  backend task is detached. The timeout message says so.
* **A timed-out generation is not lost.** It is remembered and delivered on the next
  call, so the cap is a delay rather than a dead end.
* **Calls to one box are serialised** (:data:`_locks`). A model asked for three
  variations emits three tool calls in one response and pydantic-ai runs them
  concurrently; three simultaneous renders on one GPU is slower for all three and,
  at Qwen's 58.5 GB peak, can be fatal for all three.

There is no ``cancel_image``: the engine's image API has none, so there would be
nothing to free. There is no ``view_image`` either — every agent already has one
(``agents/vision.py``), which is why generating and *checking* an image needs only
this.
"""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app import media_store
from app.agents.image_runtime import ImageModel, ImageProfile, ImageRuntime
from app.agents.workspace_paths import relative_to_workspace, slug, write_gitignore
from app.api import images as images_api
from app.db.session import async_session_factory

logger = logging.getLogger(__name__)

# Where agent-owned image state lives, relative to the workspace root. ``.agents/``
# is the established convention for agent-owned workspace state (``.agents/plan/``,
# ``.agents/skills/``, ``.agents/video/``).
IMAGE_DIR = ".agents/image"
GEN_DIR = f"{IMAGE_DIR}/gen"

# Hard ceiling on one wait, measured against the worst case rather than guessed:
# ``qwen-image-2512`` at 50 CFG steps and 1024x1024 is 116 s (``api/images.py``).
# Double that leaves room for cold weights, a slow tunnel and a box with something
# else queued. Not the gateway's own 600 s timeout — past about four minutes the
# honest answer to the agent is "this is still going, do something else".
MAX_WAIT_SECONDS = 240

# A local row read with no network in it, so polling is nearly free. z-image
# finishes in ~6.5 s, and video's 5 s interval would add ~40% to that; the image
# page picked 1.5 s for the same reason.
_POLL_INTERVAL_SECONDS = 1.0

# The offered sizes, mirroring ``frontend/src/pages/image/image-settings.ts``. Only
# 1024x1024 is measured; the rest are the same pixel budget reshaped, every edge a
# multiple of 64, which is what the diffusion server's patching wants.
_SIZE_BY_RATIO: dict[str, str] = {
    "1:1": "1024x1024",
    "16:9": "1344x768",
    "9:16": "768x1344",
    "4:3": "1152x896",
    "3:4": "896x1152",
}
_DEFAULT_SIZE = _SIZE_BY_RATIO["1:1"]
_SIZE_RE = re.compile(r"^(\d+)\s*[x×]\s*(\d+)$")
# Bigger than 2048 scales the latents rather than the weights and the measured
# memory peaks (24.5 GB z-image, 58.5 GB qwen) leave headroom that is real but
# unverified; below 256 the models were never trained.
_MIN_EDGE, _MAX_EDGE = 256, 2048
_EDGE_MULTIPLE = 64

_OUTPUT_FORMATS = ("png", "jpeg", "webp")

# One generation at a time per box, keyed by connection id. See the module docstring:
# pydantic-ai dispatches the tool calls in a single model response concurrently, and
# "give me three variations" is the most natural thing a model does with this tool.
_locks: dict[str, asyncio.Lock] = {}


def _lock_for(connection_id: str) -> asyncio.Lock:
    lock = _locks.get(connection_id)
    if lock is None:
        lock = asyncio.Lock()
        _locks[connection_id] = lock
    return lock


class _Invalid(Exception):
    """A constraint the engine would reject, caught before the round trip."""


@dataclass(frozen=True)
class _Submission:
    """A validated request: the body to send, plus what it was asked for.

    The summary is built from these fields rather than read back out of ``body`` for
    the same reason ``video_tools._Submission`` exists — what was *asked for* and
    what the engine was *sent* are different questions, and only one of them is
    stable across models.
    """

    body: dict[str, Any]
    notes: list[str]
    target: ImageModel
    size: str
    steps: int
    seed: int | None
    guidance: bool
    output_format: str


@dataclass
class _Pending:
    """A generation whose wait ran out, kept so the next call can hand it over."""

    run_id: str
    prompt: str
    target: ImageModel
    started: float


def make_image_tools(
    runtime: ImageRuntime,
    workspace_path: str | Path,
    *,
    video_available: bool = False,
) -> list[Callable[..., Awaitable[str]]]:
    """The image toolset for one run, bound to ``runtime`` and the workspace.

    ``video_available`` gates one paragraph of the docstring. A generated still is a
    natural first frame for ``generate_video``, but naming a tool the agent does not
    have is exactly the confusion ``prompt_author._capability_lines`` exists to
    avoid, so the advice only appears when the video tools are actually there.
    """
    root = Path(workspace_path)
    # Runs this call gave up waiting on, delivered by whichever call comes next.
    # Closure-level, so it is scoped to one agent run rather than the process.
    pending: dict[str, _Pending] = {}

    async def generate_image(
        prompt: str,
        size: str = "1024x1024",
        steps: int | None = None,
        seed: int | None = None,
        model: str | None = None,
        guidance: bool | None = None,
        negative_prompt: str | None = None,
        output_format: str = "png",
    ) -> str:
        """Generate an image and save it into the workspace. Returns the file path.

        This WAITS for the image — most take about seven seconds — and returns the
        path to a real file, so read_file, view_image and any command-line tool can
        reach it immediately.

        Look at what you made with view_image before you use it or describe it to
        the user. Generating and checking is two calls, and the second one is cheap.

        {menu}

        Args:
            prompt: What to generate. Describe the subject, the composition and the
                style; these models reward detail over keywords.
            size: "1024x1024", or an aspect ratio — "16:9", "9:16", "4:3", "3:4",
                "1:1". A literal WxH also works if both edges are multiples of 64.
            steps: Denoise steps. Omit for the model's own default, which is the
                right answer far more often than not.
            seed: Fixed seed for a reproducible image. Omit to let the engine pick.
                Keep one to vary a prompt against a fixed composition.
            model: Which model to use. Omit for the fastest one available.
            guidance: Classifier-free guidance, on models that have it. Off is about
                half the cost and adheres less closely to the prompt.
            negative_prompt: What to keep out of the image. Only used by models with
                guidance, and only when guidance is on.
            output_format: "png" (default, lossless), "jpeg" or "webp".
        """
        delivered = await _sweep_pending()

        try:
            submission = _build_request(
                runtime,
                prompt=prompt,
                size=size,
                steps=steps,
                seed=seed,
                model=model,
                guidance=guidance,
                negative_prompt=negative_prompt,
                output_format=output_format,
            )
        except _Invalid as exc:
            return _join(delivered, f"Error: {exc}")

        target = submission.target
        queued_from = time.monotonic()
        lock = _lock_for(target.connection_id)
        try:
            await asyncio.wait_for(lock.acquire(), timeout=MAX_WAIT_SECONDS)
        except TimeoutError:
            return _join(
                delivered,
                f"Error: {target.connection_name!r} has been busy with another "
                f"image for {_duration(time.monotonic() - queued_from)} and this "
                "call gave up queueing. Nothing was submitted. Try again once the "
                "generations already running have landed.",
            )

        # The clock starts here, not at the top: time spent queueing behind another
        # generation is not time this one had to render, and charging it to the wait
        # budget would make the third of three parallel calls fail for no reason.
        queued = time.monotonic() - queued_from
        started = time.monotonic()
        deadline = started + MAX_WAIT_SECONDS
        try:
            try:
                async with async_session_factory() as session:
                    row = await images_api.create_image(
                        target.connection_id, submission.body, session
                    )
            except HTTPException as exc:
                # The engine is the authority on its own constraints, so its
                # rejection comes back verbatim.
                return _join(delivered, f"Error: {exc.detail}")
            except Exception as exc:  # noqa: BLE001 - a tool never raises
                logger.warning("generate_image failed to submit: %s", exc)
                return _join(delivered, f"Error: could not start the image: {exc}")

            run_id = str(row.get("id") or "")
            if not run_id:
                return _join(delivered, "Error: the image run was created without an id.")

            payload = await _await_terminal(target.connection_id, run_id, deadline)
        finally:
            lock.release()

        status = str(payload.get("status") or "")
        if status == "completed":
            return _join(
                delivered,
                _deliver(root, payload, submission, time.monotonic() - started, queued),
            )
        if status == "failed":
            reason = payload.get("error") or "the engine reported no reason"
            return _join(delivered, f"The image failed: {reason}")

        # Still running. Remember it so the next call can hand it over rather than
        # leaving an image the agent paid for but can never reach.
        pending[run_id] = _Pending(
            run_id=run_id, prompt=prompt, target=target, started=started
        )
        return _join(delivered, _timed_out(submission, time.monotonic() - started))

    async def _sweep_pending() -> list[str]:
        """Deliver anything an earlier call gave up waiting on, if it has landed.

        Runs before a new submission rather than after, so an agent that reacts to a
        timeout by trying again gets the first image handed to it in the same breath
        — and can decide the second one is unnecessary.
        """
        if not pending:
            return []
        lines: list[str] = []
        for run_id, waiting in list(pending.items()):
            try:
                async with async_session_factory() as session:
                    payload = await images_api.image_status(
                        waiting.target.connection_id, run_id, session
                    )
            except HTTPException:
                # The row is gone (the operator deleted it). Nothing to deliver and
                # nothing to say — it was never promised.
                pending.pop(run_id, None)
                continue
            except Exception as exc:  # noqa: BLE001 - a tool never raises
                logger.warning("could not check pending image %s: %s", run_id, exc)
                continue

            status = str(payload.get("status") or "")
            if status not in images_api.TERMINAL:
                continue
            pending.pop(run_id, None)
            if status == "failed":
                reason = payload.get("error") or "the engine reported no reason"
                lines.append(
                    f"The earlier image ({waiting.prompt[:60]!r}) failed: {reason}"
                )
                continue
            dest = _materialize(root, run_id, waiting.prompt, payload)
            if isinstance(dest, str):
                lines.append(dest)
                continue
            lines.append(
                f"The earlier image you stopped waiting for has landed: "
                f"{relative_to_workspace(root, dest)}"
            )
        return lines

    # The menu is interpolated into the middle of the docstring rather than appended
    # to it: pydantic-ai derives the argument descriptions by parsing the Google-style
    # ``Args:`` section, and anything after that section would be read as part of the
    # last argument's description. Indented to match, so the common-prefix dedent
    # every docstring parser applies still finds one.
    menu = _model_menu(runtime, video_available)
    indented = "\n".join(
        (f"        {line}" if line else "") for line in menu.split("\n")
    ).strip()
    generate_image.__doc__ = (generate_image.__doc__ or "").replace("{menu}", indented)
    return [generate_image]


# --- waiting ---------------------------------------------------------------------


async def _await_terminal(cid: str, run_id: str, deadline: float) -> dict[str, Any]:
    """Poll the row until it is terminal or the deadline passes.

    **Every read gets its own session**, which is worth a paragraph because the
    reason is not the obvious one.

    The terminal status is committed by a detached background task from its own
    session (``images._run_generation``), not by this coroutine — unlike
    ``video_status``, where the poll itself is the writer. The hazard that creates is
    SQLAlchemy's identity map plus ``expire_on_commit=False`` (``db/session.py``): a
    session that still holds a loaded ``ImageGeneration`` will re-`SELECT` it and
    hand back the *already-loaded* attributes, so the row reads ``running`` forever
    and the wait runs to the cap on a generation that finished in six seconds. It is
    not a WAL snapshot — the read transaction does see the newer commit, and
    ``expire_all()`` is enough to prove it.

    As it happens a reused session would work here today, because
    ``images.image_status`` returns ``_to_read(row)`` and keeps no reference to the
    ORM object, so refcounting drops it from the weak identity map between polls.
    That is an accident of how the route is written, not a property of it: one
    retained row anywhere on that path and this loop silently never terminates
    early. A session per read costs nothing against local SQLite and does not depend
    on someone else's object lifetimes.
    """
    payload: dict[str, Any] = {}
    while True:
        async with async_session_factory() as session:
            payload = await images_api.image_status(cid, run_id, session)
        if str(payload.get("status") or "") in images_api.TERMINAL:
            return payload
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return payload
        await asyncio.sleep(min(_POLL_INTERVAL_SECONDS, remaining))


# --- request building ------------------------------------------------------------


def _build_request(
    runtime: ImageRuntime,
    *,
    prompt: str,
    size: str,
    steps: int | None,
    seed: int | None,
    model: str | None,
    guidance: bool | None,
    negative_prompt: str | None,
    output_format: str,
) -> _Submission:
    """The engine body for these arguments, or raise :class:`_Invalid`.

    Validated locally *before* submitting, because a 400 round trip through a tunnel
    costs more than a local check and the useful part of the message ("steps must be
    in [4, 20]") is knowable here. The engine stays the authority: anything it
    rejects anyway comes back verbatim from the caller.

    ``response_format`` and ``n`` are absent on purpose — ``api/images.create_image``
    pins both, and repeating them here would imply they were negotiable.
    """
    if not (prompt or "").strip():
        raise _Invalid(
            "prompt is required — describe the subject, composition and style."
        )

    target = runtime.find(model)
    if target is None:
        available = ", ".join(m.model for m in runtime.models)
        raise _Invalid(
            f"no image model matching {model!r}. Available: {available}. "
            "Omit `model` for the fastest one."
        )
    profile = target.profile

    resolved_size = _resolve_size(size)
    step_count = _resolve_steps(steps, profile, target.model)

    if seed is not None:
        try:
            seed = int(seed)
        except (TypeError, ValueError) as exc:
            raise _Invalid(f"seed must be a whole number, got {seed!r}") from exc
        if seed < 0:
            raise _Invalid(f"seed must not be negative, got {seed}.")

    fmt = (output_format or "png").strip().lower()
    if fmt == "jpg":
        fmt = "jpeg"
    if fmt not in _OUTPUT_FORMATS:
        raise _Invalid(
            f"output_format {output_format!r} is not one of "
            f"{', '.join(_OUTPUT_FORMATS)}."
        )

    guidance_fields, notes = _guidance_fields(profile, guidance, negative_prompt)

    body: dict[str, Any] = {
        "model": target.model,
        "prompt": prompt.strip(),
        "size": resolved_size,
        "num_inference_steps": step_count,
        "output_format": fmt,
        **({"seed": seed} if seed is not None else {}),
        **guidance_fields,
    }
    return _Submission(
        body=body,
        notes=notes,
        target=target,
        size=resolved_size,
        steps=step_count,
        seed=seed,
        guidance=profile.guidance and "true_cfg_scale" not in guidance_fields,
        output_format=fmt,
    )


def _resolve_size(size: str) -> str:
    """An engine ``size`` string from a ratio or a literal, or raise."""
    raw = (size or "").strip().lower()
    if not raw:
        return _DEFAULT_SIZE
    if raw in _SIZE_BY_RATIO:
        return _SIZE_BY_RATIO[raw]
    match = _SIZE_RE.match(raw)
    if not match:
        ratios = ", ".join(f'"{r}"' for r in _SIZE_BY_RATIO)
        raise _Invalid(
            f"size {size!r} is not a size. Use one of {ratios}, or a literal "
            'like "1024x1024".'
        )
    width, height = int(match.group(1)), int(match.group(2))
    for edge, label in ((width, "width"), (height, "height")):
        if not _MIN_EDGE <= edge <= _MAX_EDGE:
            raise _Invalid(
                f"{label} {edge} is outside [{_MIN_EDGE}, {_MAX_EDGE}]. "
                f'The measured size is "{_DEFAULT_SIZE}".'
            )
        if edge % _EDGE_MULTIPLE:
            raise _Invalid(
                f"{label} must be a multiple of {_EDGE_MULTIPLE}, got {edge}. "
                f"The nearest is {round(edge / _EDGE_MULTIPLE) * _EDGE_MULTIPLE}."
            )
    return f"{width}x{height}"


def _resolve_steps(steps: int | None, profile: ImageProfile, model: str) -> int:
    """The step count, defaulting to the model's own rather than a shared number."""
    if steps is None:
        return profile.default_steps
    try:
        count = int(steps)
    except (TypeError, ValueError) as exc:
        raise _Invalid(f"steps must be a whole number, got {steps!r}") from exc
    if not profile.min_steps <= count <= profile.max_steps:
        raise _Invalid(
            f"steps must be in [{profile.min_steps}, {profile.max_steps}] for "
            f"{model}, got {count}. Omit `steps` for its default of "
            f"{profile.default_steps}."
        )
    return count


def _guidance_fields(
    profile: ImageProfile, guidance: bool | None, negative_prompt: str | None
) -> tuple[dict[str, Any], list[str]]:
    """The guidance half of the body, encoded the way the engine decides it.

    The engine turns CFG on when ``true_cfg_scale > 1`` *and* ``negative_prompt is
    not None``, and Qwen's sampling defaults set ``negative_prompt`` to " " — a
    space, which is not None — so CFG is on by default there and doubles the cost.
    Z-Image defaults it to None and is CFG-distilled, so sending guidance fields at
    all would switch on something the checkpoint does not want.

    Mirrors ``frontend/src/pages/image/image-settings.ts:328-349``. Keep the two in
    step: this is the only part of the profile table where drift produces a wrong
    *request* rather than a worse estimate.

    An unsupported knob is dropped with a note rather than raised on, which is the
    opposite of ``video_tools``' handling of a keyframe against a model without
    them. There, honouring the request was impossible and the output would have been
    materially different; here the model simply has no such knob, and a note costs
    the agent nothing while an error costs it a turn.
    """
    wanted_negative = (negative_prompt or "").strip()
    notes: list[str] = []

    if not profile.guidance:
        if guidance or wanted_negative:
            notes.append(
                f"{profile.label} is CFG-distilled, so guidance and negative_prompt "
                "do not apply here and were not sent."
            )
        return {}, notes

    on = profile.guidance if guidance is None else bool(guidance)
    if not on:
        if wanted_negative:
            notes.append(
                "negative_prompt was not sent: it only applies with guidance on."
            )
        return {"true_cfg_scale": 1}, notes
    return ({"negative_prompt": wanted_negative} if wanted_negative else {}), notes


# --- delivery --------------------------------------------------------------------


def _deliver(
    root: Path,
    payload: dict[str, Any],
    submission: _Submission,
    waited: float,
    queued: float,
) -> str:
    """Materialize a finished image and describe what landed."""
    run_id = str(payload.get("id") or "")
    dest = _materialize(root, run_id, submission.body.get("prompt", ""), payload)
    if isinstance(dest, str):
        return dest

    target = submission.target
    measured = _as_float(payload.get("inference_time_s"))
    # Inference time is what the box spent; wall clock includes the round trip and
    # the poll granularity. Saying which is which keeps a later "why was that slow"
    # answerable.
    took = f"{measured:.1f}s" if measured is not None else f"{waited:.1f}s wall clock"

    detail = [submission.size, f"{submission.steps} steps"]
    detail.append(
        f"seed {submission.seed}"
        if submission.seed is not None
        else "seed: engine's choice"
    )
    if target.profile.guidance and not submission.guidance:
        detail.append("no CFG")
    if submission.output_format != "png":
        detail.append(submission.output_format)

    lines = [
        f"Generated with {target.model} on {target.connection_name!r} ({took}).",
        f"  {relative_to_workspace(root, dest)}",
        f"  {' · '.join(detail)}",
    ]
    if queued >= 1.0:
        lines.append(f"  waited {_duration(queued)} behind another generation.")
    lines += [f"  {note}" for note in submission.notes]
    lines.append("  view_image it to check before using it.")
    return "\n".join(lines)


def _materialize(
    root: Path, run_id: str, prompt: str, payload: dict[str, Any]
) -> Path | str:
    """Copy the stored image into ``.agents/image/gen/``, once.

    A copy rather than a hardlink: images are single-digit MB, and a link shares fate
    with the cache the media store exists to protect. The filename embeds the run id,
    so a second materialize of the same run finds its own file already there.

    The extension comes from the media id — that is, from the mime the bytes were
    *sniffed* as (``api/images._sniff_mime``) — and never from the requested
    ``output_format``, which is a request the engine is free to ignore.
    """
    media_id = str(payload.get("media_id") or "")
    if not media_id or not media_store.MEDIA_ID_RE.match(media_id):
        return "Error: the image completed but its stored file could not be located."
    source = media_store.generated_image_path(media_id)
    if not source.is_file():
        return "Error: the image completed but is missing from the media store."

    gen = root / GEN_DIR
    try:
        gen.mkdir(parents=True, exist_ok=True)
        write_gitignore(root / IMAGE_DIR, "Agent-generated images; not source.")
    except OSError as exc:
        return f"Error: could not create {GEN_DIR} in the workspace: {exc}"

    dest = gen / f"{slug(prompt) or 'image'}-{run_id[:8]}{source.suffix}"
    if dest.is_file() and dest.stat().st_size == source.stat().st_size:
        return dest
    try:
        shutil.copyfile(source, dest)
    except OSError as exc:
        return f"Error: could not copy the image into the workspace: {exc}"
    return dest


def _timed_out(submission: _Submission, waited: float) -> str:
    """What to say when the cap ran out with the render still going.

    Honest about the two things that are easy to get wrong here: the generation was
    not cancelled (there is no cancel on this API, and the backend task is detached),
    and it is not lost either — the next call to this tool will hand it over.
    """
    target = submission.target
    estimate = target.estimate_seconds(submission.steps, submission.guidance)
    lines = [
        f"Still generating after {_duration(waited)}. This call stopped waiting; the "
        "generation did NOT stop — it is still running on the box.",
        f"  {target.model} on {target.connection_name!r} · {submission.size} · "
        f"{submission.steps} steps"
        + (f" · estimated {_duration(estimate)}" if estimate else ""),
        "  Call generate_image again and it will hand you this one first, as soon "
        "as it lands. It also appears in the Image pane either way.",
    ]
    if target.profile.guidance and submission.guidance:
        lines.append(
            "  For a faster answer: guidance=False halves the cost, or use a "
            "step-distilled model."
        )
    return "\n".join(lines)


def _model_menu(runtime: ImageRuntime, video_available: bool) -> str:
    """The tail of the tool docstring: what is serving, and what it costs.

    Generated rather than written, so the model never reads about a checkpoint this
    box is not running.
    """
    lines = ["Models available here (omit `model` for the first):"]
    for candidate in runtime.models:
        marker = " (default)" if candidate is runtime.default else ""
        lines.append(f"  {candidate.model}{marker} — {candidate.profile.note}")
    lines += [
        "",
        f"The wait is capped at {MAX_WAIT_SECONDS // 60} minutes. Past that the "
        "render keeps going and the next call to this tool hands it to you.",
        "There is no cancel: the engine's image API has none, so a submitted "
        "generation always runs to completion.",
    ]
    if video_available:
        lines += [
            "",
            "A generated image is a natural first_frame for generate_video — draw "
            'the opening still cheaply, view_image it, then spend the render. Pass '
            'output_format="jpeg" when you intend to: a keyframe is inlined into '
            "the request and a photographic 1024px PNG usually exceeds the "
            "gateway's body limit.",
        ]
    return "\n".join(lines)


# --- formatting ------------------------------------------------------------------


def _join(delivered: list[str], result: str) -> str:
    """Prepend anything a previous call left behind to this call's answer."""
    return "\n\n".join([*delivered, result]) if delivered else result


def _duration(seconds: float) -> str:
    total = int(round(seconds))
    if total < 60:
        return f"{total}s"
    return f"{total // 60}m {total % 60:02d}s"


def _as_float(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None
