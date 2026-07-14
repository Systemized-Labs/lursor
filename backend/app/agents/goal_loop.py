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

import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from ag_ui.core import CustomEvent, EventType, RunAgentInput, UserMessage
from pydantic_ai import Agent as PydanticAgent
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.ui.ag_ui import AGUIAdapter
from pydantic_deep import (
    GoalEvaluation,
    GoalEvaluator,
    GoalState,
    goal_continue_directive,
)

from app.agents.builder import resolve_model
from app.db.models import CustomProvider, GoalStatus

# AG-UI CUSTOM event carrying goal lifecycle to the UI (status pill, iteration
# counter, evaluator reason). Sibling of the "todos" event in ``api/chat.py``.
GOAL_STATUS_EVENT_NAME = "goal_status"

# The plan lives as a Markdown doc at the workspace root so the user can read it
# in the file panel and the agent can revise it across planning turns. Namespaced
# to avoid clobbering a repo's own PLAN.md.
PLAN_DOC = "GOAL_PLAN.md"

# Run-scoped instructions for a planning turn. The plan is an on-disk artifact
# (the user reviews it in the file panel and can ask for revisions), not just
# chat prose — so we direct the agent to write it to ``PLAN_DOC``.
PLANNING_INSTRUCTION = (
    "## Goal planning — do NOT execute yet\n"
    f"You are planning how to accomplish a goal. Write a clear, step-by-step "
    f"implementation plan as Markdown to the file `{PLAN_DOC}` at the root of "
    "your workspace (create it, or overwrite/revise it if it already exists, "
    "using your file tools). Structure it as an ordered checklist of concrete "
    "steps plus any key decisions or assumptions. In your chat reply, briefly "
    "summarise the plan and invite the user to request changes.\n"
    "Do NOT start doing the work yet: the user reviews the plan and may ask you "
    f"to revise it before approving. If the user requests changes, update "
    f"`{PLAN_DOC}` and summarise what changed."
)

# Seeds the first execution turn once the plan is approved.
EXECUTION_KICKOFF = (
    f"Your plan in `{PLAN_DOC}` is approved. Execute it now, working through the "
    "steps one at a time. Use the write_todos tool to track progress against the "
    "plan. Surface concrete evidence (command output, exit codes, test results, "
    "file state) as you go so completion can be verified."
)

# Seeds the first turn in fully-autonomous mode (approval off — no plan doc yet).
AUTONOMOUS_KICKOFF = (
    "Work toward the goal now. Break it into steps with the write_todos tool, "
    "then carry them out, surfacing concrete evidence (command output, exit "
    "codes, test results, file state) as you go so completion can be verified."
)


def messages_to_history(rows) -> list[ModelMessage]:
    """Convert persisted thread messages into pydantic-ai history.

    The execution run starts fresh (planning turns have finished and their live
    message history is gone), so it seeds context from the persisted transcript.
    Only user/assistant text is stored, which is enough — the detailed plan lives
    in ``PLAN_DOC`` on disk, which the execution agent reads.
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

    status: GoalStatus
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
    status: GoalStatus,
    *,
    condition: str,
    iteration: int,
    max_iterations: int,
    reason: str = "",
) -> str:
    """SSE-framed AG-UI CUSTOM event announcing the goal's current state."""
    event = CustomEvent(
        type=EventType.CUSTOM,
        name=GOAL_STATUS_EVENT_NAME,
        value={
            "status": status.value,
            "condition": condition,
            "iteration": iteration,
            "maxIterations": max_iterations,
            "reason": reason,
        },
    )
    return f"data: {event.model_dump_json(by_alias=True, exclude_none=True)}\n\n"


async def drive_goal_loop(
    *,
    condition: str,
    max_turns: int,
    run_turn: Callable[[int, str | None], Awaitable[list[ModelMessage]]],
    evaluate: Callable[[str, list[ModelMessage]], Awaitable[GoalEvaluation]],
    on_evaluation: Callable[[GoalState, GoalEvaluation], Awaitable[None]] | None = None,
    initial_seed: str | None = None,
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
    """
    state = GoalState(condition=condition, max_turns=max_turns)
    state.started_monotonic = time.monotonic()
    seed = initial_seed
    while True:
        messages = await run_turn(state.turns + 1, seed)
        evaluation = await evaluate(condition, messages)
        state.record(evaluation)
        if on_evaluation is not None:
            await on_evaluation(state, evaluation)
        if state.achieved:
            return GoalOutcome(GoalStatus.completed, state.turns, evaluation.reason)
        if evaluation.impossible:
            return GoalOutcome(GoalStatus.blocked, state.turns, evaluation.reason)
        if state.exhausted:
            return GoalOutcome(GoalStatus.failed, state.turns, evaluation.reason)
        seed = goal_continue_directive(condition, evaluation.reason)
