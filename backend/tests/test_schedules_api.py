"""The schedules router: validation, the clock, and the occurrence preview.

The guarantee under test is the one that makes the tick loop safe to leave
running unattended: nothing the API accepts can be unparseable, so no saved row
can make every tick raise.
"""

from __future__ import annotations

from datetime import UTC, datetime

from httpx import AsyncClient


async def _targets(client: AsyncClient, name: str) -> dict[str, str]:
    agent = (await client.post("/agents", json={"name": f"{name}Agent"})).json()
    ws = (await client.post("/workspaces", json={"name": f"{name}WS"})).json()
    return {"workspace_id": ws["id"], "agent_id": agent["id"]}


def _payload(targets: dict[str, str], **overrides) -> dict:
    body = {
        **targets,
        "name": "Nightly deps",
        "cron": "0 2 * * *",
        "timezone": "UTC",
        "prompt": "check for outdated dependencies",
    }
    body.update(overrides)
    return body


async def test_create_computes_the_next_fire(client: AsyncClient):
    targets = await _targets(client, "Create")
    resp = await client.post("/schedules", json=_payload(targets))
    assert resp.status_code == 201, resp.text
    row = resp.json()
    assert row["enabled"] is True
    assert row["run_type"] == "chat"  # the cheap, bounded default
    assert row["last_run"] is None
    assert datetime.fromisoformat(row["next_fire_at"]) > datetime.now(UTC)


async def test_a_goal_schedule_defaults_its_success_criteria_to_the_prompt(
    client: AsyncClient,
):
    targets = await _targets(client, "Goalish")
    row = (
        await client.post(
            "/schedules", json=_payload(targets, run_type="goal", prompt="ship the docs")
        )
    ).json()
    # A goal run with nothing to evaluate against would never terminate cleanly.
    assert row["success_criteria"] == "ship the docs"


async def test_malformed_cron_and_unknown_timezone_are_422(client: AsyncClient):
    targets = await _targets(client, "Bad")
    bad_cron = await client.post("/schedules", json=_payload(targets, cron="* * *"))
    assert bad_cron.status_code == 422
    # The message has to say what to fix — a 422 with no reason is a 500 with a
    # nicer number.
    assert "fields" in bad_cron.text

    bad_tz = await client.post(
        "/schedules", json=_payload(targets, timezone="Mars/Olympus_Mons")
    )
    assert bad_tz.status_code == 422
    assert "IANA" in bad_tz.text

    blank_prompt = await client.post("/schedules", json=_payload(targets, prompt="   "))
    assert blank_prompt.status_code == 422

    wild_cap = await client.post(
        "/schedules", json=_payload(targets, run_type="goal", max_iterations=5000)
    )
    assert wild_cap.status_code == 422


async def test_unknown_workspace_or_agent_is_422(client: AsyncClient):
    targets = await _targets(client, "Missing")
    no_ws = await client.post(
        "/schedules", json=_payload({**targets, "workspace_id": "nope"})
    )
    assert no_ws.status_code == 422
    no_agent = await client.post(
        "/schedules", json=_payload({**targets, "agent_id": "nope"})
    )
    assert no_agent.status_code == 422


async def test_patch_recomputes_the_clock_only_when_timing_changes(client: AsyncClient):
    targets = await _targets(client, "Patch")
    row = (await client.post("/schedules", json=_payload(targets))).json()
    original = row["next_fire_at"]

    # Editing the prompt must not push tonight's run out.
    renamed = (
        await client.patch(f"/schedules/{row['id']}", json={"prompt": "different work"})
    ).json()
    assert renamed["prompt"] == "different work"
    assert renamed["next_fire_at"] == original

    # Changing the expression must.
    retimed = (
        await client.patch(f"/schedules/{row['id']}", json={"cron": "*/5 * * * *"})
    ).json()
    assert retimed["next_fire_at"] != original

    # Disabling clears it: nothing is ever due, and re-enabling can't then read as
    # a pile of missed fires.
    off = (await client.patch(f"/schedules/{row['id']}", json={"enabled": False})).json()
    assert off["next_fire_at"] is None
    back_on = (
        await client.patch(f"/schedules/{row['id']}", json={"enabled": True})
    ).json()
    assert datetime.fromisoformat(back_on["next_fire_at"]) > datetime.now(UTC)


async def test_patch_rejects_a_bad_expression_without_touching_the_row(
    client: AsyncClient,
):
    targets = await _targets(client, "Guard")
    row = (await client.post("/schedules", json=_payload(targets))).json()
    assert (
        await client.patch(f"/schedules/{row['id']}", json={"cron": "nope"})
    ).status_code == 422
    assert (await client.get(f"/schedules/{row['id']}")).json()["cron"] == "0 2 * * *"


async def test_preview_returns_upcoming_occurrences(client: AsyncClient):
    resp = await client.post(
        "/schedules/preview",
        json={"cron": "30 9 * * 1-5", "timezone": "America/New_York", "count": 5},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    occurrences = [datetime.fromisoformat(o) for o in body["occurrences"]]
    assert len(occurrences) == 5
    assert occurrences == sorted(occurrences)
    assert occurrences[0] > datetime.now(UTC)
    # 9:30am on weekdays, in New York — never a Saturday or Sunday there.
    from zoneinfo import ZoneInfo

    local = [o.astimezone(ZoneInfo("America/New_York")) for o in occurrences]
    assert all(o.weekday() < 5 for o in local)
    assert all((o.hour, o.minute) == (9, 30) for o in local)


async def test_preview_rejects_a_bad_expression(client: AsyncClient):
    resp = await client.post(
        "/schedules/preview", json={"cron": "0 99 * * *", "timezone": "UTC"}
    )
    assert resp.status_code == 422


async def test_list_filters_by_workspace(client: AsyncClient):
    a = await _targets(client, "ListA")
    b = await _targets(client, "ListB")
    await client.post("/schedules", json=_payload(a, name="A job"))
    await client.post("/schedules", json=_payload(b, name="B job"))

    only_a = (await client.get(f"/schedules?workspace_id={a['workspace_id']}")).json()
    assert [s["name"] for s in only_a] == ["A job"]
    # The suite shares one database, so assert membership rather than a total.
    all_names = {s["name"] for s in (await client.get("/schedules")).json()}
    assert {"A job", "B job"} <= all_names


async def test_delete_removes_history_but_keeps_the_conversations(
    client: AsyncClient, monkeypatch
):
    """Those transcripts are the work the schedule actually produced."""
    from sqlmodel import select

    from app.db.models import Thread
    from app.db.session import async_session_factory

    async def fake_start(session, *, thread, prompt, run_type):
        return None

    monkeypatch.setattr("app.api.chat.start_scheduled_run", fake_start)

    targets = await _targets(client, "Doomed")
    row = (await client.post("/schedules", json=_payload(targets))).json()
    # Run-now rather than a tick: a freshly created schedule is by definition *not*
    # yet due (its next fire is in the future), which is the whole point of the row.
    outcome = (await client.post(f"/schedules/{row['id']}/run-now")).json()
    assert len((await client.get(f"/schedules/{row['id']}/runs")).json()) == 1
    thread_id = outcome["thread_id"]
    # While the schedule exists, its runs carry its id — that is what marks the
    # conversation as machine-started wherever it is listed.
    before = (await client.get(f"/threads?workspace_id={targets['workspace_id']}")).json()
    assert [t["schedule_id"] for t in before] == [row["id"]]

    assert (await client.delete(f"/schedules/{row['id']}")).status_code == 204
    assert (await client.get(f"/schedules/{row['id']}")).status_code == 404
    assert (await client.get(f"/schedules/{row['id']}/runs")).status_code == 404

    # The conversation survives, as a plain one: with the schedule gone there is
    # nothing left for the marker to point at.
    assert (await client.get(f"/threads/{thread_id}")).status_code == 200
    listed = (await client.get(f"/threads?workspace_id={targets['workspace_id']}")).json()
    assert [t["id"] for t in listed] == [thread_id]
    assert listed[0]["schedule_id"] is None

    async with async_session_factory() as session:
        orphans = list(
            (
                await session.execute(
                    select(Thread).where(Thread.schedule_id == row["id"])
                )
            )
            .scalars()
            .all()
        )
    assert orphans == []


async def test_run_now_fires_without_moving_the_clock(client: AsyncClient, monkeypatch):
    async def fake_start(session, *, thread, prompt, run_type):
        return None

    monkeypatch.setattr("app.api.chat.start_scheduled_run", fake_start)

    targets = await _targets(client, "RunNow")
    row = (await client.post("/schedules", json=_payload(targets))).json()
    scheduled = row["next_fire_at"]

    resp = await client.post(f"/schedules/{row['id']}/run-now")
    assert resp.status_code == 200, resp.text
    outcome = resp.json()
    assert outcome["status"] == "launched"
    assert outcome["thread_id"]

    # A manual test shows what tonight's run will do; it must not consume the slot.
    assert (await client.get(f"/schedules/{row['id']}")).json()["next_fire_at"] == scheduled
    history = (await client.get(f"/schedules/{row['id']}/runs")).json()
    assert [h["status"] for h in history] == ["launched"]
    # ...and the listing carries that outcome inline, so the rail can flag a bad
    # last run without a request per row.
    listed = (await client.get(f"/schedules?workspace_id={targets['workspace_id']}")).json()
    assert listed[0]["last_run"]["status"] == "launched"
    assert listed[0]["last_run"]["thread_id"] == outcome["thread_id"]


async def test_run_now_409s_when_a_run_is_already_live(client: AsyncClient, monkeypatch):
    from app.agents.chat_run_manager import chat_run_manager

    async def fake_start(session, *, thread, prompt, run_type):
        # Make the launched run look live, exactly as a real in-flight one would.
        chat_run_manager._status[thread.id] = "running"

    monkeypatch.setattr("app.api.chat.start_scheduled_run", fake_start)

    targets = await _targets(client, "Busy")
    row = (await client.post("/schedules", json=_payload(targets))).json()
    first = (await client.post(f"/schedules/{row['id']}/run-now")).json()
    try:
        conflict = await client.post(f"/schedules/{row['id']}/run-now")
        assert conflict.status_code == 409
    finally:
        chat_run_manager._status.pop(first["thread_id"], None)


async def test_run_now_reports_a_launch_failure(client: AsyncClient, monkeypatch):
    async def failing_start(session, *, thread, prompt, run_type):
        raise RuntimeError("no provider key")

    monkeypatch.setattr("app.api.chat.start_scheduled_run", failing_start)

    targets = await _targets(client, "Failing")
    row = (await client.post("/schedules", json=_payload(targets))).json()
    resp = await client.post(f"/schedules/{row['id']}/run-now")
    assert resp.status_code == 502
    assert "no provider key" in resp.text
    # The attempt is still on the record, which is the point of an `error` row.
    assert (await client.get(f"/schedules/{row['id']}/runs")).json()[0]["status"] == "error"


async def test_missing_schedule_is_404(client: AsyncClient):
    assert (await client.get("/schedules/nope")).status_code == 404
    assert (await client.patch("/schedules/nope", json={"name": "x"})).status_code == 404
    assert (await client.delete("/schedules/nope")).status_code == 404
    assert (await client.post("/schedules/nope/run-now")).status_code == 404
    assert (await client.get("/schedules/nope/runs")).status_code == 404
