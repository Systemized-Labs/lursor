"""Goal mode — the self-continuing loop that drives a thread toward an objective.

A chat thread runs one agent turn per user message. A *goal* thread keeps
running turns on its own: it drafts a plan, (optionally) waits for the user to
approve it, then works — turn after turn — re-engaging the agent until an
independent evaluator judges the completion condition met, judges it impossible,
or a hard iteration cap trips.

The heavy lifting is the vendored :mod:`pydantic_deep.goal` engine
(``GoalState`` + ``GoalEvaluator`` + ``goal_continue_directive``), modelled on
Claude Code's ``/goal``. This module wires that engine into Lursor's AG-UI run
loop: :func:`drive_goal_loop` is the provider-agnostic orchestration (unit
tested against fakes); the rest are the adapters that let the caller in
``api/chat.py`` stream turns and resolve the evaluator model against Lursor's
provider stack.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

from ag_ui.core import CustomEvent, EventType, RunAgentInput, UserMessage
from pydantic_ai import Agent as PydanticAgent
from pydantic_ai.capabilities import Hooks
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.tools import RunContext
from pydantic_ai.ui.ag_ui import AGUIAdapter
from pydantic_deep import (
    GoalEvaluation,
    GoalEvaluator,
    GoalState,
    goal_continue_directive,
)

from app.agents.builder import resolve_model
from app.db.models import CustomProvider, ThreadStatus
from app.workspace_paths import slugify

# AG-UI CUSTOM event carrying plan/goal run lifecycle to the UI (status pill,
# iteration counter, evaluator reason). Sibling of the "todos" event in
# ``api/chat.py``. The wire name stays ``goal_status`` for stream compatibility.
GOAL_STATUS_EVENT_NAME = "goal_status"

# Plans live under this workspace-relative folder (created on demand) rather than
# a single top-level ``PLAN.md``, so each plan thread keeps its own named doc and
# past plans aren't clobbered. Mirrors the existing ``.agents/skills`` convention.
PLAN_DIR = ".agents/plan"

# Legacy single-file location. Plan threads created before per-thread naming may
# still point here; kept so old threads keep opening the right file.
LEGACY_PLAN_DOC = "PLAN.md"


def plan_doc_path(title: str) -> str:
    """Fallback workspace-relative plan-doc path, derived from the thread title.

    Used only when the agent didn't leave a detectable plan file (see
    :func:`detect_written_plan`) — normally the agent names its own doc. Names it
    ``.agents/plan/PLAN-<slug>.md`` where ``<slug>`` slugifies the plan idea (the
    thread title). Falls back to ``PLAN-plan.md`` when the title has no usable
    characters.
    """
    slug = slugify(title)
    if slug == "workspace":  # slugify's fallback for empty/symbol-only input
        slug = "plan"
    return f"{PLAN_DIR}/PLAN-{slug}.md"


def scan_plan_dir(workspace_path: str | Path) -> dict[str, float]:
    """Map ``PLAN_DIR``'s Markdown files to their mtimes (empty if it's absent).

    Used to snapshot the plan folder around a planning turn so we can tell which
    doc the agent wrote (see :func:`detect_written_plan`).
    """
    root = Path(workspace_path) / PLAN_DIR
    if not root.is_dir():
        return {}
    out: dict[str, float] = {}
    for entry in root.iterdir():
        if entry.is_file() and entry.suffix == ".md":
            with contextlib.suppress(OSError):
                out[entry.name] = entry.stat().st_mtime
    return out


def detect_written_plan(
    workspace_path: str | Path, before: dict[str, float]
) -> str | None:
    """Return the plan doc the agent just wrote, or ``None`` if it wrote nothing.

    Compares the current ``PLAN_DIR`` contents against a pre-turn snapshot
    (``before``). A file is "written" if it's new or its mtime advanced. Prefers a
    ``PLAN-``-prefixed name (what we ask the agent to use); ties broken by most
    recent mtime. Returns a workspace-relative POSIX path.
    """
    after = scan_plan_dir(workspace_path)
    changed = [
        name
        for name, mtime in after.items()
        if name not in before or mtime > before[name]
    ]
    if not changed:
        return None
    changed.sort(key=lambda name: (not name.startswith("PLAN-"), -after[name]))
    return f"{PLAN_DIR}/{changed[0]}"


# Run-scoped instructions for a plan-mode turn. The plan is an on-disk artifact
# (the user reviews it in the file panel and can ask for revisions), not just
# chat prose — so we direct the agent to write it, choosing its own descriptive
# filename. We detect which file it wrote afterwards (see ``detect_written_plan``).
def planning_instruction() -> str:
    """From-scratch plan-mode instruction; the agent names its own plan doc."""
    return (
        "## Plan mode — propose, do NOT execute yet\n"
        "You are in plan mode. Research what's needed, then write a clear, "
        "step-by-step implementation plan as Markdown to a new file in the "
        f"`{PLAN_DIR}/` folder of your workspace, using your file tools. Name the "
        "file `PLAN-<slug>.md`, where `<slug>` is a short, descriptive summary of "
        "what this plan is about — a few words, lowercase, hyphen-separated, using "
        "only letters, numbers and hyphens (e.g. `PLAN-stripe-checkout.md` or "
        "`PLAN-dark-mode-toggle.md`). Structure the plan as an ordered checklist "
        "of concrete steps plus any key decisions or assumptions. In your chat "
        "reply, briefly summarise the plan and invite the user to request changes "
        "— you'll refine it together until they're happy with it.\n"
        "Do NOT start doing the work yet: this is a planning conversation. Beyond "
        f"reading/searching the codebase and writing your plan file in `{PLAN_DIR}/`"
        ", make no changes. When the user is ready to execute, they leave plan mode "
        "and ask you to carry the plan out — nothing runs while you're still planning."
    )


# Run-scoped instructions for a follow-up plan-mode turn: the user is giving
# feedback on the plan already written to ``plan_doc``. Framed as revising an
# existing draft (read it first, apply the changes) rather than writing anew.
def refine_instruction(plan_doc: str) -> str:
    """Refinement plan-mode instruction targeting the existing ``plan_doc``."""
    return (
        "## Plan mode — refining the plan with the user\n"
        f"The user is giving feedback on the plan you already wrote to "
        f"`{plan_doc}`. Read the current `{plan_doc}` with your file tools, apply "
        "the requested changes, and save the updated plan. In your chat reply, "
        "briefly say what you changed and invite further edits.\n"
        "Do NOT start doing the work yet: this is still the planning conversation. "
        "The user may keep refining; nothing runs until they leave plan mode and "
        "ask you to execute."
    )

# Seeds the first turn of the autonomous goal loop (``/goal`` — no plan step).
AUTONOMOUS_KICKOFF = (
    "Work toward the goal now. Break it into steps with the write_todos tool, "
    "then carry them out, surfacing concrete evidence (command output, exit "
    "codes, test results, file state) as you go so completion can be verified."
)

# Mid-run steering: messages the user sends while the autonomous loop is running.
#
# Buffered per thread, then injected into the live agent run via the steer
# capability below. Consuming them at the model-request boundary (not just
# between whole agent runs) is what makes steering feel responsive — it matches
# how Claude Code / Cursor / Kiro apply a queued message at the next tool/step,
# rather than waiting for the current agent run to finish (which may never happen
# if the goal completes first).
#
# In-process module state, mirroring how a run's transient state lives on the
# (single) server process — a restart drops any un-drained interjections. The
# HTTP handler only ever `list.append`s here; the drain runs on the agent's own
# event loop between graph nodes, so the two don't race (see pydantic-ai's
# `RunContext.enqueue` docs).
_goal_interjections: dict[str, list[str]] = {}


def queue_interjection(thread_id: str, text: str) -> None:
    """Buffer a user message to steer the thread's running goal loop."""
    text = text.strip()
    if not text:
        return
    _goal_interjections.setdefault(thread_id, []).append(text)


def drain_interjections(thread_id: str) -> list[str]:
    """Take and clear the buffered interjections for a thread."""
    return _goal_interjections.pop(thread_id, [])


async def _enqueue_interjections(ctx: RunContext, thread_id: str) -> None:
    """Fold any buffered interjections for `thread_id` into the live run.

    ``ctx.enqueue(..., priority='asap')`` delivers each message at the next model
    request — or, if the agent was about to finish, as a redirect — so a steer
    always lands even near the end of a run.
    """
    for text in drain_interjections(thread_id):
        ctx.enqueue(text, priority="asap")


def build_steer_capability(thread_id: str) -> Hooks:
    """A per-run capability that injects queued user interjections mid-run.

    Fires before each model request (a drain boundary for ``enqueue``), so
    messages the user sends while the loop is executing reach the model at the
    next step instead of waiting for the whole agent run to end.
    """

    async def before_model_request(ctx: RunContext, request_context):
        await _enqueue_interjections(ctx, thread_id)
        return request_context

    return Hooks(before_model_request=before_model_request)


def messages_to_history(rows) -> list[ModelMessage]:
    """Convert persisted thread messages into pydantic-ai history.

    The execution run starts fresh (planning turns have finished and their live
    message history is gone), so it seeds context from the persisted transcript.
    Only user/assistant text is stored, which is enough — the detailed plan lives
    in the thread's plan doc on disk, which the execution agent reads.
    """
    history: list[ModelMessage] = []
    for m in rows:
        content = getattr(m, "content", "") or ""
        if not content:
            continue
        if m.role == "user":
            history.append(ModelRequest(parts=[UserPromptPart(content=content)]))
        elif m.role == "assistant":
            history.append(ModelResponse(parts=[TextPart(content=content)]))
    return history


@dataclass
class GoalOutcome:
    """Terminal result of a goal loop, folded back onto the thread row."""

    status: ThreadStatus
    turns: int
    last_reason: str


def build_goal_evaluator(
    model_str: str,
    custom_providers: dict[str, CustomProvider] | None = None,
) -> GoalEvaluator:
    """A completion evaluator whose model is resolved through Lursor's stack.

    The engine's default is an ``anthropic:`` model needing a key Lursor may not
    have; ``resolve_model`` maps ``openrouter:`` / ``custom:`` strings to values
    that work here.
    """
    return GoalEvaluator(model=resolve_model(model_str, custom_providers or {}))


def build_continuation_adapter(
    agent: PydanticAgent,
    directive: str,
    thread_id: str,
    accept: str | None,
) -> AGUIAdapter:
    """An AG-UI adapter whose only frontend message is ``directive``.

    Continuation turns can't reuse the request adapter: ``run_stream`` always
    appends the request's messages to ``message_history``, which would re-inject
    the original goal every turn. This builds a throwaway adapter carrying just
    the synthetic directive, so ``run_stream(message_history=<so far>)`` yields
    ``[...history, directive]`` — a clean next user turn.
    """
    run_input = RunAgentInput(
        thread_id=thread_id,
        run_id=uuid.uuid4().hex,
        state=None,
        messages=[UserMessage(id=uuid.uuid4().hex, role="user", content=directive)],
        tools=[],
        context=[],
        forwarded_props=None,
    )
    return AGUIAdapter(agent=agent, run_input=run_input, accept=accept)


def encode_goal_status_event(
    status: ThreadStatus,
    *,
    condition: str,
    iteration: int,
    max_iterations: int,
    reason: str = "",
    plan_path: str = "",
) -> str:
    """SSE-framed AG-UI CUSTOM event announcing the goal's current state.

    ``plan_path`` (for plan-mode runs) carries the workspace-relative doc the turn
    wrote to, so the UI can open the right file when the thread parks for review.
    """
    event = CustomEvent(
        type=EventType.CUSTOM,
        name=GOAL_STATUS_EVENT_NAME,
        value={
            "status": status.value,
            "condition": condition,
            "iteration": iteration,
            "maxIterations": max_iterations,
            "reason": reason,
            "planPath": plan_path,
        },
    )
    return f"data: {event.model_dump_json(by_alias=True, exclude_none=True)}\n\n"


# The vendored evaluator (``pydantic_deep.goal.GoalEvaluator.evaluate``) never
# raises — when its model call fails it swallows the exception and returns this
# exact reason instead of a real verdict. It is therefore our only signal that an
# evaluation was an *infrastructure* failure rather than a genuine "not met", so
# the circuit breaker in ``drive_goal_loop`` keys off it. Single point of coupling
# to the dependency: if pydantic_deep changes the string, update it here.
EVALUATOR_ERROR_REASON = "Evaluator error; continuing."

# Backoff (seconds) between in-turn evaluator retries. Short and few: a transient
# blip clears fast, while a persistent misconfig should surface quickly rather
# than stall a run. The tuple length also bounds the retry count.
_EVALUATOR_RETRY_BACKOFF: tuple[float, ...] = (1.0, 2.0, 4.0)

# Terminal reason when the circuit breaker trips — the evaluator can't judge
# completion, so continuing would only feed the agent non-actionable prompts.
EVALUATOR_UNAVAILABLE_REASON = (
    "Goal evaluator unavailable — completion could not be verified after repeated "
    "attempts. Check the evaluator model and its provider credentials "
    "(goal_evaluator_model, or the thread agent's model)."
)


async def _evaluate_resiliently(
    evaluate: Callable[[str, list[ModelMessage]], Awaitable[GoalEvaluation]],
    condition: str,
    messages: list[ModelMessage],
    backoff: tuple[float, ...],
) -> tuple[GoalEvaluation, bool]:
    """Evaluate with in-turn retries, distinguishing infra errors from verdicts.

    The vendored evaluator returns :data:`EVALUATOR_ERROR_REASON` (never raises)
    when its model call fails. We retry that — with backoff, without running
    another expensive agent turn in between — so a transient hiccup doesn't waste
    a turn or trip the breaker. The returned bool is ``True`` only when *every*
    attempt came back as an evaluator error, i.e. the evaluator is (probably
    persistently) unavailable and the loop should stop.
    """
    evaluation = await evaluate(condition, messages)
    for delay in backoff:
        if evaluation.reason != EVALUATOR_ERROR_REASON:
            break
        await asyncio.sleep(delay)
        evaluation = await evaluate(condition, messages)
    return evaluation, evaluation.reason == EVALUATOR_ERROR_REASON


async def drive_goal_loop(
    *,
    condition: str,
    max_turns: int,
    run_turn: Callable[[int, str | None], Awaitable[list[ModelMessage]]],
    evaluate: Callable[[str, list[ModelMessage]], Awaitable[GoalEvaluation]],
    on_evaluation: Callable[[GoalState, GoalEvaluation], Awaitable[None]] | None = None,
    initial_seed: str | None = None,
    evaluator_retry_backoff: tuple[float, ...] = _EVALUATOR_RETRY_BACKOFF,
) -> GoalOutcome:
    """Run execution turns until the goal is met, judged impossible, or capped.

    Provider-agnostic on purpose: ``run_turn`` executes one agent turn (given
    the turn number and a seed prompt) and returns the full message history so
    far; ``evaluate`` judges the condition against that history. Everything about
    streaming, persistence, and the AG-UI wire lives in the caller's closures, so
    this function is pure control flow and unit-testable against fakes.

    Args:
        condition: The completion condition the evaluator judges against.
        max_turns: Hard cap on execution turns (``GoalState.max_turns``).
        run_turn: ``(turn_number, seed) -> messages``. ``seed`` is
            ``initial_seed`` for the first turn, then the evaluator-informed
            continue directive.
        evaluate: ``(condition, messages) -> GoalEvaluation``.
        on_evaluation: Optional hook after each evaluation (persist/emit status).
        initial_seed: Seed prompt for the first execution turn.
        evaluator_retry_backoff: Per-retry sleeps for a failing evaluator before
            the circuit breaker trips. Tests pass zeros to avoid real sleeps.
    """
    state = GoalState(condition=condition, max_turns=max_turns)
    state.started_monotonic = time.monotonic()
    seed = initial_seed
    while True:
        messages = await run_turn(state.turns + 1, seed)
        evaluation, errored = await _evaluate_resiliently(
            evaluate, condition, messages, evaluator_retry_backoff
        )
        if errored:
            # Circuit breaker: a persistently failing evaluator can't judge
            # completion. Stop and surface why, rather than grinding to the turn
            # cap feeding the agent non-actionable "keep going" directives (which
            # the model rationalises as "no remaining blockers").
            return GoalOutcome(
                ThreadStatus.blocked, state.turns, EVALUATOR_UNAVAILABLE_REASON
            )
        state.record(evaluation)
        if on_evaluation is not None:
            await on_evaluation(state, evaluation)
        if state.achieved:
            return GoalOutcome(ThreadStatus.completed, state.turns, evaluation.reason)
        if evaluation.impossible:
            return GoalOutcome(ThreadStatus.blocked, state.turns, evaluation.reason)
        if state.exhausted:
            return GoalOutcome(ThreadStatus.failed, state.turns, evaluation.reason)
        seed = goal_continue_directive(condition, evaluation.reason)
