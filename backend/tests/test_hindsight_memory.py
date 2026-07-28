"""The Hindsight memory provider: resolution, tags, wiring, caching, degradation.

Everything here runs against a fake client (``FakeHindsight`` below), so the suite
stays offline and fast. What that fake stands in for is the real
``hindsight_client.Hindsight``; the *integration* layer above it
(``create_hindsight_tools`` / ``memory_instructions``) is the genuine upstream
package, so these tests pin how our wiring actually calls it rather than a
reimplementation of it.

The two behaviours most worth pinning are the ones that don't show up in a happy
path: that one turn issues exactly *one* recall no matter how many model rounds it
takes (``memory_instructions`` is re-evaluated per model request upstream, so the
uncached version would issue up to 150), and that an ``/ask`` turn has no write
path at all.
"""

from __future__ import annotations

import asyncio

import pytest
from httpx import AsyncClient
from pydantic_ai import Agent as PydanticAgent
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from app.agents import hindsight as hs
from app.agents.builder import _READONLY_TOOL_ALLOWLIST, _subagent_config, build_deep_agent
from app.agents.tool_errors import ToolErrorsAsText
from app.config import get_settings
from app.db.models import Agent, AppConfig, Subagent

# DB / workspace isolation and the ``client`` fixture live in ``conftest.py``.


# --- fakes --------------------------------------------------------------------


class FakeResult:
    def __init__(self, text: str) -> None:
        self.text = text


class FakeRecallResponse:
    def __init__(self, texts: list[str]) -> None:
        self.results = [FakeResult(t) for t in texts]


class FakeReflectResponse:
    def __init__(self, text: str) -> None:
        self.text = text


class FakeBank:
    def __init__(self, bank_id: str, fact_count: int = 0) -> None:
        self.bank_id = bank_id
        self.fact_count = fact_count


class FakeBanksApi:
    """Stands in for ``client.banks`` — the low-level Banks API on the real client."""

    def __init__(self, owner: FakeHindsight) -> None:
        self._owner = owner

    async def list_banks(self):
        self._owner.calls.append(("list_banks", {}))
        if self._owner.banks_error is not None:
            raise self._owner.banks_error
        return type("Listing", (), {"banks": list(self._owner.bank_rows)})()


class FakeHindsight:
    """Stand-in for ``hindsight_client.Hindsight``, recording every call.

    Only the surface our code touches is implemented: the three memory ops, the
    version probe, bank listing/creation, and ``aclose``. Each ``*_error``
    attribute makes the corresponding op raise, which is how the degradation tests
    simulate a reachable-but-failing service.

    Note ``banks`` is a *property* on the real client (the low-level Banks API),
    not a list of banks — so the rows this fake serves live in ``bank_rows``.
    """

    def __init__(
        self,
        *,
        recall: list[str] | None = None,
        banks: list[FakeBank] | None = None,
    ) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.recall_texts = recall if recall is not None else []
        self.bank_rows: list[FakeBank] = banks if banks is not None else []
        self.retain_error: Exception | None = None
        self.recall_error: Exception | None = None
        self.banks_error: Exception | None = None
        self.closed = False

    @property
    def banks(self) -> FakeBanksApi:
        return FakeBanksApi(self)

    async def aretain(self, **kwargs):
        self.calls.append(("aretain", kwargs))
        if self.retain_error is not None:
            raise self.retain_error
        return object()

    async def arecall(self, **kwargs):
        self.calls.append(("arecall", kwargs))
        if self.recall_error is not None:
            raise self.recall_error
        return FakeRecallResponse(self.recall_texts)

    async def areflect(self, **kwargs):
        self.calls.append(("areflect", kwargs))
        return FakeReflectResponse("synthesized")

    async def aget_version(self):
        self.calls.append(("aget_version", {}))
        return type("V", (), {"api_version": "1.2.3"})()

    async def acreate_bank(self, bank_id, **kwargs):
        self.calls.append(("acreate_bank", {"bank_id": bank_id, **kwargs}))
        self.bank_rows.append(FakeBank(bank_id))
        return object()

    async def aclose(self):
        self.closed = True

    def op_names(self) -> list[str]:
        return [name for name, _ in self.calls]

    def kwargs_for(self, op: str) -> list[dict]:
        return [kw for name, kw in self.calls if name == op]


def _fake(**kwargs) -> FakeHindsight:
    return FakeHindsight(**kwargs)


def _config(**overrides) -> hs.HindsightConfig:
    base = {
        "base_url": "http://localhost:8888",
        "api_key": None,
        "bank_id": "lursor",
        "isolation": "workspace",
        "budget": "mid",
        "max_tokens": 4096,
        "inject_memories": True,
        "include_reflect": True,
        "recall_query": hs.DEFAULT_RECALL_QUERY,
        "extra_recall_tags": (),
    }
    base.update(overrides)
    return hs.HindsightConfig(**base)  # type: ignore[arg-type]


@pytest.fixture(autouse=True)
def _reset_module_state():
    """Keep the module-level client / bank caches from leaking between tests."""
    hs._clients.clear()
    hs._ensured_banks.clear()
    yield
    hs._clients.clear()
    hs._ensured_banks.clear()


# --- config resolution --------------------------------------------------------


def test_unset_and_file_providers_resolve_to_none():
    """``None`` is the "use file memory" signal, so the default must produce it."""
    settings = get_settings()
    assert hs.resolve_hindsight_config(None, settings) is None
    assert hs.resolve_hindsight_config(AppConfig(), settings) is None
    assert (
        hs.resolve_hindsight_config(AppConfig(memory_provider="file"), settings) is None
    )
    # An unrecognized value is not a reason to fail a run.
    assert (
        hs.resolve_hindsight_config(AppConfig(memory_provider="bogus"), settings) is None
    )


def test_missing_base_url_degrades_with_a_warning(caplog):
    cfg = AppConfig(memory_provider="hindsight")
    with caplog.at_level("WARNING"):
        assert hs.resolve_hindsight_config(cfg, get_settings()) is None
    assert "no base URL" in caplog.text


def test_missing_extra_degrades_with_a_warning(monkeypatch, caplog):
    """The extra is optional, so selecting the provider without it must not break."""
    monkeypatch.setattr(hs, "hindsight_installed", lambda: False)
    cfg = AppConfig(memory_provider="hindsight", hindsight_base_url="http://x:8888")
    with caplog.at_level("WARNING"):
        assert hs.resolve_hindsight_config(cfg, get_settings()) is None
    assert "extra is not installed" in caplog.text


def test_database_values_win_over_the_environment(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "hindsight_base_url", "http://env:8888", raising=False)
    monkeypatch.setattr(settings, "hindsight_api_key", "env-key", raising=False)

    # Env only.
    resolved = hs.resolve_hindsight_config(AppConfig(memory_provider="hindsight"), settings)
    assert resolved is not None
    assert resolved.base_url == "http://env:8888"
    assert resolved.api_key == "env-key"

    # A saved value wins.
    resolved = hs.resolve_hindsight_config(
        AppConfig(
            memory_provider="hindsight",
            hindsight_base_url="http://db:8888/",
            hindsight_api_key="db-key",
        ),
        settings,
    )
    assert resolved is not None
    # Trailing slash normalized so the client builds one canonical base.
    assert resolved.base_url == "http://db:8888"
    assert resolved.api_key == "db-key"


def test_clearing_the_database_key_reverts_to_the_environment(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "hindsight_api_key", "env-key", raising=False)
    resolved = hs.resolve_hindsight_config(
        AppConfig(
            memory_provider="hindsight",
            hindsight_base_url="http://db:8888",
            hindsight_api_key=None,
        ),
        settings,
    )
    assert resolved is not None
    assert resolved.api_key == "env-key"


def test_knob_defaults_and_partial_blobs():
    settings = get_settings()
    base = {"memory_provider": "hindsight", "hindsight_base_url": "http://x:8888"}

    # Empty blob -> every default.
    resolved = hs.resolve_hindsight_config(AppConfig(**base), settings)
    assert resolved is not None
    assert resolved.bank_id == hs.DEFAULT_BANK_ID
    assert resolved.isolation == "workspace"
    assert resolved.budget == "mid"
    assert resolved.max_tokens == hs.DEFAULT_MAX_TOKENS
    assert resolved.inject_memories is True
    assert resolved.include_reflect is True
    assert resolved.recall_query == hs.DEFAULT_RECALL_QUERY
    assert resolved.extra_recall_tags == ()

    # A partial blob is honoured, and the rest still default.
    resolved = hs.resolve_hindsight_config(
        AppConfig(
            **base,
            hindsight_config={
                "bank_id": " my-bank ",
                "isolation": "shared",
                "budget": "low",
                "inject_memories": False,
                "extra_recall_tags": ["shared", "", "shared", " team "],
            },
        ),
        settings,
    )
    assert resolved is not None
    assert resolved.bank_id == "my-bank"
    assert resolved.isolation == "shared"
    assert resolved.budget == "low"
    assert resolved.inject_memories is False
    # Blank entries dropped, duplicates collapsed, order preserved.
    assert resolved.extra_recall_tags == ("shared", "team")
    # Untouched knobs keep their defaults.
    assert resolved.max_tokens == hs.DEFAULT_MAX_TOKENS
    assert resolved.include_reflect is True


def test_nonsense_knob_values_fall_back_rather_than_raise():
    """The blob is user-editable JSON, so a bad value must not break a run."""
    resolved = hs.resolve_hindsight_config(
        AppConfig(
            memory_provider="hindsight",
            hindsight_base_url="http://x:8888",
            hindsight_config={
                "isolation": "sideways",
                "budget": "enormous",
                "max_tokens": -5,
                "inject_memories": "yes",
                "extra_recall_tags": "shared",
            },
        ),
        get_settings(),
    )
    assert resolved is not None
    assert resolved.isolation == hs.DEFAULT_ISOLATION
    assert resolved.budget == hs.DEFAULT_BUDGET
    assert resolved.max_tokens == hs.DEFAULT_MAX_TOKENS
    assert resolved.inject_memories is True
    assert resolved.extra_recall_tags == ()


# --- tags ---------------------------------------------------------------------


def test_retain_tags_carry_provenance_scope_and_attribution():
    tags = hs.retain_tags(
        workspace_id="ws-123",
        workspace_name="My Cool Project",
        workspace_path="/tmp/ws-123",
        agent_name="Build Agent",
    )
    assert tags == (
        "lursor",
        "workspace:ws-123",
        "workspace-name:my-cool-project",
        "agent:build-agent",
    )


def test_retain_tags_key_the_scope_on_id_so_a_rename_cannot_orphan_memories():
    before = hs.retain_tags(
        workspace_id="ws-123",
        workspace_name="Old Name",
        workspace_path="/tmp/ws-123",
        agent_name="a",
    )
    after = hs.retain_tags(
        workspace_id="ws-123",
        workspace_name="Brand New Name",
        workspace_path="/tmp/ws-123",
        agent_name="a",
    )
    scope = "workspace:ws-123"
    assert scope in before and scope in after
    # Only the cosmetic label moved.
    assert "workspace-name:old-name" in before
    assert "workspace-name:brand-new-name" in after


def test_workspace_tag_falls_back_to_the_path_basename():
    """Subagents and session-less callers pass no id; our dirs are named by id."""
    assert hs.workspace_tag_id(None, "/tmp/workspaces/ws-abc") == "ws-abc"
    assert hs.workspace_tag_id("ws-explicit", "/tmp/workspaces/ws-abc") == "ws-explicit"
    assert hs.workspace_tag_id(None, None) is None


def test_recall_tags_partition_by_workspace_and_honour_the_escape_hatch():
    cfg = _config(isolation="workspace")
    assert hs.recall_tags(cfg, workspace_id="ws-1", workspace_path=None) == (
        "workspace:ws-1",
    )

    cfg = _config(isolation="workspace", extra_recall_tags=("shared", "team"))
    assert hs.recall_tags(cfg, workspace_id="ws-1", workspace_path=None) == (
        "workspace:ws-1",
        "shared",
        "team",
    )


def test_shared_isolation_applies_no_recall_filter():
    """The bring-your-own-bank mode: an externally-filled bank works as-is."""
    cfg = _config(isolation="shared", extra_recall_tags=("ignored",))
    assert hs.recall_tags(cfg, workspace_id="ws-1", workspace_path="/tmp/ws-1") == ()


def test_slugify():
    assert hs.slugify("My Cool Project!") == "my-cool-project"
    assert hs.slugify("  --Weird__Name--  ") == "weird-name"
    assert hs.slugify("!!!") == ""


# --- builder wiring -----------------------------------------------------------


def _toolset_ids(agent: PydanticAgent) -> set[str]:
    """Ids of every toolset reachable from a built agent."""
    ids: set[str] = set()

    def walk(node) -> None:
        node_id = getattr(node, "id", None)
        if isinstance(node_id, str):
            ids.add(node_id)
        for attr in ("toolsets", "wrapped"):
            child = getattr(node, attr, None)
            if child is None:
                continue
            for item in child if isinstance(child, (list, tuple)) else [child]:
                walk(item)

    for toolset in agent.toolsets:
        walk(toolset)
    return ids


def _hindsight_capability(agent_row, workspace, **kwargs):
    """Build an agent and hand back its Hindsight capability (or ``None``)."""
    agent, _deps = build_deep_agent(agent_row, str(workspace), {}, [], {}, **kwargs)
    caps = [
        c
        for c in _capabilities_of(agent)
        if isinstance(c, hs.HindsightMemoryCapability)
    ]
    return agent, (caps[0] if caps else None)


def _capabilities_of(agent: PydanticAgent) -> list:
    """Every capability attached to a built agent, flattened.

    pydantic-ai wraps the list it was handed in a ``CombinedCapability``, which is
    nestable, so this walks the tree rather than reading one attribute.
    """
    found: list = []

    def walk(node) -> None:
        if node is None:
            return
        if isinstance(node, (list, tuple)):
            for item in node:
                walk(item)
            return
        found.append(node)
        walk(getattr(node, "capabilities", None))

    walk(agent.root_capability)
    return found


def test_hindsight_replaces_the_file_memory_toolset(tmp_path, monkeypatch):
    """Both providers must never be live at once — three tools, not six."""
    fake = _fake()
    monkeypatch.setattr(hs, "shared_client", lambda config: fake)

    agent, capability = _hindsight_capability(
        Agent(name="A", include_memory=True),
        tmp_path,
        hindsight=_config(),
        workspace_id="ws-1",
    )
    ids = _toolset_ids(agent)
    assert hs.TOOLSET_ID in ids
    assert "deep-memory" not in ids
    assert capability is not None
    assert capability.tool_names == {
        hs.RETAIN_TOOL,
        hs.RECALL_TOOL,
        hs.REFLECT_TOOL,
    }


def test_file_provider_is_unchanged(tmp_path):
    """No config (or the file provider) leaves today's behaviour exactly as-is."""
    agent, capability = _hindsight_capability(
        Agent(name="A", include_memory=True), tmp_path, hindsight=None
    )
    ids = _toolset_ids(agent)
    assert "deep-memory" in ids
    assert hs.TOOLSET_ID not in ids
    assert capability is None


def test_include_memory_off_means_neither_provider(tmp_path, monkeypatch):
    monkeypatch.setattr(hs, "shared_client", lambda config: _fake())
    for config in (None, _config()):
        agent, capability = _hindsight_capability(
            Agent(name="A", include_memory=False), tmp_path, hindsight=config
        )
        ids = _toolset_ids(agent)
        assert "deep-memory" not in ids
        assert hs.TOOLSET_ID not in ids
        assert capability is None


def test_read_only_mode_has_no_write_path(tmp_path, monkeypatch):
    """An /ask turn can recall and reflect but has no way to retain."""
    monkeypatch.setattr(hs, "shared_client", lambda config: _fake())
    _agent, capability = _hindsight_capability(
        Agent(name="A", include_memory=True),
        tmp_path,
        hindsight=_config(),
        read_only=True,
        workspace_id="ws-1",
    )
    assert capability is not None
    # Belt: the tool is never built.
    assert capability.tool_names == {hs.RECALL_TOOL, hs.REFLECT_TOOL}
    # Braces: even if it were, the read-only allowlist would drop it.
    assert hs.RETAIN_TOOL not in _READONLY_TOOL_ALLOWLIST
    assert hs.RECALL_TOOL in _READONLY_TOOL_ALLOWLIST
    assert hs.REFLECT_TOOL in _READONLY_TOOL_ALLOWLIST


def test_reflect_can_be_turned_off(tmp_path, monkeypatch):
    """Reflect is a server-side LLM call; a small self-hosted model may not want it."""
    monkeypatch.setattr(hs, "shared_client", lambda config: _fake())
    _agent, capability = _hindsight_capability(
        Agent(name="A", include_memory=True),
        tmp_path,
        hindsight=_config(include_reflect=False),
        workspace_id="ws-1",
    )
    assert capability is not None
    assert capability.tool_names == {hs.RETAIN_TOOL, hs.RECALL_TOOL}


def test_the_prompt_directive_is_only_added_on_the_hindsight_provider(
    tmp_path, monkeypatch
):
    seen: dict = {}

    def fake_create_deep_agent(**kwargs):
        seen.update(kwargs)
        return object()

    from app.agents import builder

    monkeypatch.setattr(builder, "create_deep_agent", fake_create_deep_agent)
    monkeypatch.setattr(hs, "shared_client", lambda config: _fake())

    build_deep_agent(Agent(name="A", include_memory=True), str(tmp_path), {}, [], {})
    assert hs.HINDSIGHT_MEMORY_DIRECTIVE not in seen["instructions"]
    assert seen["include_memory"] is True

    build_deep_agent(
        Agent(name="A", include_memory=True),
        str(tmp_path),
        {},
        [],
        {},
        hindsight=_config(),
    )
    assert hs.HINDSIGHT_MEMORY_DIRECTIVE in seen["instructions"]
    # The library's MEMORY.md toolset is suppressed in the same breath.
    assert seen["include_memory"] is False


def test_a_subagent_inherits_the_parents_bank_and_connection(tmp_path, monkeypatch):
    """A subagent works in the parent's workspace, so it shares the parent's memory."""
    fake = _fake()
    monkeypatch.setattr(hs, "shared_client", lambda config: fake)

    sa = Subagent(name="deep", description="d", instructions="i", include_memory=True)
    cfg = _subagent_config(
        sa,
        workspace_path=str(tmp_path),
        workspace_name="deep-ws",
        workspace_description=None,
        custom_providers={},
        subagents=[sa],
        deep_defaults={"max_nesting_depth": 1},
        parent_model="openrouter:test/model",
        web_search_provider=None,
        tavily_api_key=None,
        exa_api_key=None,
        child_depth=1,
        skill_runtime=None,
        hindsight=_config(bank_id="parent-bank"),
    )
    sub_agent = cfg["agent_factory"](cfg)
    caps = [
        c
        for c in _capabilities_of(sub_agent)
        if isinstance(c, hs.HindsightMemoryCapability)
    ]
    assert len(caps) == 1
    assert caps[0].config.bank_id == "parent-bank"
    assert caps[0].client is fake
    assert hs.TOOLSET_ID in _toolset_ids(sub_agent)


def test_retain_and_recall_tags_reach_the_upstream_tools(tmp_path, monkeypatch):
    """The tags computed here are the tags the service actually receives."""
    fake = _fake(recall=["a fact"])
    monkeypatch.setattr(hs, "shared_client", lambda config: fake)

    _agent, capability = _hindsight_capability(
        Agent(name="Build Agent", include_memory=True),
        tmp_path,
        hindsight=_config(extra_recall_tags=("shared",)),
        workspace_id="ws-9",
        workspace_name="Proj",
    )
    assert capability is not None
    toolset = capability.get_toolset()
    assert toolset is not None

    async def exercise() -> None:
        await toolset.tools[hs.RETAIN_TOOL].function("a durable fact")
        await toolset.tools[hs.RECALL_TOOL].function("what do I know")

    asyncio.run(exercise())

    retain = fake.kwargs_for("aretain")[0]
    assert set(retain["tags"]) == {
        "lursor",
        "workspace:ws-9",
        "workspace-name:proj",
        "agent:build-agent",
    }
    recall = fake.kwargs_for("arecall")[0]
    assert recall["tags"] == ["workspace:ws-9", "shared"]
    # The literal, not the constant: plain ``any``/``all`` *include untagged
    # memories*, which would leak every untagged memory in the bank into every
    # workspace. Only the ``_strict`` variants are a real partition, so a change
    # to this value has to break a test rather than quietly widen the scope.
    assert recall["tags_match"] == "any_strict"
    assert hs.STRICT_TAG_MATCH == "any_strict"


# --- caching ------------------------------------------------------------------


def _capability(client, **config_overrides) -> hs.HindsightMemoryCapability:
    return hs.build_hindsight_capability(
        _config(**config_overrides),
        workspace_id="ws-1",
        workspace_name="ws",
        workspace_path="/tmp/ws-1",
        agent_name="A",
        client=client,
    )


async def test_many_model_rounds_issue_exactly_one_recall():
    """The whole point of the cache: 150 model rounds must not be 150 recalls."""
    fake = _fake(recall=["remembered thing"])
    capability = _capability(fake)

    blocks = [await capability._instructions(None) for _ in range(25)]

    assert fake.op_names().count("arecall") == 1
    assert all(b == blocks[0] for b in blocks)
    assert "remembered thing" in blocks[0]
    assert blocks[0].startswith(hs.INJECTION_PREFIX)

    # The auto-injection is scoped exactly like an explicit recall — otherwise
    # every turn would inject another workspace's memories.
    recall = fake.kwargs_for("arecall")[0]
    assert recall["tags"] == ["workspace:ws-1"]
    assert recall["tags_match"] == "any_strict"
    assert recall["query"] == hs.DEFAULT_RECALL_QUERY


async def test_concurrent_evaluations_still_recall_once():
    """Parallel instruction evaluations must not race past the cache."""
    fake = _fake(recall=["x"])
    capability = _capability(fake)

    await asyncio.gather(*(capability._instructions(None) for _ in range(10)))

    assert fake.op_names().count("arecall") == 1


async def test_retaining_something_new_busts_the_cache():
    """A fact the agent just stored has to be visible to the next injection."""
    fake = _fake(recall=["first"])
    capability = _capability(fake)

    assert "first" in await capability._instructions(None)
    fake.recall_texts = ["first", "second"]
    # Still cached — the agent hasn't written anything.
    assert "second" not in await capability._instructions(None)

    await capability.after_tool_execute(
        None,
        call=ToolCallPart(hs.RETAIN_TOOL, {"content": "second"}),
        tool_def=None,
        args=None,
        result="Memory stored successfully.",
    )
    assert "second" in await capability._instructions(None)
    assert fake.op_names().count("arecall") == 2


async def test_other_tools_do_not_bust_the_cache():
    fake = _fake(recall=["first"])
    capability = _capability(fake)
    await capability._instructions(None)

    await capability.after_tool_execute(
        None,
        call=ToolCallPart("read_file", {"path": "x"}),
        tool_def=None,
        args=None,
        result="contents",
    )
    await capability._instructions(None)
    assert fake.op_names().count("arecall") == 1


async def test_the_cache_expires_so_a_long_goal_run_refreshes(monkeypatch):
    """Goal mode reuses one built agent across iterations for potentially hours."""
    fake = _fake(recall=["stale"])
    capability = _capability(fake)
    clock = {"now": 1_000.0}
    monkeypatch.setattr(hs.time, "monotonic", lambda: clock["now"])

    await capability._instructions(None)
    clock["now"] += hs.RECALL_CACHE_TTL - 1
    await capability._instructions(None)
    assert fake.op_names().count("arecall") == 1

    clock["now"] += 2
    await capability._instructions(None)
    assert fake.op_names().count("arecall") == 2


async def test_a_failing_recall_injects_nothing_and_raises_nothing():
    """A memory service that is down must not stop the turn from starting."""
    fake = _fake()
    fake.recall_error = RuntimeError("connection refused")
    capability = _capability(fake)

    assert await capability._instructions(None) == ""


async def test_injection_can_be_turned_off_entirely():
    """No auto-recall means no per-turn query leaves the machine at all."""
    fake = _fake(recall=["x"])
    capability = _capability(fake, inject_memories=False)

    toolset = capability.get_toolset()
    assert toolset is not None
    # The tools are still there; only the prompt injection is gone.
    assert capability.tool_names == {hs.RETAIN_TOOL, hs.RECALL_TOOL, hs.REFLECT_TOOL}
    assert await toolset.get_instructions(None) is None
    assert "arecall" not in fake.op_names()


# --- bank bootstrap -----------------------------------------------------------


async def test_bank_bootstrap_creates_only_a_missing_bank():
    fake = _fake(banks=[])
    await hs.ensure_bank(fake, _config(bank_id="new-bank"))
    assert "acreate_bank" in fake.op_names()


async def test_bank_bootstrap_never_writes_to_an_existing_bank():
    """The bank may be one the user already owns and configured elsewhere."""
    fake = _fake(banks=[FakeBank("lursor", fact_count=12)])
    await hs.ensure_bank(fake, _config(bank_id="lursor"))
    assert "acreate_bank" not in fake.op_names()


async def test_bank_bootstrap_runs_once_per_process_even_when_it_fails(caplog):
    """A failing instance must not mean a probe on every single turn."""
    fake = _fake()
    fake.banks_error = RuntimeError("unreachable")
    config = _config(bank_id="b")

    with caplog.at_level("WARNING"):
        await hs.ensure_bank(fake, config)
        await hs.ensure_bank(fake, config)

    assert fake.op_names().count("list_banks") == 1
    assert "could not verify or create" in caplog.text


async def test_before_run_bootstraps_the_bank():
    fake = _fake(banks=[FakeBank("lursor")])
    capability = _capability(fake)
    await capability.before_run(None)
    assert "list_banks" in fake.op_names()


async def test_recalled_memory_actually_reaches_the_model(tmp_path, monkeypatch):
    """The end-to-end fact everything else is in service of.

    Runs a real turn on a fully built agent and reads what the model was sent.
    Note capability/toolset instructions arrive on the request's ``instructions``
    field, not inside a message part — asserting on parts would pass vacuously.
    """
    fake = _fake(recall=["jon insists on absolute paths in docs"])
    monkeypatch.setattr(hs, "shared_client", lambda config: fake)

    agent, deps = build_deep_agent(
        Agent(name="Doc Agent", include_memory=True, instructions="You write docs."),
        str(tmp_path),
        {},
        [],
        {},
        workspace_id="ws-77",
        workspace_name="Docs WS",
        hindsight=_config(),
    )

    seen: dict[str, str] = {}

    def respond(messages, info: AgentInfo):
        for message in messages:
            text = getattr(message, "instructions", None)
            if isinstance(text, str):
                seen["instructions"] = text
        return ModelResponse(parts=[TextPart("done")])

    with agent.override(model=FunctionModel(respond)):
        # ``deps`` is required: the library's own instructions read the backend off it.
        result = await agent.run("write the readme", deps=deps)

    assert result.output == "done"
    prompt = seen.get("instructions", "")
    # The recalled memory itself.
    assert "jon insists on absolute paths in docs" in prompt
    assert hs.INJECTION_PREFIX.strip() in prompt
    # The directive telling the agent these tools exist and what not to store.
    assert "hindsight_retain` saves something new" in prompt
    # The agent's own instructions are extended, not replaced.
    assert "You write docs." in prompt
    # One recall for the whole turn.
    assert fake.op_names().count("arecall") == 1


# --- degradation --------------------------------------------------------------


async def test_a_failing_retain_reaches_the_model_as_text_and_the_turn_survives():
    """The ``ToolErrorsAsText`` net is what keeps a broken service non-fatal.

    Upstream raises ``HindsightError`` rather than returning an error string, so
    without that capability installed first in the builder's list, one failed
    retain would end the turn on the first failure.
    """
    fake = _fake()
    fake.retain_error = RuntimeError("500 Internal Server Error")
    capability = _capability(fake)
    toolset = capability.get_toolset()
    assert toolset is not None

    state = {"calls": 0, "saw": ""}

    def respond(messages, info: AgentInfo):
        if state["calls"] == 0:
            state["calls"] += 1
            return ModelResponse(
                parts=[ToolCallPart(hs.RETAIN_TOOL, {"content": "a fact"})]
            )
        for message in reversed(messages):
            for part in message.parts:
                content = getattr(part, "content", None)
                if isinstance(content, str) and content.startswith("Error:"):
                    state["saw"] = content
        return ModelResponse(parts=[TextPart("noted, moving on")])

    agent = PydanticAgent(
        FunctionModel(respond),
        toolsets=[toolset],
        capabilities=[ToolErrorsAsText()],
    )
    result = await agent.run("remember this")

    assert result.output == "noted, moving on"
    assert "hindsight_retain failed" in state["saw"]
    assert "500 Internal Server Error" in state["saw"]


# --- client lifecycle ---------------------------------------------------------


def test_clients_are_shared_per_connection_and_closed_on_shutdown():
    a = hs.shared_client(_config(base_url="http://one:8888"))
    b = hs.shared_client(_config(base_url="http://one:8888"))
    c = hs.shared_client(_config(base_url="http://two:8888"))
    assert a is b
    assert a is not c

    # A different key on the same URL is a different connection.
    d = hs.shared_client(_config(base_url="http://one:8888", api_key="k"))
    assert d is not a

    asyncio.run(hs.close_hindsight_clients())
    assert hs._clients == {}


# --- API ----------------------------------------------------------------------


async def test_memory_settings_default_to_the_file_provider(client: AsyncClient):
    r = await client.get("/settings/memory")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "file"
    assert body["bank_id"] == hs.DEFAULT_BANK_ID
    assert body["isolation"] == "workspace"
    assert body["budget"] == "mid"
    assert body["max_tokens"] == hs.DEFAULT_MAX_TOKENS
    assert body["inject_memories"] is True
    assert body["include_reflect"] is True
    assert body["extra_recall_tags"] == []
    assert body["hindsight_configured"] is False
    assert body["hindsight_source"] == "none"


async def test_memory_settings_round_trip_every_field(client: AsyncClient):
    payload = {
        "provider": "hindsight",
        "hindsight_base_url": "http://localhost:8888/",
        "hindsight_api_key": "secret-key-a1b2",
        "bank_id": "my-bank",
        "isolation": "shared",
        "budget": "high",
        "max_tokens": 2048,
        "inject_memories": False,
        "include_reflect": False,
        "extra_recall_tags": ["shared", "  ", "team"],
        "recall_query": "what matters here",
    }
    r = await client.put("/settings/memory", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["provider"] == "hindsight"
    # Trailing slash normalized on save.
    assert body["hindsight_base_url"] == "http://localhost:8888"
    assert body["bank_id"] == "my-bank"
    assert body["isolation"] == "shared"
    assert body["budget"] == "high"
    assert body["max_tokens"] == 2048
    assert body["inject_memories"] is False
    assert body["include_reflect"] is False
    assert body["extra_recall_tags"] == ["shared", "team"]
    assert body["recall_query"] == "what matters here"

    # The key is never echoed — only its status, a hint, and its source.
    assert "hindsight_api_key" not in body
    assert body["hindsight_configured"] is True
    assert body["hindsight_key_hint"] == "…a1b2"
    assert body["hindsight_source"] == "database"

    # A plain GET reads back identically.
    assert (await client.get("/settings/memory")).json() == body


async def test_a_partial_put_leaves_untouched_fields_alone(client: AsyncClient):
    await client.put(
        "/settings/memory",
        json={
            "provider": "hindsight",
            "hindsight_base_url": "http://localhost:8888",
            "bank_id": "keep-me",
            "budget": "low",
        },
    )
    r = await client.put("/settings/memory", json={"isolation": "shared"})
    body = r.json()
    assert body["isolation"] == "shared"
    assert body["provider"] == "hindsight"
    assert body["bank_id"] == "keep-me"
    assert body["budget"] == "low"
    assert body["hindsight_base_url"] == "http://localhost:8888"


async def test_a_blank_knob_reverts_to_its_default(client: AsyncClient):
    await client.put("/settings/memory", json={"bank_id": "custom"})
    assert (await client.get("/settings/memory")).json()["bank_id"] == "custom"

    r = await client.put("/settings/memory", json={"bank_id": "  "})
    assert r.json()["bank_id"] == hs.DEFAULT_BANK_ID


async def test_clearing_the_key_reverts_to_the_environment(
    client: AsyncClient, monkeypatch
):
    await client.put("/settings/memory", json={"hindsight_api_key": "db-key-9999"})
    assert (await client.get("/settings/memory")).json()["hindsight_source"] == "database"

    monkeypatch.setattr(get_settings(), "hindsight_api_key", "env-key-0000", raising=False)
    r = await client.put("/settings/memory", json={"hindsight_api_key": ""})
    body = r.json()
    assert body["hindsight_source"] == "env"
    assert body["hindsight_key_hint"] == "…0000"


async def test_invalid_values_are_rejected(client: AsyncClient):
    assert (
        await client.put("/settings/memory", json={"provider": "telepathy"})
    ).status_code == 422
    assert (
        await client.put("/settings/memory", json={"isolation": "sideways"})
    ).status_code == 422
    assert (
        await client.put("/settings/memory", json={"budget": "enormous"})
    ).status_code == 422
    assert (
        await client.put("/settings/memory", json={"max_tokens": 0})
    ).status_code == 422


async def test_the_test_endpoint_needs_a_base_url(client: AsyncClient, monkeypatch):
    # Explicit rather than assumed: the suite shares one database, so another test
    # may have saved a URL, and the developer's machine may well have something
    # listening on Hindsight's default port.
    monkeypatch.setattr(get_settings(), "hindsight_base_url", None, raising=False)
    await client.put("/settings/memory", json={"hindsight_base_url": ""})

    r = await client.post("/settings/memory/test", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "error"
    assert "base URL" in body["error"]


async def test_the_test_endpoint_reports_version_and_bank(client: AsyncClient, monkeypatch):
    fake = _fake(banks=[FakeBank("lursor", fact_count=42)])
    monkeypatch.setattr(
        "hindsight_client.Hindsight", lambda **kwargs: fake, raising=False
    )
    r = await client.post(
        "/settings/memory/test", json={"hindsight_base_url": "http://localhost:8888"}
    )
    body = r.json()
    assert body["status"] == "ok"
    assert body["version"] == "1.2.3"
    assert body["bank_exists"] is True
    assert body["memory_count"] == 42
    # The throwaway client is closed rather than leaked.
    assert fake.closed is True


async def test_the_test_endpoint_reports_a_missing_bank(client: AsyncClient, monkeypatch):
    fake = _fake(banks=[FakeBank("someone-elses-bank")])
    monkeypatch.setattr(
        "hindsight_client.Hindsight", lambda **kwargs: fake, raising=False
    )
    r = await client.post(
        "/settings/memory/test",
        json={"hindsight_base_url": "http://localhost:8888", "bank_id": "lursor"},
    )
    body = r.json()
    assert body["status"] == "ok"
    assert body["bank_exists"] is False
    assert body["memory_count"] is None


async def test_the_test_endpoint_maps_an_unreachable_instance(
    client: AsyncClient, monkeypatch
):
    class Dead(FakeHindsight):
        async def aget_version(self):
            raise OSError("Connection refused")

    dead = Dead()
    monkeypatch.setattr(
        "hindsight_client.Hindsight", lambda **kwargs: dead, raising=False
    )
    r = await client.post(
        "/settings/memory/test", json={"hindsight_base_url": "http://localhost:8888"}
    )
    body = r.json()
    assert body["status"] == "error"
    assert "Could not reach Hindsight" in body["error"]
    assert dead.closed is True


async def test_the_test_endpoint_maps_a_rejected_key(client: AsyncClient, monkeypatch):
    class Rejecting(FakeHindsight):
        async def aget_version(self):
            error = RuntimeError("Unauthorized")
            error.status = 401  # type: ignore[attr-defined]
            raise error

    monkeypatch.setattr(
        "hindsight_client.Hindsight", lambda **kwargs: Rejecting(), raising=False
    )
    r = await client.post(
        "/settings/memory/test",
        json={"hindsight_base_url": "http://localhost:8888", "hindsight_api_key": "bad"},
    )
    body = r.json()
    assert body["status"] == "error"
    assert "rejected the API key" in body["error"]


async def test_a_reachable_instance_with_a_failing_bank_listing_is_still_ok(
    client: AsyncClient, monkeypatch
):
    """A connection that works is worth reporting even if the bank probe doesn't."""
    fake = _fake()
    fake.banks_error = RuntimeError("permission denied")
    monkeypatch.setattr(
        "hindsight_client.Hindsight", lambda **kwargs: fake, raising=False
    )
    r = await client.post(
        "/settings/memory/test", json={"hindsight_base_url": "http://localhost:8888"}
    )
    body = r.json()
    assert body["status"] == "ok"
    assert body["version"] == "1.2.3"
    assert body["bank_exists"] is None


async def test_the_test_endpoint_says_so_when_the_extra_is_missing(
    client: AsyncClient, monkeypatch
):
    monkeypatch.setattr(hs, "hindsight_installed", lambda: False)
    r = await client.post(
        "/settings/memory/test", json={"hindsight_base_url": "http://localhost:8888"}
    )
    body = r.json()
    assert body["status"] == "error"
    assert "not installed" in body["error"]
    assert (await client.get("/settings/memory")).json()["hindsight_installed"] is False
