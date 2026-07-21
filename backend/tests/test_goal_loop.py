"""Unit tests for the goal-loop control flow (``agents.goal_loop.drive_goal_loop``).

These exercise termination and turn-counting with fakes only — no model, no
AG-UI, no GPU — so they run offline like the rest of the smoke suite. The real
streaming/persistence plumbing lives in ``api/chat.py`` closures the loop calls.
"""

from __future__ import annotations

from pydantic_deep import GoalEvaluation

from app.agents.goal_loop import (
    EVALUATOR_ERROR_REASON,
    EVALUATOR_UNAVAILABLE_REASON,
    _enqueue_interjections,
    drain_interjections,
    drive_goal_loop,
    extract_success_criteria,
    queue_interjection,
)
from app.db.models import ThreadStatus


def test_extract_success_criteria_pulls_the_section_body():
    """The `## Success Criteria` section body is returned, up to the next heading."""
    doc = (
        "# Plan\n\n"
        "1. Step one.\n"
        "2. Step two.\n\n"
        "## Success Criteria\n\n"
        "- Tests pass.\n"
        "- Lint is clean.\n\n"
        "## Notes\n\n"
        "Ignore this trailing section.\n"
    )
    out = extract_success_criteria(doc)
    assert "- Tests pass." in out
    assert "- Lint is clean." in out
    assert "Ignore this trailing section." not in out
    assert "Step one" not in out


def test_extract_success_criteria_is_case_insensitive_and_optional():
    """Heading match ignores case; a doc without the section returns ``""``."""
    assert "done" in extract_success_criteria("### success criteria\n\ndone\n")
    assert extract_success_criteria("# Plan\n\nNo criteria here.\n") == ""


def _scripted_evaluator(evaluations: list[GoalEvaluation]):
    """An ``evaluate`` callable that returns each canned verdict in turn."""
    calls = {"n": 0}

    async def evaluate(condition: str, messages: list) -> GoalEvaluation:
        i = calls["n"]
        calls["n"] += 1
        return evaluations[min(i, len(evaluations) - 1)]

    return evaluate


async def test_completes_when_evaluator_confirms():
    seeds: list[str | None] = []

    async def run_turn(turn_no: int, seed: str | None) -> list:
        seeds.append(seed)
        return [f"turn-{turn_no}"]

    outcome = await drive_goal_loop(
        condition="ship it",
        max_turns=10,
        run_turn=run_turn,
        evaluate=_scripted_evaluator(
            [
                GoalEvaluation(met=False, reason="not yet"),
                GoalEvaluation(met=True, reason="done"),
            ]
        ),
        initial_seed="kick off",
    )

    assert outcome.status == ThreadStatus.completed
    assert outcome.turns == 2
    assert outcome.last_reason == "done"
    # First turn uses the initial seed; the second is driven by the continue
    # directive built from the evaluator's reason.
    assert seeds[0] == "kick off"
    assert "not yet" in seeds[1]


async def test_blocked_when_evaluator_says_impossible():
    async def run_turn(turn_no: int, seed: str | None) -> list:
        return []

    outcome = await drive_goal_loop(
        condition="divide by zero safely and unsafely at once",
        max_turns=10,
        run_turn=run_turn,
        evaluate=_scripted_evaluator(
            [GoalEvaluation(met=False, reason="contradictory", impossible=True)]
        ),
    )

    assert outcome.status == ThreadStatus.blocked
    assert outcome.turns == 1


async def test_fails_when_iteration_cap_is_hit():
    turns = {"n": 0}

    async def run_turn(turn_no: int, seed: str | None) -> list:
        turns["n"] += 1
        return []

    outcome = await drive_goal_loop(
        condition="never satisfied",
        max_turns=3,
        run_turn=run_turn,
        evaluate=_scripted_evaluator([GoalEvaluation(met=False, reason="keep going")]),
    )

    assert outcome.status == ThreadStatus.failed
    assert outcome.turns == 3
    assert turns["n"] == 3  # ran exactly max_turns turns, no more


async def test_on_evaluation_hook_sees_each_turn():
    observed: list[tuple[int, bool]] = []

    async def run_turn(turn_no: int, seed: str | None) -> list:
        return []

    async def on_evaluation(state, evaluation) -> None:
        observed.append((state.turns, evaluation.met))

    await drive_goal_loop(
        condition="c",
        max_turns=10,
        run_turn=run_turn,
        evaluate=_scripted_evaluator(
            [
                GoalEvaluation(met=False, reason="1"),
                GoalEvaluation(met=False, reason="2"),
                GoalEvaluation(met=True, reason="3"),
            ]
        ),
        on_evaluation=on_evaluation,
    )

    assert observed == [(1, False), (2, False), (3, True)]


# --- evaluator circuit breaker ------------------------------------------------


async def test_breaker_trips_when_evaluator_persistently_errors():
    """A persistently failing evaluator stops the loop fast, not at the turn cap."""
    turns = {"n": 0}

    async def run_turn(turn_no: int, seed: str | None) -> list:
        turns["n"] += 1
        return []

    outcome = await drive_goal_loop(
        condition="verify something",
        max_turns=25,
        run_turn=run_turn,
        # The vendored evaluator surfaces every model-call failure as this reason.
        evaluate=_scripted_evaluator(
            [GoalEvaluation(met=False, reason=EVALUATOR_ERROR_REASON)]
        ),
        evaluator_retry_backoff=(0.0, 0.0),  # no real sleeps in tests
    )

    assert outcome.status == ThreadStatus.blocked
    assert outcome.last_reason == EVALUATOR_UNAVAILABLE_REASON
    # Bailed after a single agent turn — retries are eval-only, not full turns —
    # instead of grinding through all 25.
    assert turns["n"] == 1


async def test_transient_evaluator_error_recovers_and_continues():
    """One eval error followed by a real verdict retries in-turn, no breaker trip."""

    async def run_turn(turn_no: int, seed: str | None) -> list:
        return []

    outcome = await drive_goal_loop(
        condition="ship it",
        max_turns=10,
        run_turn=run_turn,
        # First evaluation errors, the in-turn retry succeeds with a real verdict.
        evaluate=_scripted_evaluator(
            [
                GoalEvaluation(met=False, reason=EVALUATOR_ERROR_REASON),
                GoalEvaluation(met=True, reason="done"),
            ]
        ),
        evaluator_retry_backoff=(0.0, 0.0),
    )

    assert outcome.status == ThreadStatus.completed
    assert outcome.turns == 1
    assert outcome.last_reason == "done"


# --- mid-run interjection -----------------------------------------------------


def test_queue_and_drain_interjections_fifo_and_clears():
    tid = "thread-interject-store"
    queue_interjection(tid, "first")
    queue_interjection(tid, "   ")  # blank is ignored
    queue_interjection(tid, "second")
    assert drain_interjections(tid) == ["first", "second"]
    # Draining clears the buffer.
    assert drain_interjections(tid) == []


class _FakeRunContext:
    """Records ``enqueue`` calls the way pydantic-ai's RunContext would receive them."""

    def __init__(self) -> None:
        self.enqueued: list[tuple[tuple, str]] = []

    def enqueue(self, *content, priority: str = "asap") -> None:
        self.enqueued.append((content, priority))


async def test_enqueue_interjections_injects_asap_and_drains():
    """Buffered interjections are enqueued into the live run and the buffer cleared.

    This is what the steer capability's ``before_model_request`` hook does each
    model request — the fine-grained boundary that makes steering land promptly
    instead of waiting for a whole agent run to finish.
    """
    tid = "thread-interject-enqueue"
    drain_interjections(tid)  # start clean
    queue_interjection(tid, "focus on the tests")
    queue_interjection(tid, "skip the docs")

    ctx = _FakeRunContext()
    await _enqueue_interjections(ctx, tid)

    assert ctx.enqueued == [
        (("focus on the tests",), "asap"),
        (("skip the docs",), "asap"),
    ]
    # Drained — a second pass injects nothing (no double-injection).
    ctx2 = _FakeRunContext()
    await _enqueue_interjections(ctx2, tid)
    assert ctx2.enqueued == []
