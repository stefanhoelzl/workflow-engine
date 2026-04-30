## Why

The current archive layer does not scale: every completed invocation writes one `archive/{id}.json` file, and at boot the EventStore re-reads each file in turn to rebuild its in-memory DuckDB index. With many archived invocations on S3, cold start grows linearly in N (one S3 GET per file) and every event ever recorded must be held in RAM. Replacing the per-invocation JSON archive with a [DuckLake](https://ducklake.select/) lakehouse (DuckDB catalog + Parquet on S3, v1.0 production-ready since April 2026) gives constant-time boot, RAM bounded by the query working set, and full history queryable forever via the same Kysely-over-DuckDB surface the dashboard already uses.

Folding the durability boundary into a single `EventStore` consumer also eliminates two consumers (`persistence`, `logging-consumer`) and the entire bus / recovery scaffolding that exists to coordinate them. The simpler design accepts a deliberate durability regression: in-flight events live in RAM until terminal, so SIGKILL loses any invocations that are mid-flight (SIGTERM still drains gracefully). This trade is acceptable because invocations are short-lived in this system and per-event durability is no longer worth the per-event S3 PUT it requires.

## What Changes

- **BREAKING** — Remove the per-event `pending/{id}/{seq}.json` durability layer and the per-invocation `archive/{id}.json` rollup. Replace both with one `EventStore` consumer that buffers events in memory per invocation and commits the whole event list as a single DuckLake transaction on the terminal event. Hard cutover wipes legacy `archive/` and `pending/` artefacts on first deploy.
- **BREAKING** — On SIGKILL or process death, any in-flight invocations are lost (no per-event WAL anymore). SIGTERM still drains: the runtime completes in-flight invocations or synthesises `trigger.error{reason: "shutdown"}` and commits each before exit.
- **BREAKING** — Dashboard shows invocations only after they reach a terminal event. There is no live-progress view of in-flight invocations.
- Adopt DuckLake v1.0 as the archive format. Catalog is a DuckDB file at `<root>/events.duckdb`, downloaded to local working copy at boot and PUT back on each commit. Data files are partitioned Parquet at `<root>/events/owner=<owner>/repo=<repo>/*.parquet` (`PARTITION BY (owner, repo)`).
- Background `CHECKPOINT` runs in the runtime on a timer (default hourly) plus size and inlined-row thresholds. Snapshots expire on every CHECKPOINT (no time-travel retention). Configurable via new `EVENT_STORE_*` env vars.
- DuckLake commit failures retry with exponential backoff (default 5 attempts, ~30s total) and on exhaustion log `event-store.commit-dropped` and evict the invocation from memory. The runtime continues.
- Single-writer correctness depends on the Kubernetes manifest, not on runtime fencing: `replicas: 1`, `strategy: Recreate`, `terminationGracePeriodSeconds: 90`, no HPA. The catalog round-trip uses an unconditional PUT (S2 and UpCloud Object Storage do not implement `If-Match`); the deployment shape is the only fence.
- **BREAKING** — Merge `persistence` and `event-store` and `logging-consumer` into a single `EventStore` component. Delete the bus abstraction (only one consumer remains and it owns its own retry/fatal-exit policy). Delete the recovery scan path (no `pending/` to reconcile, no archive-cleanup case). The executor takes over emission of `invocation.started` / `invocation.completed` / `invocation.failed` lifecycle log lines.
- Trim `StorageBackend` to the methods that have remaining callers after the deletions: `init`, `write`, `read`, `list`, plus a new `locator(): StorageLocator` that exposes the backend's concrete connection so EventStore can configure DuckLake's `ATTACH` and `CREATE SECRET` SQL. The byte variants take the names `read` / `write`; the legacy string-and-bytes split is gone.
- Delete `scripts/prune-legacy-storage.ts` (one-shot tool from a prior migration that operates on prefixes this change retires).

## Capabilities

### New Capabilities

None. All work is rewrites, deltas, and removals of existing capabilities.

### Modified Capabilities

- `event-store`: full rewrite — DuckLake-backed durable archive that absorbs the persistence consumer's role, owns the SIGTERM drain, the bounded retry-then-drop commit policy, the background CHECKPOINT loop, and the catalog round-trip. The Kysely query surface (`query`, `hasUploadEvent`, `ping`) is preserved.
- `event-bus`: removed — only one consumer remains and the strict-vs-best-effort tier policy collapses with it.
- `persistence`: removed — folded into the rewritten `event-store`.
- `recovery`: removed — there is no longer any pending/orphan state to reconcile at boot.
- `logging-consumer`: removed — the `invocation.started`/`completed`/`failed` log lines move to the executor, which already discriminates on `event.kind` for metadata stamping.
- `invocations`: delta — codify that the executor emits the lifecycle log lines on `trigger.request` / `trigger.response` / `trigger.error`.
- `storage-backend`: delta — interface trims to five methods, byte-variant rename, addition of `locator(): StorageLocator`.
- `runtime-config`: delta — six new `EVENT_STORE_*` env vars (checkpoint interval / thresholds, commit retries / backoff, SIGTERM flush timeout).
- `infrastructure`: delta — runtime Deployment is locked to `replicas: 1` with `strategy: Recreate` and `terminationGracePeriodSeconds: 90`; no HPA. This is correctness-load-bearing.
- `health-endpoints`: delta — drop the storage-backend write/read/list sentinel (no caller for `read`/`write` string variants); `/readyz` keeps `eventStore.ping()`.
- `e2e-test-framework`: delta — replace test #2 (`SIGKILL crash recovery (engine_crashed)`) with a new "cold start from DuckLake catalog" test, since the `engine_crashed` synthetic terminal no longer exists; rewrite test #3 (`Graceful SIGTERM drain`) to assert the new `trigger.error{kind:"shutdown"}` shape; add test #21 (`CHECKPOINT survives restart`).

## Impact

- **Code**: rewrite `packages/runtime/src/event-bus/event-store.ts` and promote it to `packages/runtime/src/event-store.ts`; delete the rest of `packages/runtime/src/event-bus/` (`index.ts`, `persistence.ts`, `logging-consumer.ts` plus tests); delete `packages/runtime/src/recovery.ts`; add `packages/runtime/src/executor/log-lifecycle.ts`; rewire `packages/runtime/src/main.ts` and `packages/runtime/src/executor/index.ts`. Trim `packages/runtime/src/storage/{index,fs,s3}.ts` and consume `locator()` in EventStore. Update `packages/runtime/src/health.ts`, `packages/runtime/src/config.ts`, and `packages/runtime/src/workflow-registry.ts` (`writeBytes`→`write`, `readBytes`→`read`).
- **Dependencies**: bump `@duckdb/node-api` and `@duckdb/node-bindings` from `1.5.1-r.1` to `1.5.2-r.1` (DuckLake requires DuckDB 1.5.2+); load the DuckLake DuckDB extension at runtime via `INSTALL ducklake; LOAD ducklake;`.
- **Infrastructure**: lock down the runtime Deployment manifest (`replicas: 1`, `strategy: Recreate`, `terminationGracePeriodSeconds: 90`, no HPA / PDB tolerating > 1 replica).
- **Tests**: delete `packages/tests/test/02-sigkill-recovery.test.ts`; rewrite `03-sigterm-drain.test.ts` for the new drain semantics; add `07-cold-start-from-catalog.test.ts` and `08-checkpoint-survives-restart.test.ts`.
- **Scripts**: delete `scripts/prune-legacy-storage.ts`.
- **Docs**: hard-cutover steps and the new SIGKILL durability profile in `docs/upgrades.md`; replace the archive-bootstrap probe in `docs/dev-probes.md` with a catalog round-trip probe.
- **Behaviour**: brief 60–90 s write-availability gap on every deploy (was already present, possibly slightly longer with the bumped grace period). Webhook senders that retry on 5xx (GitHub, Stripe) absorb the gap transparently.
