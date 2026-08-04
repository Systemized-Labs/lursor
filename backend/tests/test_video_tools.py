"""The video tools' contract: text out, never an exception, and a file on disk.

Three things these pin down, all of them failure-shaped:

1. **Nothing raises.** An exception escaping a tool body aborts the whole run, so a
   bad path, a rejected knob or a dead gateway all have to come back as
   ``"Error: ..."`` text the model can react to.
2. **Constraints are rejected locally, with the reason.** A 400 round trip through a
   tunnel costs more than a local check, and the useful half of the message
   ("must be in [4, 15]") is knowable here.
3. **The clip lands in the workspace.** The media store is outside it; ffmpeg,
   ``ls`` and ``read_file`` are all inside. A tool that answered with a
   ``~/.lursor`` path would be handing the agent something it will get wrong.

The gateway is an httpx MockTransport, so no box and no GPU are needed.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import delete

from app.agents.video_runtime import VideoRuntime
from app.agents.video_tools import make_video_tools
from app.config import get_settings
from app.db.models import LaiosConnection, VideoJob
from app.db.session import async_session_factory

CLIP_BYTES = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64


@pytest.fixture
async def box(client: AsyncClient, tmp_path, monkeypatch):
    """A connection row, an isolated media store, and a workspace to write into."""
    monkeypatch.setattr(get_settings(), "media_dir", tmp_path / "media")
    async with async_session_factory() as session:
        await session.execute(delete(VideoJob))
        conn = LaiosConnection(
            name="spark-head", base_url="http://spark:7420", master_key="sk-test"
        )
        session.add(conn)
        await session.commit()
        cid = conn.id
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    return VideoRuntime(
        connection_id=cid, connection_name="spark-head", model="minimax-h3"
    ), workspace


def _tools(runtime, workspace) -> dict:
    """The toolset keyed by name, so adding a tool does not renumber every test."""
    return {fn.__name__: fn for fn in make_video_tools(runtime, workspace)}


def _gateway(monkeypatch, handler) -> None:
    """Point the video proxy's gateway client at ``handler``."""
    from app.api import videos as videos_mod

    async def fake_base(conn):  # noqa: ANN001
        return "http://gateway.test/v1"

    async def fake_gateway(conn, timeout=None):  # noqa: ANN001
        return httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="http://gateway.test/v1",
        )

    monkeypatch.setattr(videos_mod, "gateway_base", fake_base)
    monkeypatch.setattr(videos_mod, "_gateway", fake_gateway)


def _lifecycle(captured: dict, *, status: str = "completed"):
    """A gateway that accepts one job, reports ``status``, and serves a clip."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "POST" and path.endswith("/videos"):
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, json={"id": "vid_test", "status": "queued"})
        if path.endswith("/content"):
            return httpx.Response(
                200, content=CLIP_BYTES, headers={"content-type": "video/mp4"}
            )
        return httpx.Response(200, json={"status": status, "progress": 1.0})

    return handler


async def test_submit_returns_a_job_id_and_an_estimate(box, monkeypatch):
    """The model has to know what it just started and what it will cost."""
    runtime, workspace = box
    captured: dict = {}
    _gateway(monkeypatch, _lifecycle(captured))
    generate_video = _tools(runtime, workspace)["generate_video"]

    result = await generate_video("a paper boat drifting across a puddle", steps=8)

    assert "vid_test" in result
    assert "minimax-h3" in result and "spark-head" in result
    assert "~6 min" in result, "8 steps at 44s each is the whole progress story"
    assert "video_status" in result, "the next call must be spelled out"
    # Built the way the page builds it: the engine's own schema, nothing invented.
    assert captured["body"]["task"] == "t2va"
    assert captured["body"]["target"] == {
        "short_edge": 768,
        "aspect_ratio": "16:9",
        "duration_seconds": 4.0,
    }
    assert captured["body"]["num_inference_steps"] == 8
    assert "conditions" not in captured["body"], "t2va sends no conditions"


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        ({"duration_seconds": 30}, "[4, 15]"),
        ({"duration_seconds": 2}, "[4, 15]"),
        ({"steps": 80}, "[4, 50]"),
        ({"aspect_ratio": "21:9"}, "21:9"),
        ({"seed": -1}, "negative"),
    ],
)
async def test_bad_constraints_are_rejected_locally_with_the_reason(
    box, monkeypatch, kwargs, expected
):
    """A knob the engine would reject never leaves the machine."""
    runtime, workspace = box

    def never(request: httpx.Request) -> httpx.Response:
        raise AssertionError("a locally-invalid request must not be submitted")

    _gateway(monkeypatch, never)
    generate_video = _tools(runtime, workspace)["generate_video"]

    result = await generate_video("a shot", **kwargs)
    assert result.startswith("Error:")
    assert expected in result


async def test_empty_prompt_is_rejected(box, monkeypatch):
    runtime, workspace = box
    generate_video = _tools(runtime, workspace)["generate_video"]
    assert (await generate_video("  ")).startswith("Error:")


async def test_gateway_rejection_is_surfaced_verbatim(box, monkeypatch):
    """The engine is the authority on its own constraints, so its wording wins."""
    runtime, workspace = box

    def strict(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={"detail": "target.short_edge must be 768 for minimax_h3, got 1080"},
        )

    _gateway(monkeypatch, strict)
    generate_video = _tools(runtime, workspace)["generate_video"]

    result = await generate_video("a shot")
    assert result == (
        "Error: target.short_edge must be 768 for minimax_h3, got 1080"
    )


async def test_unreachable_box_is_text_not_an_exception(box, monkeypatch):
    runtime, workspace = box

    def dead(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    _gateway(monkeypatch, dead)
    generate_video = _tools(runtime, workspace)["generate_video"]

    assert (await generate_video("a shot")).startswith("Error:")


async def test_first_and_last_frames_become_ordered_keyframes(box, monkeypatch):
    """The engine accepts frame_index [0], [-1] or [0, -1] — in that order."""
    runtime, workspace = box
    captured: dict = {}
    _gateway(monkeypatch, _lifecycle(captured))
    generate_video = _tools(runtime, workspace)["generate_video"]

    (workspace / "shots").mkdir()
    (workspace / "shots/a.png").write_bytes(b"pretend png")
    (workspace / "shots/b.png").write_bytes(b"pretend png too")

    result = await generate_video(
        "the frame continues with calm, natural motion",
        aspect_ratio="auto",
        first_frame="shots/a.png",
        last_frame="shots/b.png",
    )
    assert not result.startswith("Error:"), result

    body = captured["body"]
    assert body["task"] == "fl2va"
    assert [c["frame_index"] for c in body["conditions"]] == [0, -1]
    assert all(c["role"] == "keyframe" for c in body["conditions"])
    assert all(c["type"] == "image" for c in body["conditions"])
    # Inlined, because Lursor does not run on the box: a path would name a file the
    # engine cannot see.
    assert body["conditions"][0]["uri"].startswith("data:image/png;base64,")
    assert body["target"]["aspect_ratio"] == "auto"


async def test_a_missing_frame_is_an_error_not_a_submission(box, monkeypatch):
    runtime, workspace = box

    def never(request: httpx.Request) -> httpx.Response:
        raise AssertionError("a missing frame must not be submitted")

    _gateway(monkeypatch, never)
    generate_video = _tools(runtime, workspace)["generate_video"]

    result = await generate_video("a shot", first_frame="shots/nope.png")
    assert result.startswith("Error:")
    assert "first_frame" in result and "nope.png" in result


async def test_a_video_passed_as_a_frame_says_how_to_extract_one(box, monkeypatch):
    runtime, workspace = box
    _gateway(monkeypatch, _lifecycle({}))
    generate_video = _tools(runtime, workspace)["generate_video"]
    (workspace / "shot.mp4").write_bytes(CLIP_BYTES)

    result = await generate_video("a shot", first_frame="shot.mp4")
    assert result.startswith("Error:")
    assert "-sseof" in result, "point at the recipe rather than just refusing"


async def test_completed_poll_materializes_the_clip_into_the_workspace(
    box, monkeypatch
):
    """The answer is a workspace-relative path, and the tree self-ignores."""
    runtime, workspace = box
    captured: dict = {}
    _gateway(monkeypatch, _lifecycle(captured))
    tools = _tools(runtime, workspace)
    generate_video, video_status = tools["generate_video"], tools["video_status"]

    await generate_video("a paper boat drifting across a puddle")
    result = await video_status("vid_test")

    assert "completed" in result
    expected = Path(".agents/video/gen/a-paper-boat-drifting-across-a-puddle-vid-test.mp4")
    assert str(expected) in result
    landed = workspace / expected
    assert landed.read_bytes() == CLIP_BYTES
    # A workspace is usually a git repo; mp4 blobs would flood the git panel.
    assert (workspace / ".agents/video/.gitignore").read_text().strip().endswith("*")


async def test_second_materialize_reuses_the_file(box, monkeypatch):
    """Asking twice must not leave two copies of the same clip in the workspace."""
    runtime, workspace = box
    _gateway(monkeypatch, _lifecycle({}))
    tools = _tools(runtime, workspace)
    generate_video, video_status = tools["generate_video"], tools["video_status"]

    await generate_video("a shot")
    first = await video_status("vid_test")
    second = await video_status("vid_test")

    assert first == second
    gen = workspace / ".agents/video/gen"
    assert len(list(gen.glob("*.mp4"))) == 1


async def test_still_running_reports_elapsed_and_how_to_wait(box, monkeypatch):
    """Not finished is an answer, not a reason to block for half an hour."""
    runtime, workspace = box
    _gateway(monkeypatch, _lifecycle({}, status="in_progress"))
    tools = _tools(runtime, workspace)
    generate_video, video_status = tools["generate_video"], tools["video_status"]

    await generate_video("a shot", steps=8)
    result = await video_status("vid_test")

    assert "in_progress" in result
    assert "elapsed" in result
    assert "~6 min" in result
    assert "wait_seconds=300" in result


async def test_failed_job_returns_the_engines_own_reason(box, monkeypatch):
    runtime, workspace = box

    def failing(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"id": "vid_test", "status": "queued"})
        return httpx.Response(
            200, json={"status": "failed", "error": {"message": "CUDA out of memory"}}
        )

    _gateway(monkeypatch, failing)
    tools = _tools(runtime, workspace)
    generate_video, video_status = tools["generate_video"], tools["video_status"]

    await generate_video("a shot")
    result = await video_status("vid_test")
    assert "failed" in result
    assert "CUDA out of memory" in result


async def test_unknown_job_id_is_an_error_not_a_crash(box, monkeypatch):
    runtime, workspace = box
    video_status = _tools(runtime, workspace)["video_status"]

    result = await video_status("vid_nope")
    assert result.startswith("Error:")
    assert "generate_video" in result, "say where a job id comes from"

    assert (await video_status("")).startswith("Error:")


async def test_wait_seconds_is_capped(box, monkeypatch):
    """A tool that can be told to block for an hour is a hung run."""
    runtime, workspace = box
    _gateway(monkeypatch, _lifecycle({}, status="completed"))
    tools = _tools(runtime, workspace)
    generate_video, video_status = tools["generate_video"], tools["video_status"]

    await generate_video("a shot")
    # Completing immediately means the cap is never actually slept; what matters is
    # that an absurd request is accepted and clamped rather than honoured.
    assert "completed" in await video_status("vid_test", wait_seconds=100_000)


# --- view_video -----------------------------------------------------------------
#
# Skipped rather than mocked where ffmpeg is absent: the interesting part of this
# tool *is* the ffmpeg invocation, and a test that stubs it out asserts nothing.

needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not installed; view_video is a thin wrapper over them",
)


async def test_view_video_reports_a_missing_file_as_text(box):
    runtime, workspace = box
    view_video = _tools(runtime, workspace)["view_video"]

    result = await view_video("nope.mp4")
    assert result.startswith("Error:")
    assert "nope.mp4" in result


async def test_view_video_rejects_a_file_that_is_not_a_video(box):
    runtime, workspace = box
    view_video = _tools(runtime, workspace)["view_video"]
    (workspace / "notes.txt").write_text("not a video")

    result = await view_video("notes.txt")
    assert result.startswith("Error:")


@needs_ffmpeg
async def test_view_video_probes_tiles_and_asks_one_vision_question(
    box, monkeypatch, tmp_path
):
    """One vision call over a contact sheet, with the stills left on disk."""
    from app.agents import video_tools

    runtime, workspace = box
    clip = workspace / "shot.mp4"
    made = await _make_test_clip(clip)
    if not made:
        pytest.skip("this ffmpeg build cannot synthesize a test clip")

    asked: dict = {}

    async def fake_describe(raw, mime, question):
        asked["mime"] = mime
        asked["question"] = question
        asked["bytes"] = len(raw)
        return "A colour test pattern, unchanging across all four frames."

    monkeypatch.setattr(video_tools, "describe_image_bytes", fake_describe)
    view_video = _tools(runtime, workspace)["view_video"]

    result = await view_video("shot.mp4", question="What is on screen?", frames=4)

    assert not result.startswith("Error:"), result
    assert "320 x 240" in result
    assert "colour test pattern" in result
    # The timestamps are handed to the model in words rather than drawn onto the
    # sheet, so it can refer to them without a font path in the mix.
    assert "reading order" in asked["question"]
    assert "What is on screen?" in asked["question"]
    assert asked["mime"] == "image/jpeg"
    stills = sorted((workspace / ".agents/video/frames/shot").glob("frame_*.png"))
    assert len(stills) == 4, "individual stills stay readable at full resolution"


@needs_ffmpeg
async def test_view_video_snaps_an_untileable_frame_count_and_says_so(
    box, monkeypatch
):
    """A cap that isn't stated reads as "this is what you asked for"."""
    from app.agents import video_tools

    runtime, workspace = box
    clip = workspace / "shot.mp4"
    if not await _make_test_clip(clip):
        pytest.skip("this ffmpeg build cannot synthesize a test clip")

    async def fake_describe(raw, mime, question):
        return "described"

    monkeypatch.setattr(video_tools, "describe_image_bytes", fake_describe)
    view_video = _tools(runtime, workspace)["view_video"]

    result = await view_video("shot.mp4", frames=5)
    assert "Sampled 4 frames rather than 5" in result


@needs_ffmpeg
async def test_view_video_names_an_audio_track_it_cannot_judge(box, monkeypatch):
    """H3 emits audio-video and nothing here listens, so it must say so."""
    from app.agents import video_tools

    runtime, workspace = box
    clip = workspace / "with-sound.mp4"
    if not await _make_test_clip(clip, audio=True):
        pytest.skip("this ffmpeg build cannot synthesize a test clip with audio")

    async def fake_describe(raw, mime, question):
        return "described"

    monkeypatch.setattr(video_tools, "describe_image_bytes", fake_describe)
    view_video = _tools(runtime, workspace)["view_video"]

    result = await view_video("with-sound.mp4")
    assert "audio" in result
    assert "NOT examined" in result


async def _make_test_clip(dest: Path, *, audio: bool = False) -> bool:
    """A 2-second synthetic clip, so the ffmpeg path is exercised for real."""
    from app.agents.video_tools import _run

    args = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x240:rate=24:duration=2",
    ]
    if audio:
        args += ["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac"]
    args += ["-pix_fmt", "yuv420p", str(dest)]
    code, _ = await _run(*args, timeout=60)
    return code == 0 and dest.is_file()


# --- cancel ---------------------------------------------------------------------


async def test_cancel_stops_a_running_job(box, monkeypatch):
    """A wrong prompt should not hold the GPU for another half hour."""
    runtime, workspace = box
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"id": "vid_test", "status": "queued"})
        if request.method == "DELETE":
            seen["deleted"] = request.url.path
            return httpx.Response(200, json={"id": "vid_test", "status": "cancelled"})
        return httpx.Response(200, json={"status": "in_progress", "progress": 0.0})

    _gateway(monkeypatch, handler)
    tools = _tools(runtime, workspace)

    await tools["generate_video"]("a shot nobody wants")
    result = await tools["cancel_video"]("vid_test")

    assert seen["deleted"].endswith("/videos/vid_test")
    assert "cancelled" in result
    # The attempt survives in the history rather than vanishing.
    async with async_session_factory() as session:
        from app.agents.video_tools import _find_job

        job = await _find_job(session, runtime.connection_id, "vid_test")
        assert job is not None and job.status == "cancelled"


async def test_cancelling_a_finished_job_says_so_without_a_call(box, monkeypatch):
    runtime, workspace = box

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"id": "vid_test", "status": "completed"})
        raise AssertionError("a terminal job must not be cancelled upstream")

    _gateway(monkeypatch, handler)
    tools = _tools(runtime, workspace)

    await tools["generate_video"]("a shot")
    assert "already completed" in await tools["cancel_video"]("vid_test")


async def test_cancelling_an_unknown_job_is_text(box):
    runtime, workspace = box
    assert (await _tools(runtime, workspace)["cancel_video"]("vid_nope")).startswith(
        "Error:"
    )
    assert (await _tools(runtime, workspace)["cancel_video"]("")).startswith("Error:")


# --- the gateway's body limit ---------------------------------------------------


async def test_an_oversized_keyframe_is_rejected_with_the_remedy(box, monkeypatch):
    """The tightest real constraint, and the least obvious.

    The laios gateway buffers the request body behind axum's default 2 MiB limit and
    answers ``413 Failed to buffer the request body`` above it — measured against a
    running box. A keyframe is inlined as base64 (4/3 of its bytes), so a
    photographic PNG of a 768p frame can bust it while a synthetic one, ten times
    smaller, sails through. Catching it locally is the difference between "here is
    what to do" and an opaque 413.
    """
    runtime, workspace = box

    def never(request: httpx.Request) -> httpx.Response:
        raise AssertionError("an oversized body must not be sent")

    _gateway(monkeypatch, never)
    generate_video = _tools(runtime, workspace)["generate_video"]

    # Incompressible, so it is genuinely this big rather than merely claiming to be.
    (workspace / "huge.png").write_bytes(os.urandom(3 * 1024 * 1024))

    result = await generate_video("a shot", first_frame="huge.png")
    assert result.startswith("Error:")
    assert "-q:v 3" in result, "say how to make it fit"


async def test_two_frames_that_only_bust_the_limit_together_are_caught(
    box, monkeypatch
):
    """Per-frame checks would pass this; the body is what the gateway measures."""
    runtime, workspace = box

    def never(request: httpx.Request) -> httpx.Response:
        raise AssertionError("an oversized body must not be sent")

    _gateway(monkeypatch, never)
    generate_video = _tools(runtime, workspace)["generate_video"]

    for name in ("a.png", "b.png"):
        # ~1 MiB each: under the per-frame ceiling, over the budget as a pair.
        (workspace / name).write_bytes(os.urandom(1_000_000))

    result = await generate_video("a shot", first_frame="a.png", last_frame="b.png")
    assert result.startswith("Error:")
    assert "body limit" in result


async def test_a_jpg_frame_is_accepted_and_sent_as_image_jpeg(box, monkeypatch):
    """The regression a real box found.

    ``mime_for_path`` answers ``image/jpg`` for ``.jpg`` (its extension table is a
    dict inversion in which that alias comes last), so an exact-match check on
    ``image/jpeg`` rejected the *recommended* keyframe format outright. The wire must
    still carry the canonical type: the engine derives a temp-file suffix from the
    media type in the data URI.
    """
    runtime, workspace = box
    captured: dict = {}
    _gateway(monkeypatch, _lifecycle(captured))
    generate_video = _tools(runtime, workspace)["generate_video"]

    (workspace / "last.jpg").write_bytes(b"pretend jpeg bytes")
    result = await generate_video("continue the shot", first_frame="last.jpg")

    assert not result.startswith("Error:"), result
    assert captured["body"]["conditions"][0]["uri"].startswith("data:image/jpeg;base64,")


async def test_a_frame_type_the_engine_cannot_read_names_the_remedy(box, monkeypatch):
    runtime, workspace = box
    _gateway(monkeypatch, _lifecycle({}))
    generate_video = _tools(runtime, workspace)["generate_video"]

    (workspace / "frame.tiff").write_bytes(b"not a supported image")
    result = await generate_video("a shot", first_frame="frame.tiff")

    assert result.startswith("Error:")
    assert "-q:v 3 last.jpg" in result, "point at the JPEG recipe, not PNG"
