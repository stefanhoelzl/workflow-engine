# Tasks

## 1. Schema and DDL

- [x] 1.1 Update `CREATE TABLE` DDL in `packages/runtime/src/event-store.ts` to declare `PRIMARY KEY (id, seq)`.
- [x] 1.2 Add `CREATE INDEX IF NOT EXISTS events_owner_repo_idx ON events (owner, repo)` after the table create.
- [x] 1.3 Remove `SET_PARTITIONED_DDL` and the `try/catch` around the partition ALTER.
- [x] 1.4 Drop the schema scoping (`withSchema("event_store")`, `USE event_store`) — table lives in the default `main` schema of a plain DuckDB file.

## 2. Connection & extension

- [x] 2.1 Remove `INSTALL ducklake; LOAD ducklake;` from the boot sequence.
- [x] 2.2 Remove the `INSTALL httpfs; LOAD httpfs;` branch (S3 path is gone).
- [x] 2.3 Replace `DuckDBInstance.create()` (in-memory) with `DuckDBInstance.create(<persistenceRoot>/events.duckdb)` so the connection is bound to a file.
- [x] 2.4 Delete `composeAttachSql` and the `prelude/attach/catalogPath` flow. No `ATTACH 'ducklake:…'` remains.

## 3. Factory signature

- [x] 3.1 Change `EventStoreOptions` from `{ backend: StorageBackend, … }` to `{ persistenceRoot: string, … }`.
- [x] 3.2 Update `packages/runtime/src/main.ts` to require `PERSISTENCE_PATH` and pass it to `createEventStore` as `persistenceRoot`. Drop the `createStorageBackend` helper's S3 branch.
- [x] 3.3 Update `packages/runtime/src/test-utils/event-store.ts` to construct EventStore against a tmpdir path instead of a `createFsStorage` backend.
- [x] 3.4 Update any other call site (search `createEventStore`).

## 4. Storage backend cleanup

- [x] 4.1 Delete `packages/runtime/src/storage/s3.ts`.
- [x] 4.2 Remove `StorageLocator` type from `packages/runtime/src/storage/index.ts`.
- [x] 4.3 Remove the `locator(): StorageLocator` method from the `StorageBackend` interface.
- [x] 4.4 Remove `locator()` implementation from `packages/runtime/src/storage/fs.ts`.
- [x] 4.5 Verify no remaining import of `StorageLocator` or call to `.locator()` (`grep -rn "locator\\|StorageLocator" packages/`).

## 5. Config cleanup

- [x] 5.1 In `packages/runtime/src/config.ts`, delete the five `PERSISTENCE_S3_*` env vars and the two `.refine` rules that govern their interaction with `PERSISTENCE_PATH`. Make `PERSISTENCE_PATH` mandatory.
- [x] 5.2 In `packages/runtime/src/config.ts`, delete `EVENT_STORE_CHECKPOINT_INTERVAL_MS`, `EVENT_STORE_CHECKPOINT_MAX_INLINED_ROWS`, `EVENT_STORE_CHECKPOINT_MAX_CATALOG_BYTES`. Update `EventStoreConfig` interface accordingly.
- [x] 5.3 Update `packages/runtime/src/config.test.ts` to remove cases for the deleted vars and the mutual-exclusion refine.

## 6. Commit and retry

- [x] 6.1 In the commit-retry loop, classify errors: PK violation → `event-store.commit-dropped { reason: "primary-key-violation", id, owner, repo, error }`, no retry, evict accumulator entry, return false. All other errors take the existing exponential-backoff path.
- [x] 6.2 The classifier inspects the DuckDB error message/code for "PRIMARY KEY" / constraint conflict. If DuckDB exposes a typed error class via `@duckdb/node-api`, prefer that.

## 7. Checkpoint loop removal

- [x] 7.1 Delete `maybeCheckpoint`, `getCatalogBytes`, `describeTrigger`, `nextCheckpointAt`, `inlinedRowsApprox`, `checkpointTimer`, `setInterval(...)` block.
- [x] 7.2 Remove the `await maybeCheckpoint()` call from the terminal-event branch of `record`.
- [x] 7.3 Remove the explicit `CHECKPOINT;` in `drainAndClose()`. `db.destroy()` triggers DuckDB's close-time checkpoint.

## 8. Tests

- [x] 8.1 Delete the `S3 backend translates locator into DuckLake SECRET` test in `packages/runtime/src/event-store.test.ts`.
- [x] 8.2 Delete the three checkpoint-trigger tests (timer-driven, threshold-driven, skip-when-no-work).
- [x] 8.3 Update remaining tests to construct EventStore against a tmpdir path (Task 3.3 covers the helper).
- [x] 8.4 `pnpm validate` passes (`lint`, `check`, `test`, `tofu fmt -check`, `tofu validate`).
- [x] 8.5 `pnpm test:e2e` passes on the canonical demo flow (run before pushing per CLAUDE.md guidance — touches runtime spawn).

## 9. Spec updates

- [x] 9.1 Apply the deltas under `openspec/changes/event-store-ducklake-removal/specs/event-store/spec.md` to `openspec/specs/event-store/spec.md`. (Handled at archive-time by `openspec archive`, not now — this task is a placeholder for the archive step.)

## 10. Docs

- [x] 10.1 Verify `SECURITY.md` no longer carries any K8s-era single-writer wording (`grep -ni "silently corrupt\|replicas: 1\|strategy: Recreate\|If-Match" SECURITY.md`). The 2026-05-02 VPS migration removed "silently corrupt"; if any K8s phrasing survives elsewhere in the single-writer / A15 sections, retire it. Otherwise no edit.
- [x] 10.2 Add a new entry to `docs/upgrades.md`: `event-store-ducklake-removal (2026-05-03)`. Cover (a) `PERSISTENCE_S3_*` env vars removed (already absent from the running deployment per the VPS migration; this is a code-side cleanup); (b) three `EVENT_STORE_CHECKPOINT_*` env vars removed; (c) optional cleanup of legacy DuckLake artefacts on the VPS data dir: `rm /srv/wfe/<env>/events.duckdb && rm -rf /srv/wfe/<env>/events/`. Leave the May 1 DuckLake entry alone (it's history).
- [x] 10.3 If `CLAUDE.md` or `openspec/project.md` references DuckLake (search `grep -ni ducklake CLAUDE.md openspec/project.md`), update to plain DuckDB.

## 11. Local-dev verification

- [x] 11.1 `pnpm dev --random-port --kill` boots; grep stdout for `Dev ready on http://localhost:<port>`.
- [x] 11.2 Trigger the canonical demo HTTP trigger; `curl http://localhost:<port>/webhooks/local/demo/greet` returns 200.
- [x] 11.3 Verify `<.persistence>/events.duckdb` exists and has non-zero size after a successful invocation.
- [x] 11.4 Verify no `<.persistence>/events/` Parquet directory is created.
- [x] 11.5 Hit dashboard `/dashboard/local/demo` — invocation appears in the list.
- [x] 11.6 SIGTERM the dev process, restart, hit the dashboard again — prior invocation still listed (cold-start over WAL).
- [x] 11.7 With `pnpm dev` running, attempt to start a second `pnpm dev` against the same `.persistence/`. The second process SHALL fail fast with a DuckDB lock error and exit non-zero; the first process SHALL keep serving. Confirms the "Second writer fails fast on file lock" scenario.
