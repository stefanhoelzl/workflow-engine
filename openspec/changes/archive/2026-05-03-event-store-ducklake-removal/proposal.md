## Why

DuckLake earned its keep when the event store had to live on S3 — the catalog/data-path split was the only way to get a queryable DuckDB-shaped surface over remote object storage. With S3 removed (the parent `remove-s3` branch), the event store's only durable home is a local filesystem path, where the lakehouse layout is pure overhead: a separate Parquet directory, a checkpoint loop with three thresholds, an `INSTALL ducklake; LOAD ducklake;` extension load, partition-ALTER plumbing, and a SQL composer that branches on locator kind. None of that buys anything once the only locator is `{ kind: "fs", root }`.

A plain DuckDB database file at `<PERSISTENCE_PATH>/events.duckdb` collapses the storage layer to a single file, supports `PRIMARY KEY (id, seq)` (which DuckLake forbids — promoting accumulator-based dedup from "convention" to "constraint"), and replaces the bespoke checkpoint loop with DuckDB's implicit WAL semantics (auto-checkpoint at WAL ≥ wal_autocheckpoint, fold on graceful close). Failure mode also improves: DuckDB acquires an exclusive file lock on open, so a misconfigured second writer fails fast instead of silently corrupting the catalog the way an unconditional S3 PUT did.

Observable behaviour for callers (`record`, `query`, `hasUploadEvent`, `ping`, `drainAndClose`) is unchanged. This is a backend swap, not a behaviour change.

## What Changes

- **BREAKING (operator)** — `EVENT_STORE_CHECKPOINT_INTERVAL_MS`, `EVENT_STORE_CHECKPOINT_MAX_INLINED_ROWS`, and `EVENT_STORE_CHECKPOINT_MAX_CATALOG_BYTES` env vars are removed. DuckDB manages WAL/checkpoint internally; there is no operator-tunable surface for it. `EVENT_STORE_COMMIT_*` and `EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS` remain.
- **BREAKING (operator)** — `PERSISTENCE_S3_BUCKET`, `PERSISTENCE_S3_ACCESS_KEY_ID`, `PERSISTENCE_S3_SECRET_ACCESS_KEY`, `PERSISTENCE_S3_ENDPOINT`, `PERSISTENCE_S3_REGION` are removed. `PERSISTENCE_PATH` is now mandatory (was previously one of two mutually-exclusive options).
- Replace DuckLake with plain DuckDB on disk. Database file is `<PERSISTENCE_PATH>/events.duckdb`. The `events/` Parquet directory and DuckLake catalog format go away.
- Add `PRIMARY KEY (id, seq)` and a secondary index on `(owner, repo)` to the events table. PK violations are logged as `event-store.commit-dropped` and not retried — they indicate a logic bug in pre-eviction, not a transient failure.
- Single-writer correctness becomes structurally enforced: the `infrastructure` capability already mandates exactly one Quadlet `wfe-<env>.container` unit per env on a single VPS, with sequential auto-update (stop, pull, start) of the same unit by `podman-auto-update.timer`. There is no overlap window in which two containers could hold the same data dir. DuckDB's exclusive file lock provides defence-in-depth: a misconfigured second opener would fail fast with a lock error instead of silently corrupting state (the failure mode under the prior DuckLake-on-S3 design, where unconditional PUT could overwrite a concurrent writer's catalog).
- `createEventStore` signature changes from `{ backend: StorageBackend, … }` to `{ persistenceRoot: string, … }`. EventStore joins `events.duckdb` internally and no longer consumes the `StorageBackend` abstraction.
- Delete `StorageLocator` type and the `locator()` method from `StorageBackend`. EventStore was the sole consumer.
- Delete `packages/runtime/src/storage/s3.ts` and the `createStorageBackend` S3 branch in `main.ts`. WorkflowRegistry continues to use FS-backed `StorageBackend` for upload bundles.
- Drop the DuckLake extension load (`INSTALL ducklake; LOAD ducklake;`), the `ALTER TABLE … SET PARTITIONED BY (owner, repo)` plumbing, the catalog-bytes stat helper, and the periodic CHECKPOINT timer.
- Tests: delete the S3-locator-translation test in `event-store.test.ts` and the three checkpoint-trigger tests. No new tests added — PK and cold-start behaviours rely on standard DuckDB semantics already exercised by existing integration tests.
- Migration: clean cut. Operators who upgrade from a deployment that ran the DuckLake-era event store may leave the legacy `events.duckdb` (DuckLake catalog) and `events/` Parquet directory in place; the new code creates a fresh `events.duckdb`, but does not delete the legacy artefacts. Operators choosing to reclaim disk run `rm -rf <PERSISTENCE_PATH>/events.duckdb <PERSISTENCE_PATH>/events/` before first boot under the new code.
- `SECURITY.md` already lost the "silent catalog corruption" wording in the 2026-05-02 VPS migration. Verify nothing K8s-flavoured remains in the single-writer framing; if so, retire it. `infrastructure` capability is unchanged: the existing requirements ("Quadlet units for caddy, wfe-prod, wfe-staging" and per-env `/srv/wfe/<env>:/data` bind mounts) already encode the deployment shape this change depends on.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `event-store`: backend swap from DuckLake to plain DuckDB. Schema gains `PRIMARY KEY (id, seq)` and a secondary index on `(owner, repo)`. Checkpoint requirement removed. `record`/`query`/`hasUploadEvent`/`ping`/`drainAndClose` surface unchanged.
- `runtime-config`: delta — three `EVENT_STORE_CHECKPOINT_*` env vars removed; five `PERSISTENCE_S3_*` env vars removed; `PERSISTENCE_PATH` becomes mandatory.
- `storage-backend`: delta — `StorageLocator` type and `locator()` method removed from the interface. The S3 backend variant (`packages/runtime/src/storage/s3.ts`) is deleted. Remaining surface (`init`, `read`, `write`, `list`) is unchanged.

## Impact

- **Code**: rewrite `packages/runtime/src/event-store.ts` against `@duckdb/node-api` directly (no `ducklake` extension); update `packages/runtime/src/storage/index.ts` (delete locator type/method); delete `packages/runtime/src/storage/s3.ts`; rewire `packages/runtime/src/main.ts` to require `PERSISTENCE_PATH` and pass it directly to `createEventStore`; trim `packages/runtime/src/config.ts` (drop S3 env vars and the mutual-exclusion refine); update `packages/runtime/src/test-utils/event-store.ts` to the new factory shape.
- **Dependencies**: no version bump. `@duckdb/node-api` and `@duckdb/node-bindings` already vendored. Remove the runtime `INSTALL ducklake; LOAD ducklake;` calls.
- **Infrastructure**: no spec change. Operator-facing change: drop S3-related Helm/compose values; ensure `PERSISTENCE_PATH` is set. Infra modules (s2, UpCloud bucket plumbing) cleanup is out of scope for this change — separate follow-up.
- **Tests**: drop `S3 backend translates locator into DuckLake SECRET` test, drop the three `Background CHECKPOINT` trigger tests in `packages/runtime/src/event-store.test.ts`. Existing cold-start, drain, and commit-retry tests should pass with minimal updates (factory call shape, env var names).
- **Docs**: update `SECURITY.md` single-writer wording (silent corruption → fail-fast); update `docs/upgrades.md` with the env-var deletions and optional legacy-artefact cleanup; update `CLAUDE.md` if it references DuckLake (likely already pruned by the parent branch).
- **Behaviour**: no observable change for `record`/`query`/`hasUploadEvent`/`ping`. Cold start now bounded by DuckDB file open + WAL replay (typically faster than DuckLake catalog attach). SIGKILL durability profile unchanged: in-flight invocations lost, committed terminals preserved via DuckDB WAL.
