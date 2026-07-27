"""The resolved environment reaches the agent: prompt listing, shell, scripts.

``load_skill_runtime`` is the single async step that turns assignments in the
database into everything the (synchronous) builder needs. These tests pin the
contract at that seam: which skills come back, what env they carry, that the
prompt names keys but never values, and that ``build_deep_agent`` installs the env
for the run's shell.
"""

from __future__ import annotations

from httpx import AsyncClient

from app.agents.builder import _environment_instructions, build_deep_agent
from app.agents.deduping_backend import current_run_env
from app.agents.skill_runtime import load_skill_runtime
from app.db.models import Agent as AgentRow
from app.db.session import async_session_factory


async def _runtime(workspace: dict, *, include_skills: bool = True):
    async with async_session_factory() as session:
        return await load_skill_runtime(
            session,
            workspace_path=workspace["path"],
            workspace_id=workspace["id"],
            include_skills=include_skills,
        )


async def test_runtime_carries_assigned_skills_and_their_env(client: AsyncClient):
    ws = (await client.post("/workspaces", json={"name": "RuntimeWS"})).json()
    skill = (
        await client.post(
            "/skills",
            json={
                "name": "Stripe Reports",
                "content": "body",
                "is_global": False,
                "workspace_ids": [ws["id"]],
            },
        )
    ).json()
    await client.post(
        "/env-vars",
        json={
            "key": "REPORTS_STRIPE_KEY",
            "value": "sk-live-runtime-value",
            "description": "billing",
            "skill_ids": [skill["id"]],
        },
    )

    runtime = await _runtime(ws)
    scoped = {s.slug: s for s in runtime.scoped}
    assert "stripe-reports" in scoped
    assert runtime.run_env.values["REPORTS_STRIPE_KEY"] == "sk-live-runtime-value"
    # The skill's own folder maps to its own env, for run_skill_script.
    folder = str(scoped["stripe-reports"].folder)
    assert runtime.env_by_folder[folder]["REPORTS_STRIPE_KEY"] == "sk-live-runtime-value"
    assert "sk-live-runtime-value" in runtime.secrets


async def test_unassigned_skill_is_not_in_scope(client: AsyncClient):
    ws = (await client.post("/workspaces", json={"name": "ParkedWS"})).json()
    parked = (
        await client.post(
            "/skills", json={"name": "Parked Skill", "is_global": False}
        )
    ).json()
    await client.post(
        "/env-vars",
        json={"key": "PARKED_KEY", "value": "parked-secret", "skill_ids": [parked["id"]]},
    )

    runtime = await _runtime(ws)
    assert parked["slug"] not in [s.slug for s in runtime.scoped]
    # Its vars don't leak in either: they ride on the skill being in scope.
    assert "PARKED_KEY" not in runtime.run_env.values


async def test_skills_off_drops_skill_env_but_keeps_workspace_env(client: AsyncClient):
    ws = (await client.post("/workspaces", json={"name": "OffWS"})).json()
    skill = (await client.post("/skills", json={"name": "Off Runtime Skill"})).json()
    await client.post(
        "/env-vars",
        json={"key": "OFF_SKILL_KEY", "value": "skill-value", "skill_ids": [skill["id"]]},
    )
    await client.post(
        "/env-vars",
        json={
            "key": "OFF_WS_KEY",
            "value": "workspace-value",
            "workspace_ids": [ws["id"]],
        },
    )

    runtime = await _runtime(ws, include_skills=False)
    assert runtime.scoped == ()
    assert "OFF_SKILL_KEY" not in runtime.run_env.values
    # A workspace's own config is not a skill, so the skills toggle doesn't hide it.
    assert runtime.run_env.values["OFF_WS_KEY"] == "workspace-value"


async def test_prompt_lists_names_not_values(client: AsyncClient):
    ws = (await client.post("/workspaces", json={"name": "PromptWS"})).json()
    await client.post(
        "/env-vars",
        json={
            "key": "PROMPT_TOKEN",
            "value": "prompt-secret-value",
            "description": "used by the reporting skill",
            "is_global": True,
        },
    )
    runtime = await _runtime(ws)

    prompt = _environment_instructions(ws["path"], "PromptWS", None, runtime)
    assert "PROMPT_TOKEN" in prompt
    assert "used by the reporting skill" in prompt
    assert "(global)" in prompt
    # The whole point: the model learns the name, never the value.
    assert "prompt-secret-value" not in prompt
    assert "never print, echo, or copy" in prompt

    # With no vars, the section is unchanged from before the feature.
    bare = _environment_instructions(ws["path"], "PromptWS", None, None)
    assert "Environment variables available" not in bare


async def test_build_installs_the_env_for_the_run(client: AsyncClient, tmp_path):
    ws = (await client.post("/workspaces", json={"name": "BuildWS"})).json()
    await client.post(
        "/env-vars",
        json={"key": "BUILD_TOKEN", "value": "build-secret-value", "is_global": True},
    )
    runtime = await _runtime(ws)

    build_deep_agent(
        AgentRow(name="EnvAgent", model="openrouter:test/model"),
        ws["path"],
        {},
        [],
        {},
        skill_runtime=runtime,
    )

    # The run's context now carries the env every shell call will spawn with.
    env = current_run_env()
    assert env.values["BUILD_TOKEN"] == "build-secret-value"
    assert "build-secret-value" in env.secrets
