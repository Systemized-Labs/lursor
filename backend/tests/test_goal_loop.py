"""Unit tests for the goal-loop control flow (``agents.goal_loop.drive_goal_loop``).

These exercise termination and turn-counting with fakes only — no model, no
AG-UI, no GPU — so they run offline like the rest of the smoke suite. The real
streaming/persistence plumbing lives in ``api/chat.py`` closures the loop calls.
"""

from __future__ import annotations

import os
import time

from pydantic_deep import GoalEvaluation

from app.agents.goal_loop import (
    AUTONOMOUS_KICKOFF,
    EVALUATOR_ERROR_REASON,
    EVALUATOR_UNAVAILABLE_REASON,
    PLAN_DIR,
    UNATTENDED_RUN_INSTRUCTION,
    TurnResult,
    _enqueue_interjections,
    detect_plan_doc_anywhere,
    drain_interjections,
    drive_goal_loop,
    extract_success_criteria,
    looks_like_awaiting_user,
    plan_doc_has_content,
    plan_execute_kickoff,
    planning_instruction,
    queue_interjection,
    refine_instruction,
    scheduled_goal_kickoff,
    turn_failed_reason,
    unique_plan_doc_path,
    write_plan_doc,
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


def test_plan_doc_has_content_rejects_missing_and_blank_docs(tmp_path):
    """The precondition "Execute plan" needs: the doc exists and isn't blank."""
    assert not plan_doc_has_content(tmp_path, "")
    assert not plan_doc_has_content(tmp_path, ".agents/plan/PLAN-nope.md")
    blank = tmp_path / PLAN_DIR / "PLAN-blank.md"
    blank.parent.mkdir(parents=True)
    blank.write_text("   \n\n", encoding="utf-8")
    assert not plan_doc_has_content(tmp_path, f"{PLAN_DIR}/PLAN-blank.md")
    (tmp_path / PLAN_DIR / "PLAN-real.md").write_text("# Plan\n", encoding="utf-8")
    assert plan_doc_has_content(tmp_path, f"{PLAN_DIR}/PLAN-real.md")


def test_detect_plan_doc_anywhere_finds_a_doc_filed_outside_the_plan_folder(tmp_path):
    """A model that ignores ``PLAN_DIR`` and writes to ``docs/`` is still detected —
    otherwise the thread parks on a doc that was never written."""
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "PLAN-crm.md").write_text("# CRM\n\n## Success Criteria\n\n- ok\n")
    assert detect_plan_doc_anywhere(tmp_path, 0) == "docs/PLAN-crm.md"

    # A doc inside PLAN_DIR wins over one filed elsewhere.
    inside = tmp_path / PLAN_DIR / "PLAN-crm.md"
    inside.parent.mkdir(parents=True)
    inside.write_text("# CRM\n", encoding="utf-8")
    assert detect_plan_doc_anywhere(tmp_path, 0) == f"{PLAN_DIR}/PLAN-crm.md"


def test_detect_plan_doc_anywhere_ignores_stale_empty_and_buried_files(tmp_path):
    """Only a non-empty ``PLAN*.md`` touched since ``since``, in a directory worth
    walking, counts — so an older thread's plan is never picked up by mistake."""
    old = tmp_path / "PLAN-old.md"
    old.write_text("# Old plan\n", encoding="utf-8")
    os.utime(old, (1_000_000, 1_000_000))
    (tmp_path / "PLAN-empty.md").write_text("", encoding="utf-8")
    (tmp_path / "NOTES.md").write_text("# Not a plan\n", encoding="utf-8")
    buried = tmp_path / "node_modules" / "pkg"
    buried.mkdir(parents=True)
    (buried / "PLAN-vendored.md").write_text("# Vendored\n", encoding="utf-8")
    assert detect_plan_doc_anywhere(tmp_path, time.time() - 60) is None


def test_write_plan_doc_salvages_prose_and_keeps_a_title(tmp_path):
    """The salvage path: a plan the model only described becomes a real doc, with an
    H1 so the goal header reads as a title rather than a path."""
    assert write_plan_doc(tmp_path, f"{PLAN_DIR}/PLAN-x.md", "CRM Build", "1. Step one.")
    text = (tmp_path / PLAN_DIR / "PLAN-x.md").read_text(encoding="utf-8")
    assert text.startswith("# CRM Build\n")
    assert "1. Step one." in text
    # An existing H1 in the reply is kept as-is, and an empty reply writes nothing.
    assert write_plan_doc(tmp_path, f"{PLAN_DIR}/PLAN-y.md", "T", "# Mine\n\nbody")
    assert (tmp_path / PLAN_DIR / "PLAN-y.md").read_text().startswith("# Mine\n")
    assert not write_plan_doc(tmp_path, f"{PLAN_DIR}/PLAN-z.md", "T", "   \n")
    assert not (tmp_path / PLAN_DIR / "PLAN-z.md").exists()


def test_unique_plan_doc_path_never_clobbers_another_threads_plan(tmp_path):
    """Two threads with the same title share a fallback name, and the fallback is a
    path we *write*, so the second one has to step aside."""
    assert unique_plan_doc_path(tmp_path, "Build a CRM") == f"{PLAN_DIR}/PLAN-build-a-crm.md"
    taken = tmp_path / PLAN_DIR / "PLAN-build-a-crm.md"
    taken.parent.mkdir(parents=True)
    taken.write_text("# Someone else's plan\n", encoding="utf-8")
    assert unique_plan_doc_path(tmp_path, "Build a CRM") == f"{PLAN_DIR}/PLAN-build-a-crm-2.md"


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

    async def run_turn(turn_no: int, seed: str | None) -> TurnResult:
        seeds.append(seed)
        return TurnResult(messages=[f"turn-{turn_no}"])

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
    async def run_turn(turn_no: int, seed: str | None) -> TurnResult:
        return TurnResult(messages=[])

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

    async def run_turn(turn_no: int, seed: str | None) -> TurnResult:
        turns["n"] += 1
        return TurnResult(messages=[])

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

    async def run_turn(turn_no: int, seed: str | None) -> TurnResult:
        return TurnResult(messages=[])

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

    async def run_turn(turn_no: int, seed: str | None) -> TurnResult:
        turns["n"] += 1
        return TurnResult(messages=[])

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

    async def run_turn(turn_no: int, seed: str | None) -> TurnResult:
        return TurnResult(messages=[])

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


# --- turns that stop to ask the user ------------------------------------------


def test_looks_like_awaiting_user_spots_a_parked_turn():
    """A reply that ends on a question or a hand-off is awaiting the user."""
    assert looks_like_awaiting_user(
        "Storyboard is ready and the three shots are queued.\n\n"
        "**Do you approve starting the three 50-step final renders (~105 min total)?**"
    )
    assert looks_like_awaiting_user("I can go either way here — let me know.")
    assert looks_like_awaiting_user("Waiting for your go-ahead before I render.")


def test_looks_like_awaiting_user_ignores_work_that_carried_on():
    """Mentioning approval mid-turn isn't stopping; only the closing lines count."""
    assert not looks_like_awaiting_user(
        "Do you approve? I'll assume yes since this run is unattended.\n\n"
        + "Rendered shot 1 (50 steps, exit 0). Rendered shot 2 (50 steps, exit 0). "
        "Rendered shot 3 (50 steps, exit 0). Assembled local-ai-will-win.mp4 — "
        "ffprobe reports 42s, 1920x1080, h264. All three renders are on disk and "
        "the crossfades line up with the storyboard timings, so the plan's "
        "Success Criteria are met and nothing is left outstanding here."
    )
    assert not looks_like_awaiting_user("")
    assert not looks_like_awaiting_user("Tests pass: 41 passed, 0 failed.")


async def test_turn_that_asks_for_approval_is_told_to_proceed():
    """The loop answers the question instead of letting the next turn re-ask it.

    Without this the agent parks on "do you approve...?" every turn — nobody is
    reading the transcript mid-run, so the generic continue directive just gets the
    same question back.
    """
    seeds: list[str | None] = []

    async def run_turn(turn_no: int, seed: str | None) -> TurnResult:
        seeds.append(seed)
        return TurnResult(
            messages=[f"turn-{turn_no}"],
            text="Do you approve starting the three 50-step final renders?",
        )

    outcome = await drive_goal_loop(
        condition="the final mp4 exists",
        max_turns=2,
        run_turn=run_turn,
        evaluate=_scripted_evaluator(
            [
                GoalEvaluation(met=False, reason="no mp4 yet"),
                GoalEvaluation(met=True, reason="mp4 on disk"),
            ]
        ),
        initial_seed="kick off",
    )

    assert outcome.status == ThreadStatus.completed
    # The continue directive grants the approval and forbids asking again, rather
    # than repeating a bare "keep working".
    assert "nobody is going to answer" in seeds[1]
    assert "Do not ask again" in seeds[1]
    assert "no mp4 yet" in seeds[1]


async def test_ordinary_turn_keeps_the_plain_continue_directive():
    """A turn that didn't park gets the normal directive — no spurious grant."""
    seeds: list[str | None] = []

    async def run_turn(turn_no: int, seed: str | None) -> TurnResult:
        seeds.append(seed)
        return TurnResult(messages=[f"turn-{turn_no}"], text="Wrote the renderer.")

    await drive_goal_loop(
        condition="the final mp4 exists",
        max_turns=2,
        run_turn=run_turn,
        evaluate=_scripted_evaluator([GoalEvaluation(met=False, reason="keep going")]),
        initial_seed="kick off",
    )

    assert "keep going" in seeds[1]
    assert "nobody is going to answer" not in seeds[1]


def test_unattended_instruction_bans_human_gated_todos():
    """The run-scoped instruction closes both holes: asking, and todo checkpoints."""
    text = UNATTENDED_RUN_INSTRUCTION.lower()
    assert "never ask for approval" in text
    assert "get approval" in text  # the todo the model used to write
    assert "unattended" in text


def test_plan_instructions_forbid_approval_checkpoints():
    """A plan is authored for unattended execution, so no human-gate steps."""
    for text in (planning_instruction(), refine_instruction(f"{PLAN_DIR}/PLAN-x.md")):
        assert "get user approval" in text.lower()
    assert "unattended" in planning_instruction().lower()
    assert "already satisfied" in plan_execute_kickoff(f"{PLAN_DIR}/PLAN-x.md", "# X\n")


def test_scheduled_kickoff_states_the_objective_and_disowns_earlier_fires():
    """A fired goal schedule has no transcript, so the seed carries the objective.

    Without it turn one has no goal in context at all and reconstructs one from
    recalled memory and the previous fire's files — a "research a recent event"
    schedule resumes last night's video instead.
    """
    seed = scheduled_goal_kickoff("Research a recent news event\nMake a 6s skit")
    assert "Research a recent news event" in seed
    assert "Make a 6s skit" in seed
    lowered = seed.lower()
    assert "do not resume" in lowered
    assert "long-term memory" in lowered
    # Still an unattended run: the kickoff's own directives survive.
    assert AUTONOMOUS_KICKOFF in seed


def test_scheduled_kickoff_of_a_blank_prompt_is_the_plain_seed():
    """Nothing to state, so no framing that pretends there is."""
    assert scheduled_goal_kickoff("   ") == AUTONOMOUS_KICKOFF


# --- aborted agent turns ------------------------------------------------------


async def test_spent_round_budget_is_an_ordinary_turn_boundary():
    """A turn that used up its model-round budget is not a failure.

    Its work is real and its history intact, so the loop evaluates it like any
    other turn — and tells the next turn it was cut off rather than leaving the
    agent to guess why it stopped mid-thought.
    """
    seeds: list[str | None] = []
    judged: list[list] = []

    async def run_turn(turn_no: int, seed: str | None) -> TurnResult:
        seeds.append(seed)
        return TurnResult(
            messages=[f"work-{turn_no}"],
            error="The next request would exceed the request_limit of 150",
            rounds_exhausted=True,
        )

    async def evaluate(condition: str, messages: list) -> GoalEvaluation:
        judged.append(messages)
        return GoalEvaluation(met=len(judged) == 2, reason="progressing")

    outcome = await drive_goal_loop(
        condition="ship it",
        max_turns=10,
        run_turn=run_turn,
        evaluate=evaluate,
        initial_seed="kick off",
    )

    assert outcome.status == ThreadStatus.completed
    assert outcome.turns == 2
    # Every turn was evaluated against the work it produced — not skipped, and
    # not judged against a rewound history.
    assert judged == [["work-1"], ["work-2"]]
    # The follow-up seed explains the cut-off and that the work survived.
    assert "cut off" in seeds[1]
    assert "still in context" in seeds[1]


async def test_failed_turn_retries_then_trips_the_breaker():
    """A turn that aborts is retried, and a persistent failure ends the run fast."""
    attempts = {"n": 0}
    evaluations = {"n": 0}
    reported: list[str] = []

    async def run_turn(turn_no: int, seed: str | None) -> TurnResult:
        attempts["n"] += 1
        return TurnResult(messages=["partial work"], error="model provider is down")

    async def evaluate(condition: str, messages: list) -> GoalEvaluation:
        evaluations["n"] += 1
        return GoalEvaluation(met=False, reason="not yet")

    async def on_turn_error(state, error: str) -> None:
        reported.append(error)

    outcome = await drive_goal_loop(
        condition="ship it",
        max_turns=25,
        run_turn=run_turn,
        evaluate=evaluate,
        on_turn_error=on_turn_error,
        max_consecutive_turn_errors=3,
    )

    assert outcome.status == ThreadStatus.blocked
    assert outcome.last_reason == turn_failed_reason("model provider is down")
    # Bailed after three attempts instead of grinding through all 25 turns...
    assert attempts["n"] == 3
    # ...and never asked the evaluator to judge a turn that never really ran.
    assert evaluations["n"] == 0
    # The caller heard about each retried failure (the goal run strips per-turn
    # RUN_ERROR events, so this hook is the only way it surfaces).
    assert reported == ["model provider is down"] * 2


async def test_transient_turn_failure_recovers_without_losing_the_run():
    """One failed turn followed by a good one keeps going; the breaker resets."""
    turns = {"n": 0}

    async def run_turn(turn_no: int, seed: str | None) -> TurnResult:
        turns["n"] += 1
        if turns["n"] == 1:
            return TurnResult(messages=["partial"], error="transient blip")
        return TurnResult(messages=["real work"])

    outcome = await drive_goal_loop(
        condition="ship it",
        max_turns=10,
        run_turn=run_turn,
        evaluate=_scripted_evaluator([GoalEvaluation(met=True, reason="done")]),
    )

    assert outcome.status == ThreadStatus.completed
    assert outcome.last_reason == "done"
    # The failed attempt didn't consume an iteration — only the turn that ran.
    assert outcome.turns == 1


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
