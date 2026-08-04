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
import os
import re
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


def unique_plan_doc_path(workspace_path: str | Path, title: str) -> str:
    """A fallback plan-doc path that isn't already holding someone else's plan.

    :func:`plan_doc_path` derives its name from the thread title, so two threads
    in one workspace can land on the same name. Used where we are about to *write*
    the fallback doc ourselves (the salvage in ``api/chat.py``), so a title clash
    can't overwrite an earlier thread's plan: ``PLAN-<slug>-2.md`` and so on.
    """
    base = plan_doc_path(title)
    if not plan_doc_has_content(workspace_path, base):
        return base
    stem = base.removesuffix(".md")
    counter = 2
    while plan_doc_has_content(workspace_path, f"{stem}-{counter}.md"):
        counter += 1
    return f"{stem}-{counter}.md"


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


# Directories that are never worth walking when hunting for a plan doc the agent
# saved outside ``PLAN_DIR`` — dependency/build trees dwarf the workspace and
# hold no plan. ``os.walk`` doesn't follow symlinked directories, so the
# symlinked skill folders under ``.agents/skills`` are skipped for free.
_PLAN_SEARCH_SKIP_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
        ".next",
        ".nuxt",
        ".turbo",
        "dist",
        "build",
        "target",
        "vendor",
    }
)
# How deep below the workspace root to look. A plan doc the model chose to file
# itself lands somewhere shallow (``docs/``, ``plans/``, the root); deeper than
# this and the walk costs more than the salvage is worth.
_PLAN_SEARCH_MAX_DEPTH = 4


def detect_plan_doc_anywhere(
    workspace_path: str | Path, since: float, *, max_depth: int = _PLAN_SEARCH_MAX_DEPTH
) -> str | None:
    """Find a non-empty ``PLAN*.md`` written since ``since``, anywhere shallow.

    The safety net for a model that ignored the "write it to ``PLAN_DIR``"
    instruction and filed its plan somewhere else — a repo's own ``docs/`` folder
    is the usual culprit, and :func:`detect_written_plan` (which only watches
    ``PLAN_DIR``) sees nothing. Without this the thread parks pointing at a doc
    that was never written and "Execute plan" fails with a 409.

    Prefers a doc inside ``PLAN_DIR``, then the most recently modified. Returns a
    workspace-relative POSIX path, or ``None`` when nothing matches.
    """
    root = Path(workspace_path)
    found: list[tuple[bool, float, str]] = []
    for dirpath, dirnames, filenames in os.walk(root, onerror=lambda _exc: None):
        here = Path(dirpath)
        depth = len(here.relative_to(root).parts)
        dirnames[:] = (
            []
            if depth >= max_depth
            else [d for d in dirnames if d not in _PLAN_SEARCH_SKIP_DIRS]
        )
        for name in filenames:
            if not name.upper().startswith("PLAN") or not name.endswith(".md"):
                continue
            with contextlib.suppress(OSError):
                stat = (here / name).stat()
                if stat.st_mtime < since or stat.st_size == 0:
                    continue
                rel = (here / name).relative_to(root).as_posix()
                found.append((not rel.startswith(f"{PLAN_DIR}/"), -stat.st_mtime, rel))
    if not found:
        return None
    found.sort()
    return found[0][2]


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
        "of concrete steps plus any key decisions or assumptions, and ALWAYS "
        "include a `## Success Criteria` section spelling out, as a checklist, "
        "what must be true for the plan to count as fully implemented — this is "
        "what the agent will be judged against when the plan is later executed.\n"
        "Write the plan for **unattended execution**: once the user presses "
        "\"Execute plan\" it runs to completion with no human in the loop. So do "
        "not include steps like \"get user approval\", \"confirm before "
        "proceeding\" or \"check in with the user\" — that approval is the button, "
        "and a step waiting on a human can never be completed. Where a step has a "
        "real choice to make, decide it in the plan (record it under a decisions "
        "or assumptions heading) so execution has nothing to ask about. "
        "In your chat reply, briefly summarise the plan and invite the user to "
        "request changes — you'll refine it together until they're happy with it.\n"
        "Do NOT start doing the work yet: this is a planning conversation. Beyond "
        f"reading/searching the codebase and writing your plan file in `{PLAN_DIR}/`"
        ", make no changes. Nothing runs while you're planning; the user refines "
        "the plan by sending more messages, and presses \"Execute plan\" when "
        "they're ready for you to carry it out."
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
        "the requested changes, and save the updated plan. Keep the "
        "`## Success Criteria` section accurate as the plan changes, and keep the "
        "plan executable unattended — no \"get user approval\" or \"confirm "
        "first\" steps, since execution runs with no human in the loop and cannot "
        "complete a step that waits on one. In your chat reply, briefly say what "
        "you changed and invite further edits.\n"
        "Do NOT start doing the work yet: this is still the planning conversation. "
        "The user keeps refining by sending more messages; nothing runs until they "
        "press \"Execute plan\"."
    )


# Heading that marks the plan's success-criteria section. When a parked plan is
# executed (``turn == "execute_plan"``), this section becomes the goal loop's
# completion condition — see :func:`extract_success_criteria`.
SUCCESS_CRITERIA_HEADING = "success criteria"


def extract_success_criteria(doc_text: str) -> str:
    """Return the body of the plan's ``## Success Criteria`` section, or ``""``.

    Matches a Markdown heading (any level) whose text is "Success Criteria"
    (case-insensitive) and returns everything up to the next heading of the same
    or higher level. Callers fall back to the whole doc when this returns empty
    (the section is optional in older/hand-written plans).
    """
    lines = doc_text.splitlines()
    start: int | None = None
    start_level = 0
    for i, line in enumerate(lines):
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m and m.group(2).strip().lower() == SUCCESS_CRITERIA_HEADING:
            start = i + 1
            start_level = len(m.group(1))
            break
    if start is None:
        return ""
    body: list[str] = []
    for line in lines[start:]:
        m = re.match(r"^(#{1,6})\s+", line)
        if m and len(m.group(1)) <= start_level:
            break
        body.append(line)
    return "\n".join(body).strip()


def read_plan_doc(workspace_path: str | Path, plan_path: str) -> str:
    """Read a workspace-relative plan doc's text, or ``""`` if it's unreadable."""
    if not plan_path:
        return ""
    with contextlib.suppress(OSError, UnicodeDecodeError):
        return (Path(workspace_path) / plan_path).read_text(encoding="utf-8")
    return ""


def plan_doc_has_content(workspace_path: str | Path, plan_path: str) -> bool:
    """True when ``plan_path`` names a plan doc that exists and isn't blank.

    What "Execute plan" needs to be true: the goal loop's completion condition
    comes out of this file, so a missing or empty doc has nothing to execute.
    Checked *before* parking a plan for review so the failure surfaces on the
    plan turn rather than as a 409 when the user presses the button.
    """
    return bool(read_plan_doc(workspace_path, plan_path).strip())


def write_plan_doc(
    workspace_path: str | Path, plan_path: str, title: str, body: str
) -> bool:
    """Save ``body`` as the plan doc at ``plan_path``; ``True`` when it lands.

    The salvage path for a planning turn that produced a plan in *prose* but never
    wrote the file (local reasoning models do this — see the tool-filter note in
    ``agents/builder.py``). Persisting the reply the user just read keeps the
    review-and-execute flow working instead of parking a pointer to nothing. An
    H1 is prepended when the body has none so :func:`extract_plan_title` still
    yields a readable objective.
    """
    text = body.strip()
    if not text:
        return False
    target = Path(workspace_path) / plan_path
    heading = "" if text.startswith("# ") else f"# {title.strip() or 'Plan'}\n\n"
    with contextlib.suppress(OSError):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"{heading}{text}\n", encoding="utf-8")
        return True
    return False


def extract_plan_title(doc_text: str) -> str:
    """Return the plan's first Markdown H1 (``# Title``) text, or ``""``.

    Used as the human-readable objective for the goal header when a plan is
    executed, so it reads as e.g. "Stripe checkout" rather than the file path.
    """
    for line in doc_text.splitlines():
        m = re.match(r"^#\s+(.*\S)\s*$", line)
        if m:
            return m.group(1).strip()
    return ""


# Run-scoped instruction for every turn of an autonomous run (``/goal``,
# "Execute plan", a fired schedule). The loop drives itself: nothing between turns
# reads the agent's reply, and a message the user does send arrives as a mid-run
# interjection, never as an answer the agent is waiting on. Models nonetheless
# park mid-run to ask permission before something long or expensive — and, worse,
# write that checkpoint into the todo board ("Get user approval before the final
# render"), which reads as legitimate remaining work to every later turn. Both
# behaviours burn turns on a question nobody will answer, so the run has to say
# plainly that it is unattended and that approval already happened.
UNATTENDED_RUN_INSTRUCTION = (
    "## Unattended run — never stop to ask\n"
    "You are running autonomously until the goal is met. No human is reading "
    "your replies mid-run, so a question is not a checkpoint — it is a wasted "
    "turn. Approval for this work was given when the goal (or plan) was accepted, "
    "and it covers every step needed to reach it, including steps that are slow, "
    "expensive, or hard to undo within this workspace.\n"
    "- Never ask for approval, confirmation, a decision, or a preference, and "
    "never end a turn waiting for a reply.\n"
    "- When something is genuinely ambiguous, choose the most reasonable option, "
    "state in one line which you chose and why, and continue. Flag it in your "
    "final summary if the user should revisit it.\n"
    "- Never write a todo whose completion depends on a human (\"get approval\", "
    "\"confirm with the user\", \"wait for sign-off\"). Todos are your own work "
    "items; a run cannot complete one that waits on somebody else.\n"
    "- Only genuinely destructive actions outside the workspace (force-pushing a "
    "shared branch, deleting remote data, spending real money outside the "
    "agreed task) are out of scope. Skip those, do everything else, and note "
    "what you skipped at the end.\n"
    "Stop only when the goal is met, or when you have hit a blocker you cannot "
    "work around — and then say what the blocker is rather than asking a question."
)


# Seeds the first turn of the autonomous goal loop (``/goal`` — no plan step).
AUTONOMOUS_KICKOFF = (
    "Work toward the goal now. Break it into steps with the write_todos tool, "
    "then carry them out, surfacing concrete evidence (command output, exit "
    "codes, test results, file state) as you go so completion can be verified. "
    "Run unattended: do not stop to ask for approval or confirmation — decide, "
    "act, and keep going until the goal is met."
)


def plan_execute_kickoff(plan_path: str, plan_body: str = "") -> str:
    """Seed for executing an approved plan doc: implement it in full.

    When ``plan_body`` is given the plan is reproduced inline, so the model has
    the objective, steps and Success Criteria in context from turn one instead of
    having to reconstruct them from a single ``read_file`` — it may still re-read
    ``plan_path`` for the latest version. Falls back to a read-the-file
    instruction when the body is unavailable.
    """
    if plan_body.strip():
        lead = (
            f"Re-read `{plan_path}` if you need the latest version, but the "
            "approved plan is reproduced in full below — implement all of it."
        )
        inlined = f"\n\n--- PLAN ({plan_path}) ---\n{plan_body.strip()}\n--- END PLAN ---\n"
    else:
        lead = f"Read the plan at `{plan_path}` now."
        inlined = ""
    return (
        f"The user has approved the plan at `{plan_path}` and wants it fully "
        f"implemented. {lead} Break it into steps with the write_todos tool and "
        "carry them out, surfacing concrete evidence (command output, exit codes, "
        "test results, file state) as you go so completion can be verified against "
        "the plan's Success Criteria.\n"
        "Pressing \"Execute plan\" *was* the approval, and it covers the whole "
        "plan — including any step that is slow, expensive or marked as needing a "
        "check. Nobody will answer a question from here: if the plan itself "
        "contains an approval or confirmation checkpoint, treat it as already "
        "satisfied and carry straight on. Run it end to end without stopping to "
        f"ask.{inlined}"
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


@dataclass
class TurnResult:
    """What one execution turn produced, as handed back to :func:`drive_goal_loop`.

    ``messages`` is the history to carry into the next turn. On a turn that
    aborted mid-run this must be the work-so-far snapshot, never the pre-turn
    history — returning the latter silently rewinds the loop's context, so the
    agent redoes the turn, aborts the same way, and grinds to the iteration cap
    having kept nothing.

    ``error`` is why the turn's agent run aborted (``""`` on a clean finish).
    ``rounds_exhausted`` narrows that to the benign case: the turn simply used up
    its per-turn model-round budget. The work is real and the history intact, so
    the loop treats it as an ordinary turn boundary rather than a failure.

    ``text`` is the assistant text the turn persisted (the transcript the user
    saw). A plan turn uses it to salvage a plan doc the model described but never
    wrote — see :func:`write_plan_doc`.
    """

    messages: list[ModelMessage]
    error: str = ""
    rounds_exhausted: bool = False
    text: str = ""


def build_goal_evaluator(
    model_str: str,
    custom_providers: dict[str, CustomProvider] | None = None,
) -> GoalEvaluator:
    """A completion evaluator whose model is resolved through Lursor's stack.

    The engine's default is an ``anthropic:`` model needing a key Lursor may not
    have; ``resolve_model`` maps ``openrouter:`` / ``custom:`` strings to values
    that work here.
    """
    # ``GoalEvaluator.evaluate`` awaits a one-shot ``.run()`` internally, so the
    # evaluator's client needs the total-request budget, not the streaming
    # stall timeout (see builder._model_http_timeout).
    return GoalEvaluator(
        model=resolve_model(model_str, custom_providers or {}, streaming=False)
    )


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

# Sibling breaker for the *agent* side. A transient model/tool blip shouldn't end
# a 25-turn run, so a failed turn is retried against the partial history it left
# behind; but an unrecoverable failure (bad credentials, missing model) should
# surface in seconds rather than burn every remaining turn on the same error.
_MAX_CONSECUTIVE_TURN_ERRORS = 3


def turn_failed_reason(error: str) -> str:
    """Terminal reason when the agent turn itself keeps failing."""
    return (
        "The agent run failed repeatedly and could not make progress. "
        f"Last error: {error}"
    )


def rounds_exhausted_directive(condition: str, reason: str) -> str:
    """Continue directive for a turn that was cut off at its round budget.

    The plain continue directive would leave the agent guessing why it stopped
    mid-thought; saying so plainly (and that its work survived) is what keeps the
    next turn from restarting the same approach and hitting the same wall.
    """
    return (
        f"{goal_continue_directive(condition, reason)}\n\n"
        "Note: your previous turn was cut off after using up its budget of "
        "model/tool rounds. It did not fail, and everything you did is still in "
        "context — pick up exactly where you left off. Prefer fewer, larger steps "
        "(batch related edits, run one broad command instead of many narrow ones) "
        "so you can finish within this turn's budget."
    )


# Phrases that mark a turn as having handed control back to the user. Matched
# against the *tail* of the reply only (see :func:`looks_like_awaiting_user`) —
# an agent that mentions approval mid-turn and then keeps working has not stopped,
# and it is the closing paragraph that says whether it did.
_AWAITING_USER_PHRASES = (
    "do you approve",
    "do you want me to",
    "would you like me to",
    "should i proceed",
    "shall i proceed",
    "may i proceed",
    "let me know",
    "please confirm",
    "your approval",
    "awaiting approval",
    "awaiting your",
    "waiting for your",
    "waiting on your",
    "go-ahead",
    "go ahead and confirm",
    "confirm and i",
    "confirm before i",
    "say the word",
)

# How much of the reply's end to inspect. Long enough to cover a closing
# paragraph, short enough that a question asked early in a turn the agent then
# answered itself doesn't count.
_AWAITING_USER_TAIL_CHARS = 400


def looks_like_awaiting_user(text: str) -> bool:
    """True when a turn's reply ends by handing control back to the user.

    The behavioural failure this catches: mid-run, a model asks permission before
    something slow or expensive ("Do you approve starting the three final
    renders?") and stops. In an unattended run nobody answers, so the plain
    continue directive spends the next turn re-asking the same question. Detecting
    it lets the loop answer instead (see :func:`awaiting_user_directive`).

    Deliberately loose: a false positive only adds a "nobody is going to answer,
    decide and continue" note to a directive that already says keep working.
    """
    tail = text.strip()[-_AWAITING_USER_TAIL_CHARS:].lower()
    if not tail:
        return False
    if tail.endswith("?") or tail.endswith("?**") or tail.endswith('?"'):
        return True
    return any(phrase in tail for phrase in _AWAITING_USER_PHRASES)


def awaiting_user_directive(condition: str, reason: str) -> str:
    """Continue directive for a turn that stopped to ask the user something.

    Grants the approval explicitly rather than repeating "keep working" — the
    model stopped *because* it believed a human gate existed, so the next turn
    only moves if that belief is corrected.
    """
    return (
        f"{goal_continue_directive(condition, reason)}\n\n"
        "Note: your previous turn ended by asking the user something. This run is "
        "unattended — nobody is going to answer, and the approval you are waiting "
        "for was already given when this goal was started; it covers every step "
        "needed to reach it, including slow or expensive ones. Do not ask again. "
        "Choose the most sensible option, state in one line which you chose, and "
        "carry it out now. If a todo item is itself a request for approval, mark "
        "it done and move on — a human checkpoint is not work this run can "
        "complete."
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
    run_turn: Callable[[int, str | None], Awaitable[TurnResult]],
    evaluate: Callable[[str, list[ModelMessage]], Awaitable[GoalEvaluation]],
    on_evaluation: Callable[[GoalState, GoalEvaluation], Awaitable[None]] | None = None,
    on_turn_error: Callable[[GoalState, str], Awaitable[None]] | None = None,
    initial_seed: str | None = None,
    evaluator_retry_backoff: tuple[float, ...] = _EVALUATOR_RETRY_BACKOFF,
    max_consecutive_turn_errors: int = _MAX_CONSECUTIVE_TURN_ERRORS,
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
        run_turn: ``(turn_number, seed) -> TurnResult``. ``seed`` is
            ``initial_seed`` for the first turn, then the evaluator-informed
            continue directive.
        evaluate: ``(condition, messages) -> GoalEvaluation``.
        on_evaluation: Optional hook after each evaluation (persist/emit status).
        on_turn_error: Optional hook when an agent turn aborts and will be
            retried (surface/log the error).
        initial_seed: Seed prompt for the first execution turn.
        evaluator_retry_backoff: Per-retry sleeps for a failing evaluator before
            the circuit breaker trips. Tests pass zeros to avoid real sleeps.
        max_consecutive_turn_errors: Failed agent turns in a row before the loop
            gives up on the run.
    """
    state = GoalState(condition=condition, max_turns=max_turns)
    state.started_monotonic = time.monotonic()
    seed = initial_seed
    consecutive_turn_errors = 0
    while True:
        turn = await run_turn(state.turns + 1, seed)
        if turn.error and not turn.rounds_exhausted:
            # The agent run aborted outright. Don't spend an evaluation on it —
            # the evaluator would judge a half-turn and report "not met", hiding
            # the real cause. Retry the same seed against whatever history the
            # turn did produce, and give up if the failure keeps repeating.
            consecutive_turn_errors += 1
            if consecutive_turn_errors >= max_consecutive_turn_errors:
                return GoalOutcome(
                    ThreadStatus.blocked, state.turns, turn_failed_reason(turn.error)
                )
            if on_turn_error is not None:
                await on_turn_error(state, turn.error)
            continue
        consecutive_turn_errors = 0
        evaluation, errored = await _evaluate_resiliently(
            evaluate, condition, turn.messages, evaluator_retry_backoff
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
        if turn.rounds_exhausted:
            seed = rounds_exhausted_directive(condition, evaluation.reason)
        elif looks_like_awaiting_user(turn.text):
            # The turn parked on a question. Answer it in the directive, or the
            # next turn just asks it again (and the one after that).
            seed = awaiting_user_directive(condition, evaluation.reason)
        else:
            seed = goal_continue_directive(condition, evaluation.reason)
