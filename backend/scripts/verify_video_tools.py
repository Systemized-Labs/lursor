"""End-to-end check of the video tools against a real laios box.

Not a test: it spends real GPU time and needs a box serving a ``capabilities:
[video]`` model, so it is a script you run deliberately rather than something
``pytest`` picks up. Everything else about the feature is covered offline
(``tests/test_video_tools.py``); what only a real box can answer is whether the
request shapes are right — in particular ``fl2va``, whose keyframe rides in the body
as base64 and therefore has to fit the gateway's own body limit.

Runs against a throwaway database and media store, so it touches neither the app's
history nor its media cache.

    LAIOS_BASE_URL=http://192.168.68.67:7420 LAIOS_MASTER_KEY=sk-... \
      uv run python scripts/verify_video_tools.py [--steps 4]

``--steps`` is the whole cost knob: ~44 s per step per generation, and this makes two
(a text-to-video shot, then a first-frame continuation of it).
"""

from __future__ import annotations

import argparse
import asyncio
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

# Point the app at throwaway state BEFORE importing it: ``app.db.session`` builds its
# engine at import time and ``get_settings`` is cached, so this is the only window.
_TMP = Path(tempfile.mkdtemp(prefix="lursor-video-verify-"))
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_TMP}/verify.db"
os.environ["MEDIA_DIR"] = str(_TMP / "media")
os.environ["WORKSPACES_DIR"] = str(_TMP / "workspaces")

from app.agents.video_runtime import load_video_runtime  # noqa: E402
from app.agents.video_tools import make_video_tools  # noqa: E402
from app.db.models import Agent, LaiosConnection  # noqa: E402
from app.db.session import async_session_factory, init_db  # noqa: E402


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--steps", type=int, default=4)
    parser.add_argument("--duration", type=float, default=4.0)
    args = parser.parse_args()

    base_url = os.environ.get("LAIOS_BASE_URL")
    master_key = os.environ.get("LAIOS_MASTER_KEY")
    if not base_url or not master_key:
        print("set LAIOS_BASE_URL and LAIOS_MASTER_KEY", file=sys.stderr)
        return 2

    workspace = _TMP / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    await init_db()

    async with async_session_factory() as session:
        session.add(
            LaiosConnection(name="verify-box", base_url=base_url, master_key=master_key)
        )
        session.add(Agent(name="verify-agent", include_video=True))
        await session.commit()

    # 1. Resolution — the real capabilities join against the real control plane.
    async with async_session_factory() as session:
        runtime = await load_video_runtime(session, include_video=True)
    if runtime is None:
        print("FAIL: no video-capable model resolved on that box", file=sys.stderr)
        return 1
    log(f"resolved {runtime.model!r} on {runtime.connection_name!r}")

    # By name, not by position: the toolset's order is not part of its contract.
    tools = {fn.__name__: fn for fn in make_video_tools(runtime, workspace)}
    generate_video = tools["generate_video"]
    video_status = tools["video_status"]
    view_video = tools["view_video"]
    cancel_video = tools["cancel_video"]

    # 2. t2va, the ordinary path.
    log(f"submitting t2va at {args.steps} steps (~{args.steps * 44}s)")
    submitted = await generate_video(
        "a paper boat drifting across a puddle at dusk, gentle ripples, faint rain",
        duration_seconds=args.duration,
        steps=args.steps,
        seed=1101,
    )
    print(submitted, flush=True)
    if submitted.startswith("Error:"):
        return 1
    job_id = _job_id(submitted)

    clip = await _await_clip(video_status, job_id, workspace)
    if clip is None:
        return 1
    log(f"t2va clip: {clip}")

    described = await view_video(str(clip), question="What is happening in this clip?")
    print(described, flush=True)

    # 3. fl2va, conditioned on the last frame of what we just made. JPEG on purpose:
    # a photographic PNG of a 768p frame can exceed the gateway's 2 MiB body limit.
    last = workspace / ".agents/video/frames/shot-last.jpg"
    last.parent.mkdir(parents=True, exist_ok=True)
    extract = await _run(
        "ffmpeg", "-nostdin", "-y", "-v", "error", "-sseof", "-0.1",
        "-i", str(workspace / clip), "-frames:v", "1", "-update", "1",
        "-q:v", "3", str(last),
    )
    if extract != 0 or not last.is_file():
        print("FAIL: could not extract a last frame", file=sys.stderr)
        return 1
    log(f"last frame: {last.stat().st_size} bytes")

    log(f"submitting fl2va at {args.steps} steps (~{args.steps * 44}s)")
    submitted = await generate_video(
        "the same puddle, the camera drifts left as the rain eases",
        aspect_ratio="auto",
        duration_seconds=args.duration,
        steps=args.steps,
        seed=1102,
        first_frame=str(last.relative_to(workspace)),
    )
    print(submitted, flush=True)
    if submitted.startswith("Error:"):
        return 1

    clip = await _await_clip(video_status, _job_id(submitted), workspace)
    if clip is None:
        return 1
    log(f"fl2va clip: {clip}")
    print(await view_video(str(clip), question="Describe the motion and framing."), flush=True)

    # 4. Cancel — submitted and immediately withdrawn, so the box is not left running
    # a clip nobody wants.
    submitted = await generate_video("a throwaway shot", steps=args.steps, seed=1)
    if not submitted.startswith("Error:"):
        print(await cancel_video(_job_id(submitted)), flush=True)

    log(f"artifacts under {workspace}")
    return 0


def _job_id(submitted: str) -> str:
    return submitted.split("Submitted job ", 1)[1].split()[0]


async def _await_clip(video_status, job_id: str, workspace: Path) -> Path | None:
    """Poll with the tool's own bounded wait until it hands back a path."""
    for _ in range(20):
        answer = await video_status(job_id, wait_seconds=120)
        print(answer, flush=True)
        if answer.startswith("Error:") or "failed" in answer.split("\n")[0]:
            return None
        for line in answer.splitlines():
            candidate = line.strip().split(" — ")[0]
            if candidate.endswith(".mp4") and (workspace / candidate).is_file():
                return Path(candidate)
    print("FAIL: gave up waiting", file=sys.stderr)
    return None


async def _run(*args: str) -> int:
    proc = await asyncio.create_subprocess_exec(*args)
    return await proc.wait()


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    finally:
        shutil.rmtree(_TMP, ignore_errors=True) if os.environ.get(
            "VERIFY_CLEANUP"
        ) else print(f"state kept at {_TMP}")
