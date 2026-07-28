"""Per-agent context-compaction overrides.

Covers the three places the two knobs land: the split ``/compact`` uses on the
stored transcript, the live capability pydantic-deep compacts with mid-run, and
the API that stores/clears the overrides.
"""

from __future__ import annotations

from httpx import AsyncClient

from app.agents.compaction import split_for_compaction
from app.agents.context_budget import (
    keep_for_ratio,
    resolve_compaction_ratio,
    resolve_compaction_threshold,
)
from app.config import get_settings
from app.db.models import Agent, Message, Subagent
from app.db.session import async_session_factory

settings = get_settings()


def _messages(count: int, *, chars: int = 400) -> list[Message]:
    """``count`` same-sized transcript rows, so the split lands predictably."""
    return [
        Message(thread_id="t", role="user" if i % 2 == 0 else "assistant", content="x" * chars)
        for i in range(count)
    ]


# --- The transcript split (``/compact``) --------------------------------------


def test_full_ratio_compacts_the_whole_transcript():
    """The default (1.0) is what /compact has always done: summarize everything."""
    rows = _messages(6)
    to_summarize, kept = split_for_compaction(rows, 1.0)
    assert to_summarize == rows
    assert kept == []


def test_partial_ratio_keeps_the_newest_turns_verbatim():
    """A ratio below 1 leaves a tail behind the summary, split on message bounds."""
    rows = _messages(6)
    to_summarize, kept = split_for_compaction(rows, 0.5)
    assert len(to_summarize) == 3
    assert len(kept) == 3
    # The tail is the *newest* messages, in order, and nothing is double-counted.
    assert kept == rows[3:]
    assert to_summarize == rows[:3]


def test_partial_ratio_still_condenses_at_least_two_messages():
    """A tail budget big enough to swallow the history doesn't make it a no-op."""
    rows = _messages(3)
    to_summarize, kept = split_for_compaction(rows, 0.1)
    assert len(to_summarize) == 2
    assert kept == rows[2:]


def test_too_little_history_returns_no_work():
    """One message already is the compact form — the caller reports that."""
    rows = _messages(1)
    to_summarize, kept = split_for_compaction(rows, 0.5)
    assert to_summarize == []
    assert kept == rows


# --- Resolution + the live capability ----------------------------------------


def test_unset_overrides_resolve_to_the_app_defaults():
    row = Agent(name="Plain")
    assert resolve_compaction_threshold(row) == settings.default_compaction_threshold
    assert resolve_compaction_ratio(row) == settings.default_compaction_ratio


def test_out_of_range_values_fall_back_instead_of_breaking_a_run():
    """A bad stored value must not reach the capability, which raises on it."""
    row = Agent(name="Bad", compaction_threshold=0, compaction_ratio=4.2)
    assert resolve_compaction_threshold(row) == settings.default_compaction_threshold
    assert resolve_compaction_ratio(row) == settings.default_compaction_ratio


def test_keep_is_the_complement_of_the_ratio():
    # "Summarize everything" is spelled the library's way, not as a 0.0 fraction.
    assert keep_for_ratio(1.0) == ("messages", 0)
    assert keep_for_ratio(0.7) == ("fraction", 0.3)


def test_overrides_retune_the_built_agents_context_manager(tmp_path):
    """The row's knobs reach the capability *and* its summarization processor."""
    from app.agents.builder import build_deep_agent

    row = Agent(name="Tuned", compaction_threshold=0.55, compaction_ratio=0.7)
    agent, _deps = build_deep_agent(row, tmp_path)
    capability = agent._context_middleware
    assert capability.compress_threshold == 0.55
    assert capability.keep == ("fraction", 0.3)
    # The processor is built from those fields in __post_init__, so it is the thing
    # that actually decides when to compress — it must have been rebuilt too.
    processor = capability._summarization_processor
    assert processor._trigger_conditions == [("fraction", 0.55)]
    assert processor.keep == ("fraction", 0.3)


def test_an_untouched_agent_runs_on_the_app_defaults(tmp_path):
    """An agent with no override of its own still gets *our* default, not the
    library's.

    The app compacts earlier than pydantic-deep does (0.7 vs its hard-coded 0.9),
    so this also guards the wiring: if the retune ever stopped reaching the
    capability, the threshold here would silently revert to the library value.
    """
    from app.agents.builder import build_deep_agent

    agent, _deps = build_deep_agent(Agent(name="Default"), tmp_path)
    capability = agent._context_middleware
    assert capability.compress_threshold == settings.default_compaction_threshold
    # The ratio default is still "summarize everything", spelled the library's way.
    assert capability.keep == ("messages", 0)


def test_a_subagent_compacts_on_its_own_budget(tmp_path):
    """Subagents come through the same builder, so their overrides apply too."""
    from app.agents.builder import build_deep_agent

    row = Subagent(name="Reader", compaction_threshold=0.4, compaction_ratio=0.8)
    agent, _deps = build_deep_agent(row, tmp_path)
    assert agent._context_middleware.compress_threshold == 0.4
    assert agent._context_middleware.keep == ("fraction", 0.2)


# --- API ----------------------------------------------------------------------


async def test_compaction_defaults_are_readable(client: AsyncClient):
    """With nothing saved, the effective defaults are the environment's own."""
    r = await client.get("/settings/compaction")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["threshold"] == settings.default_compaction_threshold
    assert body["ratio"] == settings.default_compaction_ratio
    assert body["threshold_source"] == "env"
    assert body["ratio_source"] == "env"
    assert body["env_threshold"] == settings.default_compaction_threshold
    assert body["env_ratio"] == settings.default_compaction_ratio


async def test_saved_defaults_take_effect_and_can_be_cleared(client: AsyncClient):
    """Saving retunes the running process; clearing restores the env baseline.

    The save path mutates the cached ``Settings`` (that is what makes it effective
    without a restart), so this ends by clearing both knobs — which is also the
    reset path under test.
    """
    env_threshold = settings.default_compaction_threshold
    env_ratio = settings.default_compaction_ratio

    saved = (
        await client.put("/settings/compaction", json={"threshold": 0.5, "ratio": 0.8})
    ).json()
    assert saved["threshold"] == 0.5
    assert saved["ratio"] == 0.8
    assert saved["threshold_source"] == "database"
    assert saved["ratio_source"] == "database"
    # What a reset would restore is still reported as the environment's value.
    assert saved["env_threshold"] == env_threshold
    # Effective immediately: the resolver an agent build goes through sees it.
    assert resolve_compaction_threshold(Agent(name="Follower")) == 0.5
    assert resolve_compaction_ratio(Agent(name="Follower")) == 0.8

    # Partial save: a body carrying only one knob leaves the other alone.
    partial = (await client.put("/settings/compaction", json={"threshold": 0.6})).json()
    assert partial["threshold"] == 0.6
    assert partial["ratio"] == 0.8

    # An agent's own override still wins over the app-wide value.
    assert resolve_compaction_threshold(Agent(name="Pinned", compaction_threshold=0.95)) == 0.95

    cleared = (
        await client.put(
            "/settings/compaction", json={"threshold": None, "ratio": None}
        )
    ).json()
    assert cleared["threshold"] == env_threshold
    assert cleared["ratio"] == env_ratio
    assert cleared["threshold_source"] == "env"
    assert cleared["ratio_source"] == "env"
    assert resolve_compaction_threshold(Agent(name="Follower")) == env_threshold


async def test_out_of_range_defaults_are_rejected(client: AsyncClient):
    for payload in ({"threshold": 1.4}, {"ratio": 0}, {"threshold": -1}):
        r = await client.put("/settings/compaction", json=payload)
        assert r.status_code == 422, r.text
    # Nothing was stored, so the effective values are untouched.
    assert (await client.get("/settings/compaction")).json()["threshold_source"] == "env"


async def test_agent_overrides_round_trip_and_clear(client: AsyncClient):
    created = (
        await client.post(
            "/agents",
            json={"name": "Frugal", "compaction_threshold": 0.6, "compaction_ratio": 0.75},
        )
    ).json()
    assert created["compaction_threshold"] == 0.6
    assert created["compaction_ratio"] == 0.75

    # An explicit null clears the override back to the app default.
    cleared = (
        await client.patch(
            f"/agents/{created['id']}",
            json={"compaction_threshold": None, "compaction_ratio": None},
        )
    ).json()
    assert cleared["compaction_threshold"] is None
    assert cleared["compaction_ratio"] is None

    # Fields left out of a PATCH are untouched (the usual partial-update contract).
    again = (
        await client.patch(
            f"/agents/{created['id']}", json={"compaction_threshold": 0.5}
        )
    ).json()
    assert again["compaction_threshold"] == 0.5
    assert (await client.patch(f"/agents/{created['id']}", json={"name": "Frugal2"})).json()[
        "compaction_threshold"
    ] == 0.5


async def test_out_of_range_overrides_are_rejected(client: AsyncClient):
    for payload in (
        {"name": "TooBig", "compaction_threshold": 1.5},
        {"name": "Zero", "compaction_ratio": 0},
        {"name": "Negative", "compaction_threshold": -0.2},
    ):
        r = await client.post("/agents", json=payload)
        assert r.status_code == 422, r.text


async def test_subagent_overrides_round_trip(client: AsyncClient):
    created = (
        await client.post(
            "/subagents",
            json={"name": "Skimmer", "compaction_threshold": 0.45, "compaction_ratio": 0.9},
        )
    ).json()
    assert created["compaction_threshold"] == 0.45
    assert created["compaction_ratio"] == 0.9


async def test_compact_endpoint_honours_the_agents_ratio(
    client: AsyncClient, monkeypatch
):
    """A partial ratio hides only the oldest turns, and files the summary ahead of
    the tail it stands in front of."""
    summarized: dict = {}

    async def _fake_summarize(messages, model_str, custom_providers=None):
        summarized["count"] = len(messages)
        summarized["first"] = messages[0].content
        return "SUMMARY: the oldest half"

    monkeypatch.setattr("app.api.chat.summarize_thread", _fake_summarize)

    agent = (
        await client.post("/agents", json={"name": "Halver", "compaction_ratio": 0.5})
    ).json()
    ws = (await client.post("/workspaces", json={"name": "HalverWS"})).json()
    tid = (
        await client.post(
            "/threads", json={"workspace_id": ws["id"], "agent_id": agent["id"]}
        )
    ).json()["id"]

    # Six same-sized turns written straight to the transcript: this is about the
    # split, not about running a model.
    async with async_session_factory() as session:
        for i in range(6):
            session.add(
                Message(
                    thread_id=tid,
                    role="user" if i % 2 == 0 else "assistant",
                    content=f"turn-{i} " + "x" * 400,
                )
            )
        await session.commit()

    r = await client.post(f"/threads/{tid}/compact")
    assert r.status_code == 200, r.text
    assert r.json() == {"compacted": True, "summarized": 3, "kept": 3}
    assert summarized["count"] == 3
    assert summarized["first"].startswith("turn-0")

    # The thread now reads: summary, then the three turns it does *not* cover.
    after = (await client.get(f"/threads/{tid}/messages")).json()
    assert [m["kind"] for m in after] == ["summary", "chat", "chat", "chat"]
    assert after[0]["content"] == "SUMMARY: the oldest half"
    assert [m["content"].split()[0] for m in after[1:]] == ["turn-3", "turn-4", "turn-5"]
