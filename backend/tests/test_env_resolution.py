"""Env var layering: global → workspace → skill, and the API that manages it.

Covers ``app/envvars/resolve.py`` (precedence, conflict reporting, per-skill
isolation, redaction) and ``app/api/env_vars.py`` (write-only secrets, per-layer
key uniqueness, the resolved-env view).
"""

from __future__ import annotations

from httpx import AsyncClient

from app.db.models import EnvVar, EnvVarSkillLink, EnvVarWorkspaceLink, Skill
from app.db.session import async_session_factory
from app.envvars.resolve import (
    MIN_REDACT_LENGTH,
    redact,
    resolve_env,
    resolve_skill_env,
)


async def _seed(
    *,
    workspace_id: str,
    global_vars: dict[str, str] | None = None,
    workspace_vars: dict[str, str] | None = None,
    skill_vars: dict[str, dict[str, str]] | None = None,
) -> None:
    """Write vars directly, so resolution is tested without the API in the way."""
    async with async_session_factory() as session:
        for key, value in (global_vars or {}).items():
            session.add(EnvVar(key=key, value=value, is_global=True))
        for key, value in (workspace_vars or {}).items():
            row = EnvVar(key=key, value=value)
            session.add(row)
            await session.flush()
            session.add(
                EnvVarWorkspaceLink(env_var_id=row.id, workspace_id=workspace_id)
            )
        for skill_id, pairs in (skill_vars or {}).items():
            for key, value in pairs.items():
                row = EnvVar(key=key, value=value)
                session.add(row)
                await session.flush()
                session.add(EnvVarSkillLink(env_var_id=row.id, skill_id=skill_id))
        await session.commit()


async def test_layer_precedence_and_conflicts(client: AsyncClient):
    ws = (await client.post("/workspaces", json={"name": "EnvPrec"})).json()
    skill = (
        await client.post("/skills", json={"name": "Stripe Refunds", "content": "b"})
    ).json()
    await _seed(
        workspace_id=ws["id"],
        global_vars={"SHARED": "from-global", "ONLY_GLOBAL": "g"},
        workspace_vars={"SHARED": "from-workspace"},
        skill_vars={skill["id"]: {"SHARED": "from-skill", "SKILL_ONLY": "s"}},
    )

    async with async_session_factory() as session:
        resolved = await resolve_env(
            session, workspace_id=ws["id"], skill_ids=[skill["id"]]
        )

    # Closest layer wins; the others are still reported as overridden.
    assert resolved.values["SHARED"] == "from-skill"
    assert resolved.provenance["SHARED"] == "skill:stripe-refunds"
    assert resolved.conflicts["SHARED"] == ["global", "workspace", "skill:stripe-refunds"]
    # Untouched keys pass through with their own provenance, and no conflict.
    assert resolved.values["ONLY_GLOBAL"] == "g"
    assert resolved.provenance["ONLY_GLOBAL"] == "global"
    assert resolved.values["SKILL_ONLY"] == "s"
    assert "ONLY_GLOBAL" not in resolved.conflicts


async def test_skills_off_keeps_base_layers(client: AsyncClient):
    """A skill's vars drop out when skills are off; workspace/global ones don't."""
    ws = (await client.post("/workspaces", json={"name": "EnvOff"})).json()
    skill = (await client.post("/skills", json={"name": "Off Skill"})).json()
    await _seed(
        workspace_id=ws["id"],
        global_vars={"OFF_G": "gv"},
        workspace_vars={"OFF_W": "wv"},
        skill_vars={skill["id"]: {"OFF_S": "sv"}},
    )
    async with async_session_factory() as session:
        resolved = await resolve_env(session, workspace_id=ws["id"], skill_ids=[])
    assert resolved.values["OFF_G"] == "gv"
    assert resolved.values["OFF_W"] == "wv"
    assert "OFF_S" not in resolved.values


async def test_skill_env_isolation(client: AsyncClient):
    """One skill's scripts never see another skill's secrets."""
    ws = (await client.post("/workspaces", json={"name": "EnvIso"})).json()
    a = (await client.post("/skills", json={"name": "Alpha"})).json()
    b = (await client.post("/skills", json={"name": "Bravo"})).json()
    await _seed(
        workspace_id=ws["id"],
        global_vars={"ISO_BASE": "base"},
        skill_vars={a["id"]: {"A_KEY": "a-secret"}, b["id"]: {"B_KEY": "b-secret"}},
    )
    async with async_session_factory() as session:
        env_a = await resolve_skill_env(
            session, workspace_id=ws["id"], skill_id=a["id"]
        )
        # The run-wide union does carry both — a shell command can't be attributed
        # to a skill, so that path is deliberately broader than the script path.
        union = await resolve_env(
            session, workspace_id=ws["id"], skill_ids=[a["id"], b["id"]]
        )
    assert env_a.values["ISO_BASE"] == "base"  # base layers still apply
    assert env_a.values["A_KEY"] == "a-secret"
    assert "B_KEY" not in env_a.values
    assert {"A_KEY", "B_KEY"} <= set(union.values)


async def test_same_layer_collision_is_deterministic(client: AsyncClient):
    """Two in-scope skills defining one key resolve by slug, ascending."""
    ws = (await client.post("/workspaces", json={"name": "EnvTie"})).json()
    first = (await client.post("/skills", json={"name": "aaa-skill"})).json()
    second = (await client.post("/skills", json={"name": "zzz-skill"})).json()
    await _seed(
        workspace_id=ws["id"],
        skill_vars={
            first["id"]: {"TIE": "from-aaa"},
            second["id"]: {"TIE": "from-zzz"},
        },
    )
    async with async_session_factory() as session:
        # Order of skill_ids must not matter: the resolver sorts by slug.
        one = await resolve_env(
            session, workspace_id=ws["id"], skill_ids=[first["id"], second["id"]]
        )
        two = await resolve_env(
            session, workspace_id=ws["id"], skill_ids=[second["id"], first["id"]]
        )
    assert one.values["TIE"] == two.values["TIE"] == "from-zzz"  # last slug wins
    assert one.provenance["TIE"] == "skill:zzz-skill"


async def test_secret_values_and_redaction(client: AsyncClient):
    ws = (await client.post("/workspaces", json={"name": "EnvRedact"})).json()
    async with async_session_factory() as session:
        session.add(EnvVar(key="LONG_SECRET", value="super-secret-value", is_global=True))
        session.add(EnvVar(key="SHORT", value="abc", is_global=True))
        session.add(
            EnvVar(key="PUBLIC", value="us-east-1", is_secret=False, is_global=True)
        )
        await session.commit()
        resolved = await resolve_env(session, workspace_id=ws["id"])

    # Only long, secret values are redaction candidates: blanking a 3-character
    # value would mangle unrelated output for no security gain.
    assert "super-secret-value" in resolved.secret_values
    assert "abc" not in resolved.secret_values
    assert "us-east-1" not in resolved.secret_values
    assert len("abc") < MIN_REDACT_LENGTH

    out = redact("token=super-secret-value region=us-east-1", resolved.secret_values)
    assert out == "token=***REDACTED*** region=us-east-1"


async def test_env_var_api_write_only_secrets(client: AsyncClient):
    created = await client.post(
        "/env-vars",
        json={"key": "API_TOKEN", "value": "tok-123456789", "is_global": True},
    )
    assert created.status_code == 201
    row = created.json()
    assert row["has_value"] is True
    # A secret's value never comes back out.
    assert row["value"] is None
    assert (await client.get(f"/env-vars/{row['id']}")).json()["value"] is None

    # A non-secret var does return its value — that is what the flag is for.
    public = (
        await client.post(
            "/env-vars",
            json={"key": "REGION", "value": "eu-west-2", "is_secret": False},
        )
    ).json()
    assert public["value"] == "eu-west-2"

    # PATCH without a value keeps the stored one; "" clears it.
    patched = (
        await client.patch(
            f"/env-vars/{row['id']}", json={"description": "used by billing"}
        )
    ).json()
    assert patched["has_value"] is True and patched["description"] == "used by billing"
    cleared = (await client.patch(f"/env-vars/{row['id']}", json={"value": ""})).json()
    assert cleared["has_value"] is False


async def test_env_var_key_validation_and_layer_uniqueness(client: AsyncClient):
    ws = (await client.post("/workspaces", json={"name": "EnvUnique"})).json()
    bad = await client.post("/env-vars", json={"key": "not a var", "value": "x"})
    assert bad.status_code == 422

    assert (
        await client.post("/env-vars", json={"key": "DUPE", "is_global": True})
    ).status_code == 201
    # Same key, same layer: rejected, because precedence would be undefined.
    clash = await client.post("/env-vars", json={"key": "DUPE", "is_global": True})
    assert clash.status_code == 409

    # Same key at a *different* layer is legitimate (a workspace override).
    scoped = await client.post(
        "/env-vars", json={"key": "DUPE", "workspace_ids": [ws["id"]]}
    )
    assert scoped.status_code == 201
    # But not twice for the same workspace.
    again = await client.post(
        "/env-vars", json={"key": "DUPE", "workspace_ids": [ws["id"]]}
    )
    assert again.status_code == 409


async def test_env_var_assignment_and_resolved_view(client: AsyncClient):
    ws = (await client.post("/workspaces", json={"name": "EnvResolved"})).json()
    skill = (await client.post("/skills", json={"name": "Resolver Skill"})).json()
    var = (
        await client.post(
            "/env-vars",
            json={"key": "STRIPE_KEY", "value": "sk-live-abcdefgh", "description": "billing"},
        )
    ).json()
    # Unassigned: not in any run's environment.
    resolved = (
        await client.get("/env-vars/resolved", params={"workspace_id": ws["id"]})
    ).json()
    assert "STRIPE_KEY" not in [e["key"] for e in resolved["entries"]]

    r = await client.put(
        f"/env-vars/{var['id']}/assignment",
        json={"is_global": False, "workspace_ids": [], "skill_ids": [skill["id"]]},
    )
    assert r.status_code == 200 and r.json()["skill_ids"] == [skill["id"]]

    resolved = (
        await client.get("/env-vars/resolved", params={"workspace_id": ws["id"]})
    ).json()
    entry = next(e for e in resolved["entries"] if e["key"] == "STRIPE_KEY")
    assert entry["source"] == f"skill:{skill['slug']}"
    assert entry["description"] == "billing"
    assert entry["has_value"] is True
    # Values never appear in the resolved view, only provenance.
    assert "value" not in entry

    # The skill listing surfaces the attachment so the UI can show it.
    skill_row = (await client.get(f"/skills/{skill['id']}")).json()
    assert skill_row["env_var_ids"] == [var["id"]]

    # Filtering by skill works for the attach picker.
    by_skill = (
        await client.get("/env-vars", params={"skill_id": skill["id"]})
    ).json()
    assert [v["id"] for v in by_skill] == [var["id"]]


async def test_deleting_a_skill_drops_its_env_links(client: AsyncClient):
    skill = (await client.post("/skills", json={"name": "Doomed Skill"})).json()
    var = (
        await client.post(
            "/env-vars",
            json={"key": "DOOMED_KEY", "value": "v", "skill_ids": [skill["id"]]},
        )
    ).json()
    assert (await client.delete(f"/skills/{skill['id']}")).status_code == 204

    # The var survives (it is a first-class row) but the link is gone, so a
    # recycled skill id can never inherit another skill's secrets.
    async with async_session_factory() as session:
        assert await session.get(Skill, skill["id"]) is None
        links = (await session.execute(EnvVarSkillLink.__table__.select())).all()
    assert all(link.skill_id != skill["id"] for link in links)
    assert (await client.get(f"/env-vars/{var['id']}")).status_code == 200
