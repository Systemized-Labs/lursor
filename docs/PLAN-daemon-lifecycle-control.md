# Plan: daemon lifecycle control (Lursor side)

Status: **implemented** — companion to the authoritative plan in the laios repo:
`../laios/docs/plan-daemon-lifecycle-control.md` (read that first for the full
design, decisions, and phasing).

Implemented here:
- Backend proxy routes in `backend/app/api/laios.py`
  (`daemon/version|restart|update|update/log`); restart tolerates the daemon
  dropping the connection mid-shutdown (surfaced as `202 {restarting:true}`).
- Frontend: types in `src/api/types.ts`, hooks/client in `src/api/laios.ts`,
  a `DaemonPanel` section in the node card (`src/pages/laios/daemon-panel.tsx`)
  with version/sha/mode, check-for-updates, restart, and update, plus a live
  `UpdateLogDialog` (`src/pages/laios/update-log-dialog.tsx`).
- Tests: `backend/tests/test_laios.py::test_daemon_lifecycle_proxy`.

## Lursor's role

Lursor stays a **pure proxy** — no restart/update logic lives here. The laios
daemon gains `/v1/daemon/*` endpoints; Lursor forwards them and adds UI.

## Backend — `backend/app/api/laios.py`

Add four connection-scoped routes using the existing `_forward` helper (same
pattern as `serve` / `pull` / `instance_logs`):

- `GET  /connections/{cid}/daemon/version`      → daemon `GET /v1/daemon/version`
- `POST /connections/{cid}/daemon/restart`      → daemon `POST /v1/daemon/restart`
- `POST /connections/{cid}/daemon/update`       → daemon `POST /v1/daemon/update`
- `GET  /connections/{cid}/daemon/update/{jid}` → daemon `GET /v1/daemon/update/{jid}`

Restart is special: the daemon dies mid-request. Treat a dropped connection /
502 shortly after a `202` as expected rather than an error, so the UI can move
into a "reconnecting" state and re-probe `connection_status`.

No new schema secrets; `master_key` stays server-side as today.

## Frontend — `frontend/src/pages/laios/` + `frontend/src/api/laios.ts`

- Add API client methods for the four routes in `api/laios.ts`.
- New "Daemon" card on `laios-page.tsx`: version + git sha, an "up to date" /
  "N commits behind" badge, and **Restart** / **Update** buttons behind a
  destructive-confirm modal.
- Update streams logs via a dialog reusing `instance-logs-dialog.tsx`, polling
  `daemon/update/{job_id}`; on completion, auto-re-probe connection status and
  refresh the version badge.
- UI rules: every text element uses `text-foreground` / `text-muted-foreground`;
  no absolute colors; copy existing `pages/laios/` layout patterns.

## Phasing (mirrors the laios doc)

- Phase 0: version badge (read-only).
- Phase 1: restart button + reconnect UX.
- Phase 2: update button + live log dialog.
