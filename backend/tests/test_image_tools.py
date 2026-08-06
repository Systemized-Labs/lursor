"""The agent's ``generate_image`` tool: what it sends, what it waits for, what it says.

Three things here are load-bearing and none of them are obvious from the tool's
signature.

**The wait is against a row another session writes.** ``create_image`` returns while
the row is ``running`` and a detached background task commits the terminal status
from its own session, so what these cases really exercise is the poll loop observing
someone else's commit. Note what is *not* pinned here: a loop reusing one session
would pass this suite today, because ``images.image_status`` keeps no reference to
the ORM row and refcounting drops it from the identity map between polls. The
per-read session in ``_await_terminal`` is defensive against that changing, not a fix
for a live bug — see its docstring. The cap is monkeypatched low throughout anyway,
because every failure mode in the waiting path shows up as a timeout rather than an
error.

**Guidance encoding is the one place drift is fatal.** Everything else in the profile
table produces a worse estimate when it is wrong; ``guidance`` produces a wrong
request. So the bodies are asserted field by field against
``frontend/src/pages/image/image-settings.ts``.

**Concurrency is real.** pydantic-ai runs the tool calls in one model response
concurrently, and "three variations" is the obvious prompt. Two renders on one box
is slower for both and, at Qwen's 58.5 GB peak, can be fatal for both.

The gateway is an httpx MockTransport, so no box (and no GPU) is needed.
"""

from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import delete

from app.agents import image_tools as tools_mod
from app.agents.image_runtime import ImageModel, ImageRuntime, profile_for
from app.agents.image_tools import make_image_tools
from app.config import get_settings
from app.db.models import LaiosConnection
from app.db.session import async_session_factory

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 16


@pytest.fixture(autouse=True)
async def _isolate(tmp_path, monkeypatch, client: AsyncClient):
    """Media off the real dir, a clean connections table, and a short cap.

    The cap matters: a poll loop with the session bug fails by *timing out*, and at
    the real 240 s that is a hung suite rather than a red test.
    """
    monkeypatch.setattr(get_settings(), "media_dir", tmp_path / "media")
    monkeypatch.setattr(tools_mod, "MAX_WAIT_SECONDS", 5)
    monkeypatch.setattr(tools_mod, "_POLL_INTERVAL_SECONDS", 0.05)
    tools_mod._locks.clear()
    yield
    tools_mod._locks.clear()
    async with async_session_factory() as session:
        await session.execute(delete(LaiosConnection))
        await session.commit()


async def _connection(name: str = "spark-head") -> str:
    async with async_session_factory() as session:
        conn = LaiosConnection(
            name=name, base_url="http://127.0.0.1:7420", master_key="sk-laios-secret"
        )
        session.add(conn)
        await session.commit()
        return conn.id


def _patch_gateway(monkeypatch, handler) -> None:
    """Point the image module's gateway client at ``handler``.

    The same seam ``test_images`` uses — the tool calls ``api/images`` directly
    rather than over HTTP, so patching that module is the whole interception.
    """
    from app.api import images as images_mod

    async def fake_base(conn):  # noqa: ANN001
        return "http://gateway.test/v1"

    async def fake_gateway(conn, timeout=None):  # noqa: ANN001
        return httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="http://gateway.test/v1",
            headers={"Authorization": f"Bearer {conn.master_key}"},
        )

    monkeypatch.setattr(images_mod, "gateway_base", fake_base)
    monkeypatch.setattr(images_mod, "_gateway", fake_gateway)


def _handler(captured: dict, *, image: bytes = PNG, delay: float = 0.0, status: int = 200):
    """A gateway that answers ``/images/generations``, optionally slowly."""

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/images/generations" and request.method == "POST":
            captured.setdefault("bodies", []).append(json.loads(request.content))
            captured["body"] = json.loads(request.content)
            captured["calls"] = captured.get("calls", 0) + 1
            if delay:
                captured["overlap"] = max(
                    captured.get("overlap", 0), captured.get("inflight", 0)
                )
                captured["inflight"] = captured.get("inflight", 0) + 1
                await asyncio.sleep(delay)
                captured["inflight"] -= 1
            if status >= 400:
                return httpx.Response(
                    status, json={"error": {"code": "boom", "message": "out of memory"}}
                )
            return httpx.Response(
                200,
                json={
                    "id": "img_1",
                    "created": 1,
                    "data": [{"b64_json": base64.b64encode(image).decode()}],
                    "inference_time_s": 6.4,
                    "peak_memory_mb": 24522.0,
                },
            )
        return httpx.Response(404, json={"error": {"code": "nope", "message": "x"}})

    return handler


def _runtime(cid: str, *models: str, connection_name: str = "spark-head") -> ImageRuntime:
    entries = tuple(
        ImageModel(cid, connection_name, name, profile_for(name)) for name in models
    )
    return ImageRuntime(models=entries, default=entries[0])


def _tool(runtime: ImageRuntime, workspace: Path, *, video_available: bool = False):
    return make_image_tools(runtime, workspace, video_available=video_available)[0]


async def _settle_all() -> None:
    """Join every background generation still in flight."""
    from app.api import images as images_mod

    tasks = list(images_mod._active.values())
    if tasks:
        await asyncio.gather(*(asyncio.shield(t) for t in tasks), return_exceptions=True)


# --- the happy path (and the session-staleness trap) --------------------------------


async def test_a_finished_image_is_delivered_in_one_call(tmp_path, monkeypatch):
    """Submit, wait, materialize, report — with no run id ever reaching the model."""
    cid = await _connection()
    captured: dict = {}
    _patch_gateway(monkeypatch, _handler(captured))
    workspace = tmp_path / "ws"
    workspace.mkdir()

    result = await _tool(_runtime(cid, "z-image-turbo"), workspace)("a red bicycle")

    assert "Generated with z-image-turbo on 'spark-head'" in result
    assert "6.4s" in result
    assert ".agents/image/gen/" in result
    assert "1024x1024 · 9 steps" in result
    assert "view_image" in result

    files = list((workspace / ".agents/image/gen").glob("*.png"))
    assert len(files) == 1
    assert files[0].read_bytes() == PNG
    assert files[0].name.startswith("a-red-bicycle-")
    # Generated blobs must not flood the git panel.
    assert (workspace / ".agents/image/.gitignore").read_text().strip().endswith("*")


async def test_the_model_default_is_used_when_steps_are_omitted(tmp_path, monkeypatch):
    """9 on a turbo checkpoint, 25 on Qwen — a shared number is wrong for one."""
    cid = await _connection()
    captured: dict = {}
    _patch_gateway(monkeypatch, _handler(captured))
    runtime = _runtime(cid, "z-image-turbo", "qwen-image-2512")

    await _tool(runtime, tmp_path)("a cat")
    assert captured["body"]["num_inference_steps"] == 9

    await _tool(runtime, tmp_path)("a cat", model="qwen-image-2512")
    assert captured["body"]["num_inference_steps"] == 25
    assert captured["body"]["model"] == "qwen-image-2512"


async def test_the_pinned_fields_are_left_to_the_backend(tmp_path, monkeypatch):
    """``response_format`` and ``n`` are pinned by ``create_image``; sending them
    from here would imply they were negotiable."""
    cid = await _connection()
    captured: dict = {}
    _patch_gateway(monkeypatch, _handler(captured))

    await _tool(_runtime(cid, "z-image-turbo"), tmp_path)("a cat", seed=88213)

    body = captured["body"]
    # The backend still applies them on the way out...
    assert body["response_format"] == "b64_json"
    assert body["n"] == 1
    assert body["seed"] == 88213
    assert body["output_format"] == "png"


async def test_an_aspect_ratio_is_accepted_in_place_of_a_size(tmp_path, monkeypatch):
    cid = await _connection()
    captured: dict = {}
    _patch_gateway(monkeypatch, _handler(captured))

    await _tool(_runtime(cid, "z-image-turbo"), tmp_path)("a vista", size="16:9")
    assert captured["body"]["size"] == "1344x768"


async def test_the_extension_follows_the_sniffed_bytes_not_the_request(
    tmp_path, monkeypatch
):
    """``output_format`` is a request the engine may ignore, so the file is named
    for what actually arrived."""
    cid = await _connection()
    captured: dict = {}
    # Asked for webp; the gateway returns JPEG bytes.
    _patch_gateway(monkeypatch, _handler(captured, image=JPEG))
    workspace = tmp_path / "ws"
    workspace.mkdir()

    await _tool(_runtime(cid, "z-image-turbo"), workspace)("a cat", output_format="webp")

    landed = list((workspace / ".agents/image/gen").iterdir())
    assert [p.suffix for p in landed] == [".jpg"]


# --- failures are text, never exceptions --------------------------------------------


async def test_a_gateway_failure_is_reported_not_raised(tmp_path, monkeypatch):
    cid = await _connection()
    captured: dict = {}
    _patch_gateway(monkeypatch, _handler(captured, status=500))

    result = await _tool(_runtime(cid, "z-image-turbo"), tmp_path)("a cat")

    assert "failed" in result.lower()
    assert "out of memory" in result


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        ({"prompt": ""}, "prompt is required"),
        ({"prompt": "x", "steps": 50}, "[4, 20]"),
        ({"prompt": "x", "steps": 1}, "[4, 20]"),
        ({"prompt": "x", "size": "1000x1000"}, "multiple of 64"),
        ({"prompt": "x", "size": "128x128"}, "outside [256, 2048]"),
        ({"prompt": "x", "size": "enormous"}, "is not a size"),
        ({"prompt": "x", "seed": -1}, "must not be negative"),
        ({"prompt": "x", "output_format": "tiff"}, "output_format"),
        ({"prompt": "x", "model": "nonesuch"}, "no image model matching"),
    ],
)
async def test_bad_arguments_are_caught_before_the_round_trip(
    tmp_path, monkeypatch, kwargs, expected
):
    """A 400 through a tunnel costs more than a local check, and the useful half of
    the message is knowable here."""
    cid = await _connection()

    def never(request: httpx.Request) -> httpx.Response:
        raise AssertionError("nothing should reach the gateway")

    _patch_gateway(monkeypatch, never)

    result = await _tool(_runtime(cid, "z-image-turbo"), tmp_path)(**kwargs)
    assert result.startswith("Error: ")
    assert expected in result


async def test_an_unknown_model_error_names_what_is_available(tmp_path, monkeypatch):
    cid = await _connection()
    _patch_gateway(monkeypatch, lambda r: httpx.Response(404))
    runtime = _runtime(cid, "z-image-turbo", "qwen-image-2512")

    result = await _tool(runtime, tmp_path)("a cat", model="dall-e")
    assert "z-image-turbo" in result and "qwen-image-2512" in result


# --- guidance encoding ----------------------------------------------------------------


async def test_guidance_off_sends_cfg_scale_one(tmp_path, monkeypatch):
    cid = await _connection()
    captured: dict = {}
    _patch_gateway(monkeypatch, _handler(captured))

    await _tool(_runtime(cid, "qwen-image-2512"), tmp_path)(
        "a poster", guidance=False, negative_prompt="blurry"
    )

    body = captured["body"]
    assert body["true_cfg_scale"] == 1
    # A negative prompt with CFG off does nothing, so it is not sent.
    assert "negative_prompt" not in body


async def test_guidance_on_sends_only_a_negative_prompt_that_exists(
    tmp_path, monkeypatch
):
    cid = await _connection()
    captured: dict = {}
    _patch_gateway(monkeypatch, _handler(captured))
    tool = _tool(_runtime(cid, "qwen-image-2512"), tmp_path)

    await tool("a poster", guidance=True, negative_prompt="blurry")
    assert captured["body"]["negative_prompt"] == "blurry"
    assert "true_cfg_scale" not in captured["body"]

    # Nothing to say means say nothing: the engine's own default applies.
    await tool("a poster", guidance=True)
    assert "negative_prompt" not in captured["body"]
    assert "true_cfg_scale" not in captured["body"]


async def test_a_distilled_model_gets_no_guidance_fields_at_all(tmp_path, monkeypatch):
    """Z-Image is CFG-distilled: sending guidance would switch on something the
    checkpoint does not want. Dropped with a note rather than raised on."""
    cid = await _connection()
    captured: dict = {}
    _patch_gateway(monkeypatch, _handler(captured))

    result = await _tool(_runtime(cid, "z-image-turbo"), tmp_path)(
        "a cat", guidance=True, negative_prompt="blurry"
    )

    assert "true_cfg_scale" not in captured["body"]
    assert "negative_prompt" not in captured["body"]
    assert "CFG-distilled" in result
    # And it still produced an image rather than costing the agent a turn.
    assert ".agents/image/gen/" in result


# --- the cap, and what survives it -----------------------------------------------------


async def test_a_slow_render_times_out_without_being_cancelled(tmp_path, monkeypatch):
    """The cap stops *waiting*, not the render — the engine has no cancel and the
    backend task is detached. Saying otherwise would be a lie the agent acts on."""
    cid = await _connection()
    captured: dict = {}
    monkeypatch.setattr(tools_mod, "MAX_WAIT_SECONDS", 1)
    _patch_gateway(monkeypatch, _handler(captured, delay=2.5))

    result = await _tool(_runtime(cid, "qwen-image-2512"), tmp_path)("a slow poster")

    assert "did NOT stop" in result
    assert "qwen-image-2512" in result
    assert "generate_image again" in result

    # The generation really does complete afterwards.
    await _settle_all()
    from app.api import images as images_mod

    async with async_session_factory() as session:
        rows = await images_mod.list_images(cid, session)
    assert [r["status"] for r in rows] == ["completed"]


async def test_a_timed_out_image_is_handed_over_on_the_next_call(tmp_path, monkeypatch):
    """With no run id there would otherwise be no way back to it — an image the
    agent paid for and can never reach."""
    cid = await _connection()
    captured: dict = {}
    monkeypatch.setattr(tools_mod, "MAX_WAIT_SECONDS", 1)
    _patch_gateway(monkeypatch, _handler(captured, delay=2.0))
    workspace = tmp_path / "ws"
    workspace.mkdir()
    tool = _tool(_runtime(cid, "z-image-turbo"), workspace)

    first = await tool("the slow one")
    assert "did NOT stop" in first

    await _settle_all()
    # Now fast, so the second call both delivers the first image and makes its own.
    captured2: dict = {}
    _patch_gateway(monkeypatch, _handler(captured2))
    second = await tool("the quick one")

    assert "has landed" in second
    landed = sorted(p.name for p in (workspace / ".agents/image/gen").iterdir())
    assert any(n.startswith("the-slow-one-") for n in landed)
    assert any(n.startswith("the-quick-one-") for n in landed)


# --- concurrency -------------------------------------------------------------------------


async def test_two_calls_to_one_box_do_not_overlap(tmp_path, monkeypatch):
    """A model asked for variations emits several calls in one response, and
    pydantic-ai runs them concurrently. Two renders on one GPU is slower for both
    and, at Qwen's measured peak, can be fatal for both."""
    cid = await _connection()
    captured: dict = {}
    _patch_gateway(monkeypatch, _handler(captured, delay=0.2))
    tool = _tool(_runtime(cid, "z-image-turbo"), tmp_path)

    results = await asyncio.gather(tool("first"), tool("second"))

    assert captured["calls"] == 2
    # The handler records the high-water mark of simultaneous in-flight requests.
    assert captured.get("overlap", 0) == 0
    assert all("Generated with" in r for r in results)


async def test_queue_time_is_not_charged_to_the_wait_budget(tmp_path, monkeypatch):
    """Otherwise the third of three parallel calls fails for no reason of its own."""
    cid = await _connection()
    captured: dict = {}
    monkeypatch.setattr(tools_mod, "MAX_WAIT_SECONDS", 3)
    _patch_gateway(monkeypatch, _handler(captured, delay=1.0))
    tool = _tool(_runtime(cid, "z-image-turbo"), tmp_path)

    results = await asyncio.gather(tool("a"), tool("b"), tool("c"))

    # Three 1s renders serialised is 3s of wall clock — past the cap if the queue
    # time were charged against it, but each render only ever waited 1s.
    assert all("Generated with" in r for r in results), results
    assert any("behind another generation" in r for r in results)


# --- the docstring the model actually reads ------------------------------------------------


def test_the_docstring_lists_what_is_serving(tmp_path):
    runtime = _runtime("c", "z-image-turbo", "qwen-image-2512")
    doc = _tool(runtime, tmp_path).__doc__ or ""
    assert "z-image-turbo (default)" in doc
    assert "qwen-image-2512" in doc
    assert "best open-weight text rendering" in doc
    # The Args section must stay last, or the docstring parser reads the menu as
    # part of the final argument's description.
    assert doc.index("Models available here") < doc.index("Args:")


def test_video_advice_only_appears_when_video_is_available(tmp_path):
    runtime = _runtime("c", "z-image-turbo")
    assert "generate_video" not in (_tool(runtime, tmp_path).__doc__ or "")
    with_video = _tool(runtime, tmp_path, video_available=True).__doc__ or ""
    assert "generate_video" in with_video
    # The keyframe body limit makes a 1024px PNG the wrong default for that use.
    assert 'output_format="jpeg"' in with_video


# --- the directive that makes the tool actually get used -------------------------------


async def _instructions(tmp_path, **kwargs) -> str:
    """The system instructions a built agent actually runs with."""
    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.models.function import AgentInfo, FunctionModel
    from pydantic_ai.profiles import ModelProfile

    from app.agents.builder import build_deep_agent
    from app.db.models import Agent as AgentRow

    seen: list[str] = []

    def respond(messages, _info: AgentInfo):
        seen.extend(
            m.instructions for m in messages if getattr(m, "instructions", None)
        )
        return ModelResponse(parts=[TextPart("ok")])

    row = AgentRow(name="a", instructions="You are a software engineering agent.")
    agent, deps = build_deep_agent(row, str(tmp_path), **kwargs)
    with agent.override(
        model=FunctionModel(respond, profile=ModelProfile(supports_tools=True))
    ):
        await agent.run("hi", deps=deps)
    return "\n".join(seen)


async def test_the_image_directive_is_injected_when_a_box_is_resolved(tmp_path):
    """Having the tool is not enough — a model asked for an image will reach for
    ``curl`` against a public API unless told not to. Observed in the wild, with
    ``generate_image`` sitting in the roster next to ``execute``."""
    text = await _instructions(tmp_path, image_runtime=_runtime("c", "z-image-turbo"))

    assert "generate_image" in text
    assert "NEVER fetch a generated image from an external service" in text
    # The wrong path has to be named: "use X" is weak against a habit, "never Y"
    # is what competes with it. Naming the service that actually happened matters.
    assert "curl" in text and "Pollinations" in text
    # Drawing the thing in code is the other escape hatch, and it is closed too —
    # but only for pictures, or charts-from-data would be caught by it.
    assert "canvas" in text and "chart" in text


async def test_no_image_directive_without_a_resolved_box(tmp_path):
    """Telling an agent to use a tool it does not have is the failure mode this
    whole directive exists to prevent, so it must not fire on the flag alone."""
    assert "generate_image" not in await _instructions(tmp_path)
