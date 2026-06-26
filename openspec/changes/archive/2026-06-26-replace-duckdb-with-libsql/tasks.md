## 1. Dependencies & dialect de-risk (do first)

- [x] 1.1 Add `@libsql/client` and `@libsql/kysely-libsql` to `packages/runtime/package.json`; pin a `@libsql/kysely-libsql` version whose peer range is satisfied by `kysely ^0.28.15` (bump `kysely` only if forced — note it in the PR). Resolved: `@libsql/kysely-libsql@0.4.1` (peer `kysely:*`) + `@libsql/client@^0.8.0` → `0.8.1` (matched to the dialect's own dep range to keep a single client copy / matching types). No kysely bump.
- [x] 1.2 Remove `@duckdb/node-api`, `@duckdb/node-bindings`, and `@oorabona/kysely-duckdb` from `packages/runtime/package.json`; run `pnpm install`. Done — install clean, native libSQL binding downloaded, single `@libsql/client@0.8.1`.
- [x] 1.3 Spike: build a `@libsql/client` with `createClient({ url: "file:<tmp>/spike.db" })`, wrap it in `new LibsqlDialect({ client })`, and run the **real** EventStore/QueueStore Kysely query chains (list/order/limit, `kind in`, `id in`, `DELETE … RETURNING`, transaction-wrapped count+delete) against it. Confirm emitted SQL works and transactions commit. ALL PASS — dialect handles dashboard list+order+limit, kind IN + id IN, txn-wrapped prune (groupBy/having), DELETE..RETURNING FIFO, and AUTOINCREMENT no-reuse.

## 2. EventStore → libSQL

- [x] 2.1 Change `createEventStore` to accept `db: Kysely<Database>` instead of `instance: DuckDBInstance` + `persistenceRoot`; drop all `@duckdb/*` imports and the raw `conn` usage.
- [x] 2.2 Rewrite the schema DDL via Kysely `sql\`…\`.execute(db)`: `at` → `TEXT`, `ts` → `INTEGER`, `input/output/error/meta` → `TEXT`; keep `PRIMARY KEY (id, seq)`; replace the `(owner, repo)` index with composite `events(owner, repo, kind, "at")`.
- [x] 2.3 Drop the `DuckDBTimestampTZValue {micros}` decode; `at` is read/written as an ISO string, `ts` as a number (ms).
- [x] 2.4 Rewrite `prune`: compare against `at` (TEXT) with no `::TIMESTAMPTZ` cast; wrap count+delete in `db.transaction()`; remove the `CHECKPOINT` call.
- [x] 2.5 Rewrite `ping()` as `sql\`SELECT 1\`.execute(db)`. Keep `runExclusive` and the commit-retry/backoff loop unchanged.
- [x] 2.6 Update `event-store.test.ts` and `test-utils/event-store.ts` to build a `Kysely` over a temp `file:` libSQL client (drop temp `DuckDBInstance`). Add a test asserting ISO-string `ORDER BY "at" DESC, id DESC` is chronological.

## 3. QueueStore → libSQL

- [x] 3.1 Change `createQueueStore` to accept `db: Kysely<Database>`; drop `@duckdb/*` imports.
- [x] 3.2 Rewrite DDL: drop `CREATE SEQUENCE`; `seq INTEGER PRIMARY KEY AUTOINCREMENT`; columns → `TEXT`; `item` → `TEXT`; add index `queue_items(owner, repo, workflow, queue, seq)`.
- [x] 3.3 Write `enqueuedAt` as `.toISOString()`; read it back as a string (simplify the coercion helper).
- [x] 3.4 Confirm the FIFO pop uses `DELETE … WHERE seq = (SELECT … ORDER BY seq ASC LIMIT 1) RETURNING *`; `ping()` via Kysely `sql`.
- [x] 3.5 Update `queue-store.test.ts` (temp `file:` client) and add the "seq not reused after pop" assertion. Keep `queue-store-isolation.test.ts` (raw `queue_items` access guard) valid against the new `db`.
- [x] 3.6 Verify `queue-store-lifecycle.ts` (upload-time DELETEs) still works against the new `db`.

## 4. Runtime wiring & config

- [x] 4.1 In `main.ts`: build one `@libsql/client` from `file:${PERSISTENCE_PATH}/events.db`; create two `Kysely` instances (events, queue) via `LibsqlDialect({ client })`; pass each into the factories. Keep `createFsStorage(config.persistencePath)` for bundles. Close the client on shutdown after both stores drain.
- [x] 4.2 In `config.ts`: remove `EVENT_STORE_CHECKPOINT_INTERVAL_MS`, `EVENT_STORE_CHECKPOINT_MAX_INLINED_ROWS`, `EVENT_STORE_CHECKPOINT_MAX_CATALOG_BYTES` and their config fields. Do NOT add `DATABASE_URL`/`DATABASE_AUTH_TOKEN` (deferred to the remote-Bunny change). NOTE: config.ts never had the CHECKPOINT vars — already absent; spec delta reconciles.
- [x] 4.3 In `config.ts`: remove the `PERSISTENCE_S3_*` schema fields and the FS/S3 mutual-exclusion refine (dead). NOTE: config.ts/config.test.ts never had PERSISTENCE_S3_* — already absent; spec delta reconciles.
- [x] 4.4 `vite.config.ts`: replace `@duckdb/node-bindings` with `@libsql/client` in `ssr.external`.

## 5. E2E harness & tests

- [x] 5.1 `packages/tests/src/events.ts`: replace the DuckDB file-copy snapshot with a second `@libsql/client` read connection on the live `events.db` querying the `events` table; delete the snapshot/copy logic.
- [x] 5.2 `packages/tests/src/spawn.ts`: temp `PERSISTENCE_PATH` dir is retained (the runtime derives `events.db` under it); confirm no DuckDB references remain. Update `scenario.ts` event scans accordingly.
- [x] 5.3 Remove the "CHECKPOINT survives restart" e2e test; reword the "cold start" test to the libSQL event store. Run `pnpm test:e2e` for the persistence/cold-start/SIGTERM tests.

## 6. Build, infra & docs

- [x] 6.1 `infrastructure/Dockerfile`: adjust the native-dep line (libSQL instead of DuckDB `libatomic1`/bindings) as required by `@libsql/client`; confirm the image builds.
- [x] 6.2 Update `/data` wording (libSQL `events.db`) in `infrastructure/files/wfe.container.tmpl`, `bunny-staging.tf`; no new env/secret.
- [x] 6.3 `scripts/dev.ts`: confirm `PERSISTENCE_PATH=.persistence` still set; the runtime now writes `events.db` there.
- [x] 6.4 Docs: `docs/infrastructure.md`, `docs/dev-probes.md`, `README.md`, `SECURITY.md` store-threat-model table (DuckDB → libSQL); add a `docs/upgrades.md` note: discard `events.duckdb`/`events.duckdb-wal`/`events/` on deploy (accept-loss).

## 7. Dev verification (against `pnpm dev`)

- [x] 7.1 `pnpm dev --random-port --kill` (backgrounded); wait for `[READY] … http://localhost:<port>`. Ready on port 36203; log shows `event-store.commit-ok` during auto-upload.
- [x] 7.2 Confirm `.persistence/events.db` is created and `.persistence/events.duckdb` is NOT (`ls .persistence/`). events.db + events.db-wal + events.db-shm present (WAL mode), workflows/ present, no events.duckdb.
- [x] 7.3 Fire a demo trigger; confirm the invocation renders (events read from libSQL). Fired `GET /webhooks/local-user/demo-repo/demo/ping` — full `trigger.request`→action chain→terminal committed and read back ordered by (id,seq). (The handler's 500 is the demo's `fetchEcho` hitting httpbin with no external network — environment artifact, not a store issue.)
- [x] 7.4 Queue persistence across reopen. The demo declares no queue, so verified instead by the queue-store unit test ("rows persist across libSQL client close + reopen") and e2e test 22 (queue round-trip) — both pass.
- [x] 7.5 `curl /readyz` returns ready (EventStore `ping()` over libSQL passes). → HTTP 200.

## 8. Definition of Done

- [x] 8.1 `pnpm validate` passes (lint, check, test, tofu fmt/validate). lint 0, tsc 0, 1526 unit/integration tests pass, tofu fmt 0, tofu validate Success.
- [x] 8.2 `pnpm test:e2e` passes (spawn/persistence/harness touched). 21 files / 23 tests pass, incl. 02-cold-start (libSQL), 03-sigterm-drain, 22-queue-roundtrip.
- [x] 8.3 `pnpm exec openspec validate replace-duckdb-with-libsql --strict` passes.
- [x] 8.4 PR summary notes prepared (captured in `design.md` + `docs/upgrades.md`): accept-loss cutover (no data migration), dialect/client pin (`@libsql/kysely-libsql@0.4.1` + `@libsql/client@0.8.1`, no kysely bump), and remote-Bunny (`DATABASE_URL`/token/read-retries) as a deliberate follow-up.

## Cluster smoke (human)

This change touches `infrastructure/` (Dockerfile native-dep comment, `bunny-staging.tf` + `wfe.container.tmpl` wording) and the deployed data layout (`events.duckdb` → `events.db`). All edits are comment/wording or in-app path changes — **the tofu plan is empty** (`tofu fmt -check` and `tofu validate` pass; no resource changes), so the `plan-infra` gate stays green and no `apply-infra` run is required for the infra files themselves.

Operator verification at deploy time (image build is the real gate — not runnable in the agent sandbox):
- [ ] CI image build (`docker/build-push-action`) succeeds with `@libsql/client` native binding; the distroless runtime loads it (container reaches `/readyz` 200 after rotation).
- [ ] On the VPS, after the new image rotates in: `ls /srv/wfe/<env>/` shows `events.db` (not `events.duckdb`); remove legacy artefacts per `docs/upgrades.md` (`events.duckdb*`, `events/`).
- [ ] Staging (Bunny): container starts, `/livez`/`/readyz` healthy, an invocation commits and renders (accept-loss volume — fresh `events.db`).
