# Backlog — deferred with a reason

Work that was scoped, understood and then not done. Kept because the reason is the
useful part: each entry records why it was left, so it isn't re-litigated from
scratch. The short "deliberately not built" list lives in
[`AGENTS.md`](../../AGENTS.md) §8.

## Shell rewrite leftovers

The seven-phase rewrite that produced the pane layer shipped everything it set out
to except these:

- **`GET /workspaces/{id}/artifacts`.** The Artifacts pane covers plan docs and
  generated media but not agent-written files. The provenance exists per *turn* —
  a write is a `write_file` / `hashline_edit` tool call and `tool_calls` is
  persisted, which is how `agui/file-changes.ts` derives it — but there is no way
  to ask for it across a workspace. Client-side it would mean fetching every
  thread's messages: N requests for a list whose contents depend on which
  conversations you happened to open, which looks complete and is not.
- **Popout panes.** Dockview supports panes in real OS windows and it is a genuine
  Electron win (a terminal on a second monitor). Deferred because the
  absolute-overlay positioning we inherit has its sharpest edges there.
- **`Thread.pinned`.** Pins are client-side under `lursor:pins`. A column can
  follow if they need to survive a machine change — the app is reachable over the
  LAN, so that is real.
- **Rebindable shortcuts.** `lib/shortcuts.ts` is documentation, not a registry:
  nine call sites bind their own chords and the file lists them. Making them
  rebindable is when the registry has to exist, and then that file becomes its
  labels.

## laios UI backlog

The daemon has shipped features with no client surface. The Lursor side of each is
the same four layers (proxy route in `api/laios.py`, hook in `api/laios.ts`,
types, page):

- `GET /v1/models`, `GET /v1/models/{id}` — the whole model-inventory family is
  unconsumed, so the UI can't distinguish *installed on disk* from *in the
  catalog* and shows no run stats (`run_count`, `last_served_at`,
  `available_on_nodes`, `usable_recipes`, live `running_instance`).
- `GET /v1/models/partial` + `DELETE /v1/models/{id}` — reclaim orphaned or
  incomplete downloads (409 when in use).
- `POST /v1/jobs/{id}/cancel` — pull is hard-coupled to serve in
  `useServeManager.start`; there is no download-only path and no cancel.
- `EngineKind::Sglang` is missing from the frontend engine union, so sglang
  models render a broken badge and mis-classify in `serve-model-dialog.tsx`.
  Smallest of these and a real correctness bug.
- `DELETE /v1/cluster/workers/{id}` and `GET /v1/cluster/token` — the cluster
  panel is view-only; `workers[]`/`remotes[]` are typed `unknown[]`.
- Never wired: `GET /v1/metrics/summary`, `/v1/keys`, `/v1/aliases`,
  `/v1/cluster/remotes`, `POST /v1/gateway/restart`. `GET /v1/doctor` is already
  proxied by the backend with zero frontend consumers — a free diagnostics panel.

Also worth carrying upstream: `DELETE /v1/instances/{id}` exists in the daemon
and Lursor uses it, but it is absent from laios's `docs/api.md` and
`openapi.yaml`.
