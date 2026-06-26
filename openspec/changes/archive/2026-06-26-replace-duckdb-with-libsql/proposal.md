## Why

The runtime's SQL store (event index + per-workflow queues) is hard-wired to DuckDB. Moving prod off local-disk DuckDB toward a durable external SQL service (Bunny Database, which is libSQL) requires first swapping the engine to libSQL. This change does the engine swap **on-disk only** — libSQL embedded file everywhere — so the later "point prod at remote Bunny" change is a pure connection-config flip with no code churn. Along the way it reconciles a stratum of spec rot left behind by the earlier DuckLake→DuckDB and S3-backend removals.

## What Changes

- **BREAKING (operational):** EventStore + QueueStore persist to a libSQL embedded database file (`<PERSISTENCE_PATH>/events.db`) via `@libsql/client` instead of a DuckDB file (`events.duckdb`). No data migration — fresh schema on first boot (accept-loss, consistent with existing volume policy).
- Both stores are driven through **Kysely with the official `@libsql/kysely-libsql` dialect** (reuses Kysely's built-in SQLite adapter/compiler/introspector). The client is constructed with a `file:` URL and injected; no custom dialect is written.
- Store factories take `db: Kysely<Database>`; `main.ts` builds the libSQL client and the two Kysely instances. Stores no longer reference a DB driver directly.
- **Schema portability fixes:** `TIMESTAMPTZ` columns → `TEXT` (ISO-8601); queue `seq` `CREATE SEQUENCE`/`nextval()` → `INTEGER PRIMARY KEY AUTOINCREMENT`; `JSON` columns → `TEXT`; remove `CHECKPOINT` from prune; wrap the multi-statement prune in a transaction.
- **Performance:** add a composite read index `events(owner, repo, kind, "at")`. Benchmarked at 480k rows: hot-repo dashboard reads drop from ~50–67 ms to <0.1 ms (DuckDB's columnar engine masked the missing index; libSQL is a row store and needs it).
- `PERSISTENCE_PATH` is retained (still hosts tenant bundles **and** now the libSQL file). **No new env var** — the DB path is derived from `PERSISTENCE_PATH`. `DATABASE_URL`/auth-token, remote read-retries, and the remote single-writer treatment are explicitly **deferred** to the later Bunny change.
- Remove the now-dead `EVENT_STORE_CHECKPOINT_*` config (DuckLake-era).
- **Spec reconciliation (persistence-bounded):** delete stale DuckLake (Parquet/`ATTACH`/checkpoint) and S3/`locator()`/`PERSISTENCE_S3_*` requirements that no longer match code, scoped to the persistence/storage/config capabilities being edited.
- Tests: temp `file:` URLs replace temp DuckDB instances; the e2e harness reads events via a second libSQL read client instead of copying the DuckDB file.
- Dependencies: add `@libsql/client` + `@libsql/kysely-libsql`; remove `@duckdb/node-api`, `@duckdb/node-bindings`, `@oorabona/kysely-duckdb`.

This change does **not** touch the sandbox boundary, the EventBus consumer wiring, or the workflow manifest format.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `event-store`: libSQL-backed archive (not DuckDB); `TEXT` timestamps; new composite read index; prune drops `CHECKPOINT` and runs in a transaction; single-writer requirement rewritten as a deployment contract (drop the file-lock mechanism); reconcile stale "DuckLake-attached" query/ping requirements.
- `queues`: `queue_items.seq` via `INTEGER PRIMARY KEY AUTOINCREMENT` (no sequence); `enqueuedAt` as `TEXT`; `item` as `TEXT` JSON; libSQL instance.
- `runtime-config`: remove `EVENT_STORE_CHECKPOINT_*`; remove dead `PERSISTENCE_S3_*` / mutual-exclusion requirements; `PERSISTENCE_PATH` documented as the libSQL file + bundle root.
- `storage-backend`: remove `locator()`, the S3 backend, and the DuckLake/Parquet storage-layout requirements; layout = `events.db` + `workflows/…`.
- `persistence`: tombstone wording DuckLake → libSQL.
- `runtime-build`: Vite `ssr.external` lists `@libsql/client` instead of `@duckdb/node-bindings`.
- `docker`: image carries the libSQL native binding instead of DuckDB.
- `bunny-staging`: `/data` wording (libSQL file + bundles); accept-loss unchanged; no new env in this change.
- `infrastructure`: `events.duckdb` → `events.db` wording; `PERSISTENCE_PATH` retained.
- `e2e-test-framework`: drop DuckLake cold-start/CHECKPOINT-survival tests; event reads via a second libSQL client.
- `health-endpoints`: ping failure wording DuckDB → libSQL.

## Impact

- **Code:** `packages/runtime/src/{event-store,queue-store,queue-store-lifecycle,main}.ts`, `config.ts`, `vite.config.ts`, `storage/`, test-utils + `*.test.ts`, `packages/tests/src/{spawn,events,scenario}.ts`, `scripts/dev.ts`.
- **Dependencies:** swap DuckDB packages for `@libsql/client` + `@libsql/kysely-libsql` (pin a version compatible with `kysely ^0.28`).
- **Infra:** Dockerfile native-dep line; Quadlet/bunny `/data` wording; no new secrets.
- **Docs:** `docs/infrastructure.md`, `docs/dev-probes.md`, `README.md`, `SECURITY.md` store-threat-model table.
- **Operational:** existing DuckDB data is discarded on deploy (accept-loss); operators wipe any stale `events.duckdb`.
