## 1. Storage backend trim & locator

- [x] 1.1 Add `StorageLocator` discriminated-union type to `packages/runtime/src/storage/index.ts`; export type
- [x] 1.2 Trim `StorageBackend` interface to `init`, `write` (Uint8Array), `read` (Uint8Array), `list`, `locator`; remove `writeBytes`/`readBytes` (collapsed into byte-only `read`/`write`), `remove`, `removePrefix`, `move`, and the string-variant `read`/`write`
- [x] 1.3 Update `packages/runtime/src/storage/fs.ts`: implement `locator()`, drop the removed methods, keep atomic write-then-rename for the byte-variant `write`
- [x] 1.4 Update `packages/runtime/src/storage/s3.ts`: implement `locator()` (returns `Secret`-wrapped credentials), drop the removed methods, keep `PutObject` / `GetObject` / `ListObjectsV2` paths
- [x] 1.5 Update `packages/runtime/src/workflow-registry.ts`: rename `backend.writeBytes(...)` → `backend.write(...)` at line 817 and `storageBackend.readBytes(...)` → `storageBackend.read(...)` at line 950
- [x] 1.6 Update unit tests under `packages/runtime/src/storage/` for the trimmed interface; add tests for `locator()` for both FS and S3 implementations

## 2. Add DuckLake extension and helper

- [x] 2.0 Bump `@duckdb/node-api` and `@duckdb/node-bindings` from `1.5.1-r.1` to `1.5.2-r.1` in `packages/runtime/package.json`; run `pnpm install`. (DuckLake requires DuckDB 1.5.2+.)
- [x] 2.1 Add `INSTALL ducklake; LOAD ducklake;` at the start of EventStore's DuckDB connection setup
- [x] 2.2 Implement an internal helper `composeDuckLakeAttachSql(locator: StorageLocator)` that returns the `CREATE SECRET` (S3 only) and `ATTACH 'ducklake:…'` statements with the right `DATA_PATH`; covered by unit test in 1.6 or alongside the EventStore module
- [x] 2.3 Verify DuckLake catalog and partition layout match the spec (`<root>/events.duckdb` + `<root>/events/main/events/owner=<owner>/repo=<repo>/`) for both FS and S3 backends in a smoke test
- [x] 2.4 Verify the events table is created **without** `PRIMARY KEY` (DuckLake rejects PK/UNIQUE constraints with `Not implemented Error: PRIMARY KEY/UNIQUE constraints are not supported in DuckLake`)

## 3. EventStore rewrite (durable archive layer)

- [x] 3.1 Move `packages/runtime/src/event-bus/event-store.ts` to `packages/runtime/src/event-store.ts` and rewrite for DuckLake; delete the `event-bus/` directory entirely (after task 6 deletes the rest of it)
- [x] 3.2 Implement `createEventStore({ backend, logger, config })` factory that ATTACHes the DuckLake catalog and creates the `events` table with `PARTITION BY (owner, repo)` and primary key `(id, seq)` if it does not yet exist
- [x] 3.3 Implement `record(event)`: append to `Map<id, Event[]>` accumulator; on terminal kinds (`trigger.response`, `trigger.error`) commit the full event list as one DuckLake transaction
- [x] 3.4 Implement bounded retry-then-drop policy (`EVENT_STORE_COMMIT_MAX_RETRIES`, `EVENT_STORE_COMMIT_BACKOFF_MS`); emit `event-store.commit-ok` / `commit-retry` / `commit-dropped` log lines
- [x] 3.5 Implement background `CHECKPOINT` timer with thresholds (`EVENT_STORE_CHECKPOINT_INTERVAL_MS`, `EVENT_STORE_CHECKPOINT_MAX_INLINED_ROWS`, `EVENT_STORE_CHECKPOINT_MAX_CATALOG_BYTES`); expire snapshots on every checkpoint; emit `event-store.checkpoint-run` / `checkpoint-skip` log lines
- [x] 3.6 Implement SIGTERM drain: on signal, stop accepting new `record` calls, synthesise `trigger.error{reason:"shutdown"}` for each in-flight invocation, commit each, then `dispose()`. Bound by `EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS`; log `event-store.sigterm-drain-timeout` if it expires before the accumulator empties
- [x] 3.7 Preserve `query(scopes)`, `hasUploadEvent(...)`, `ping()`, `with(name, fn)`, `sql` re-export from `kysely`; ensure call sites in `auth/scopes.ts`, `dashboard/middleware.ts`, `api/upload.ts`, `health.ts` compile after the import-path move
- [x] 3.8 Unit tests: terminal commit success / retry / drop; CHECKPOINT triggers (timer, inlined rows, catalog size); SIGTERM drain commits in-flight as `trigger.error{shutdown}`; query scope-allow-list non-empty enforcement; `hasUploadEvent` truth table — 15 tests in `packages/runtime/src/event-store.test.ts`

## 4. Add EVENT_STORE_* config fields

- [x] 4.1 Add the six `EVENT_STORE_*` env vars to the Zod schema in `packages/runtime/src/config.ts` with the documented defaults; annotate each with the existing `// biome-ignore lint/style/useNamingConvention: env var name` comment
- [x] 4.2 Pipe the parsed config into `createEventStore({ ..., config })` from `main.ts`
- [x] 4.3 Unit tests: defaults applied when env vars are unset; explicit override works; non-numeric values fail Zod parsing with a field-naming error — 4 tests added to `packages/runtime/src/config.test.ts`

## 5. Executor lifecycle log emission

- [x] 5.1 Create `packages/runtime/src/executor/log-lifecycle.ts` exporting `logInvocationLifecycle(event, logger)`; preserve the kind-discriminated emission shape from the deleted `event-bus/logging-consumer.ts` (`info("invocation.started"|"completed", ...)`, `error("invocation.failed", ...)`); wrap in try/catch with `console.error` fallback
- [x] 5.2 Wire `logInvocationLifecycle` into `executor/index.ts`'s `onEvent` widener — call it after `await eventStore.record(widened)` resolves, so a logged lifecycle line implies an accumulator-or-DuckLake state transition
- [x] 5.3 Update the executor factory signature to take `eventStore: EventStore, logger: Logger` (replacing `bus: EventBus`)
- [x] 5.4 Unit tests: each kind produces the expected log line + level; action/system kinds produce no lifecycle line; logger throw is swallowed — 7 tests in `packages/runtime/src/executor/log-lifecycle.test.ts`

## 6. Delete dead code

- [x] 6.1 Delete `packages/runtime/src/event-bus/index.ts` and `index.test.ts`
- [x] 6.2 Delete `packages/runtime/src/event-bus/persistence.ts` and `persistence.test.ts`
- [x] 6.3 Delete `packages/runtime/src/event-bus/logging-consumer.ts` and `logging-consumer.test.ts`
- [x] 6.4 Delete the `packages/runtime/src/event-bus/` directory after files above are gone (the EventStore move in 3.1 emptied it)
- [x] 6.5 Delete `packages/runtime/src/recovery.ts` and any associated test file
- [x] 6.6 Delete `scripts/prune-legacy-storage.ts`
- [x] 6.7 Drop the `eventStore` import-path migration: update every import of `event-bus/event-store` to the promoted `event-store` path
- [x] 6.8 Drop the `pending/` `list` call and string-variant `write`/`read` sentinel logic from `packages/runtime/src/health.ts`; remove the persistence:write / persistence:read / persistence:list checks from `CHECK_MAP`
- [x] 6.9 Update `packages/runtime/src/main.ts`: remove `createPersistence`, `createLoggingConsumer`, `createEventBus`, `recover` calls and imports; wire `createEventStore` directly; pass `eventStore` + `logger` to `createExecutor`

## 7. E2E and integration tests

- [x] 7.1 Delete `packages/tests/test/02-sigkill-recovery.test.ts`
- [x] 7.2 Rewrite `packages/tests/test/03-sigterm-drain.test.ts` for the new drain semantics: in-flight invocation receives a synthesised `trigger.error{reason:"shutdown"}` terminal and is queryable after a fresh boot
- [x] 7.3 Add `packages/tests/test/07-cold-start-from-catalog.test.ts`: fire N invocations, terminate gracefully, restart, assert all N still queryable; also assert boot time stays sub-second irrespective of N (regression guard against ever scanning per-invocation files)
- [x] 7.4 Add `packages/tests/test/08-checkpoint-survives-restart.test.ts`: lower `EVENT_STORE_CHECKPOINT_MAX_INLINED_ROWS` to a small number, fire enough invocations to trip it, assert `events/owner=…/...parquet` files appear, restart, assert all events still queryable

## 8. Infrastructure manifest lock-down

- [x] 8.1 Edit `infrastructure/modules/app-instance/workloads.tf` (or wherever the app `kubernetes_deployment_v1` lives) to set `spec.strategy.type = "Recreate"` and `spec.template.spec.terminationGracePeriodSeconds = 90`; verify `replicas = 1` is unchanged
- [x] 8.2 Confirm there is no HPA or PDB allowing > 1 replica in the prod and staging composition roots
- [x] 8.3 Run `tofu fmt -check` and `tofu validate` for every infrastructure env (this is part of `pnpm validate`)
- [x] 8.4 Update `docs/infrastructure.md` if any operator-facing deploy step changes; the proposal does not require new operator actions beyond the manifest update and the cutover wipe

## 9. Documentation

- [x] 9.1 Update `docs/upgrades.md`: add a section for this cutover documenting (a) the hard wipe of `archive/` and `pending/` (FS: `rm -rf …`; S3: `aws s3 rm … --recursive`), (b) the bucket-versioning enablement on prod, (c) the new SIGKILL durability profile (in-flight invocations are lost on unclean termination), (d) the manifest lock-down requirement (`replicas: 1`, `Recreate`, `terminationGracePeriodSeconds: 90`)
- [x] 9.2 Update `SECURITY.md`: add notes that single-writer is a deployment contract (catalog corruption on `replicas > 1`) and that retry-exhausted commit drops silently lose history (observable via `event-store.commit-dropped` log line)
- [x] 9.3 Update `docs/dev-probes.md`: replace the archive-bootstrap probe with a catalog-round-trip probe (fire a manual trigger, observe `event-store.commit-ok` log line, assert `<root>/events.duckdb` exists)
- [x] 9.4 Update `CLAUDE.md` if the `## Dev verification` or `## Definition of Done` sections need any adjustment for the new EVENT_STORE_* env vars or the deleted scripts/tests

## 10. Validation

- [x] 10.1 Run `pnpm validate` (lint + check + test + tofu fmt/validate); resolve any failures — **green**: 1332/1332 unit tests, lint clean, typecheck clean, all 5 tofu envs valid
- [x] 10.2 Run `pnpm test:e2e` locally; verify the deletion of 02-sigkill-recovery, the rewrite of 03-sigterm-drain, plus the new 02-cold-start-from-catalog and 21-checkpoint-survives-restart, all pass — **green**: 23/23 tests pass (21 files, includes the rewritten 03 and the 2 new tests)
- [x] 10.3 Run `pnpm dev` end-to-end: confirm catalog round-trip via dev probes from 9.3 — **verified**: `pnpm dev --random-port --kill` boots, auto-uploads demo + demo-advanced, `event-store.commit-ok` log lines appear per terminal, `/webhooks/local/demo/demo/ping` returns the full demo result with HTTP 200, `.persistence/events.duckdb` is created, post-shutdown read-only ATTACH against the catalog returns the expected events table; live read while runtime is alive is blocked by DuckDB's exclusive file lock — this is documented in `docs/dev-probes.md`
- [x] 10.4 Run `pnpm exec openspec validate event-store-ducklake --strict`; resolve any spec-shape issues before merge — passed (see verification log)
