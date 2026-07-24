# PLAN: laios feature sync for the Lursor UI

Status: **Draft — for review**
Scope: bring the Lursor "LAIOS" UI up to date with features that shipped in the
`laios` daemon but have no client surface yet.

## Context

Lursor is the **application plane**; laios is the **control plane**. The Lursor
backend (`backend/app/api/laios.py`) is a thin authenticated proxy that holds the
`master_key` server-side and forwards to the daemon's `/v1/*` API on `:7420`. The
frontend drives everything through connection-scoped routes under `/api/laios`.

Today the UI only consumes two views of the daemon: **recipes** (`/v1/catalog`)
and **live instances** (`/v1/instances`). Several recent laios ships surfaced new
data in the **model inventory** (`/v1/models`) and **cluster** APIs that the UI
never reads.

## Already covered (no work needed)

| laios feature | UI status |
|---|---|
| #30 remote mgmt (`/v1/daemon/*`) | Done — `frontend/src/pages/laios/daemon-dialog.tsx` |
| #29 live download progress (`bytes_done`/`bytes_total`) | Done — `DownloadTile` + `useServeManager` (`frontend/src/api/laios.ts:522-669`) |
| #12 cluster resources (`ClusterResources`/`NodeResources`) | Done — `ClusterPanel`/`VramBar` (`laios-page.tsx:1032`, `:845`) |
| #31 serve async + fabric | Mostly — UI already polls `/v1/instances`; fabric is daemon-side only |

## Gaps to close

### Tier 1 — new features, high value

1. **Model inventory + run stats (#36).** The whole `/v1/models` family is
   unconsumed. It exposes per-model `run_count`, `last_served_at`,
   `last_max_model_len`, `last_node_id`, `installed`, `bytes_total`,
   `available_on_nodes[]`, `usable_recipes[]`, and live `running_instance`.
   The UI currently cannot distinguish *installed on disk* from *in the catalog*,
   and shows no usage history.
   - laios: `GET /v1/models`, `GET /v1/models/{id}` (`crates/laios-daemon/src/api.rs:335,400`);
     `ModelSummary` at `api.rs:301-333`; `ManifestRunStats` at
     `crates/laios-core/src/model_registry.rs:59-76`.

2. **Download / disk management (#35).**
   - `GET /v1/models/partial` — orphaned/incomplete downloads with a
     `looks_complete` flag (`api.rs:379`, `OrphanedModelDir` at
     `model_registry.rs:471-477`).
   - `DELETE /v1/models/{id}` — reclaim disk; accepts a recipe id **or** a raw
     dir name; 409 (`conflict`) if in use (`api.rs:391`).
   - `POST /v1/jobs/{id}/cancel` — cancel an in-flight pull (`api.rs:576`).
   - In Lursor, pull is hard-coupled to serve in `useServeManager.start`
     (`frontend/src/api/laios.ts:584`) — there is no download-only or
     delete-weights flow, and no cancel.

3. **sglang engine (commit `0f1533c`).** New `EngineKind::Sglang` now appears in
   catalog/models/instances (`crates/laios-core/src/recipe.rs:15-31`, serde
   `sglang`/alias `sgl`). Lursor's `LaiosInstance.engine` union is only
   `vllm|llamacpp|ollama` (`frontend/src/api/types.ts:490-669`), so sglang models
   render with a broken engine badge and mis-classify in
   `serve-model-dialog.tsx` (`classify()` :64). Small but a real correctness bug.

4. **Worker management (#37).** Cluster panel is view-only.
   - `DELETE /v1/cluster/workers/{id}` — remove stale worker; 409 if an active
     instance is placed there (`api.rs:873`, `app.rs:1300`).
   - `GET /v1/cluster/token` — join token (`api.rs:900`).
   - `LaiosClusterStatus.workers`/`remotes`/`join_token_set` are typed as
     `unknown[]`/unused in `types.ts:591-600`.

### Tier 2 — endpoints never wired (adjacent, lower priority)

- `GET /v1/metrics/summary` — request counts, tokens, tok/s, uptime per served
  model (`api.rs:450`, shape at `api.rs:497-516`).
- `GET /v1/doctor` — **already proxied** by the backend (`backend/app/api/laios.py:448`)
  but has zero frontend consumers. A free diagnostics panel.
- `/v1/keys` (virtual keys/tenants), `/v1/aliases` (model aliases),
  `/v1/cluster/remotes` (remote routes), `POST /v1/gateway/restart`.

## Contract note to flag back to laios

`DELETE /v1/instances/{id}` exists in daemon code (`api.rs:53,685`) and is already
used by Lursor, but it is **absent from `laios/docs/api.md` and
`laios/docs/openapi.yaml`**. Worth getting the contract documented upstream.

## Implementation plan

Every item touches the same layers:
- proxy route — `backend/app/api/laios.py`
- client + React Query hook — `frontend/src/api/laios.ts`
- types — `frontend/src/api/types.ts`
- UI — `frontend/src/pages/laios/`

**Step 0 — sglang fix (tiny, do first).** Add `"sglang"` to the engine union in
`types.ts` and to the engine-badge / `classify()` maps in `serve-model-dialog.tsx`
and `laios-page.tsx`.

**Step 1 — Model inventory panel.** Proxy `GET /v1/models`, `GET /v1/models/{id}`,
`DELETE /v1/models/{id}`, `GET /v1/models/partial`; add `LaiosModel` /
`LaiosOrphanedModel` types + hooks; add an "Installed models" section to
`laios-page.tsx` showing installed state, on-disk size, run stats
(count / last-served / last context / last node) and `available_on_nodes`, with a
delete-weights action (handle 409). Fold `/v1/models/partial` in as a "reclaim
incomplete downloads" list.

**Step 2 — Download management.** Add cancel to `useServeManager`
(`POST /v1/jobs/{id}/cancel`); optionally add a download-only path decoupled from
serve.

**Step 3 — Worker management.** Wire `DELETE /v1/cluster/workers/{id}` into
`ClusterNodeRow` (remove button + 409 handling); surface the join token via
`GET /v1/cluster/token`; properly type `workers[]`/`remotes[]` in `types.ts`.

**Step 4 (optional) — Diagnostics + metrics.** A doctor panel (backend already
proxies `/v1/doctor`) and a metrics-summary strip on instance cards.

## Suggested first PR

**Steps 0–1** (sglang + model inventory / run stats). Largest genuinely-new
surface, delivers the #36 and #35 features users will notice most.

## Reference: laios data models / enums the UI must handle

- `InstanceStatus`: `pending, pulling, starting, running, stopping, stopped, failed`
  (`crates/laios-core/src/instance.rs:9-19`).
- `JobStatus`: `queued, running, succeeded, failed, cancelled` (`job.rs:13-21`).
- `WorkerStatus`: `joining, ready, busy, unhealthy, offline` (`cluster.rs:28-36`).
- `EngineKind`: `vllm, sglang, llamacpp, ollama` (`recipe.rs:10-31`).
- Stable error codes incl. `conflict`, `insufficient_vram`, `instance_not_found`,
  `job_not_found` (`crates/laios-core/src/error.rs:76-99`); HTTP mapping at
  `crates/laios-daemon/src/api.rs:1342-1357`.
