## 1. Migration provider + runner scaffolding

- [x] 1.1 Create `packages/runtime/src/migrations/0001_initial.ts` exporting a migration with an `up(db)` step that issues `CREATE TABLE IF NOT EXISTS events` + `CREATE INDEX IF NOT EXISTS events_dash_idx` and `CREATE TABLE IF NOT EXISTS queue_items` + `CREATE INDEX IF NOT EXISTS queue_items_tuple_seq_idx`, copied verbatim from the current `CREATE_TABLE_DDL` / `CREATE_INDEX_DDL` in `event-store.ts` and `queue-store.ts` (no schema shape change). No `down` step.
- [x] 1.2 Create `packages/runtime/src/migrations/index.ts` exporting a static `MigrationProvider` whose `getMigrations()` returns the compiled-in object literal (`{ "0001_initial": m0001 }`) — no filesystem read.
- [x] 1.3 Create the runner module (e.g. `packages/runtime/src/migrate.ts`) wrapping Kysely `Migrator` + `migrateToLatest()`: takes a `Kysely` + logger, applies pending migrations in order, and on a non-`ok` result logs the failing version and throws.

## 2. Wire into boot

- [x] 2.1 In `main.ts`, after `buildSqlClient`, construct a dedicated migrator `Kysely` over the shared client and `await` the runner **before** `createEventStore` / `createQueueStore`.
- [x] 2.2 Ensure a migration failure aborts boot before any HTTP listener binds (throw propagates out of the boot path; `/readyz` never reports ready).

## 3. Centralize schema DDL (remove from stores)

- [x] 3.1 Remove `CREATE_TABLE_DDL` / `CREATE_INDEX_DDL` execution from `createEventStore` (`event-store.ts`); the factory opens against the migrated schema and issues no DDL.
- [x] 3.2 Remove `CREATE_TABLE_DDL` / `CREATE_INDEX_DDL` execution from `createQueueStore` (`queue-store.ts`); same.
- [x] 3.3 Update `test-utils/event-store.ts` and `test-utils/queue-store.ts` to run the migrator against the in-memory/file libSQL DB before returning a store, so tests use the production schema path.

## 4. Tests

- [x] 4.1 Runner: fresh DB applies every migration in order and records each in `kysely_migration`.
- [x] 4.2 Runner: already-migrated DB re-runs no `up` step and boot proceeds.
- [x] 4.3 Runner: a migration whose `up` throws makes the runner log the version and throw; no store is constructed.
- [x] 4.4 Baselining (crash/upgrade recovery): seed a DB with populated `events` + `queue_items` and **no** `kysely_migration` table (the live-DB shape); run the runner; assert `0001_initial` is recorded, all pre-existing rows are retained, and no `DROP`/destructive statement ran.
- [x] 4.5 Fresh DB: after `0001`, assert `PRAGMA table_info(events)` / `PRAGMA table_info(queue_items)` and index presence match the pre-change schema exactly.
- [x] 4.6 `createEventStore` and `createQueueStore` issue no `CREATE TABLE/INDEX/ALTER` (assert against a spy or a read-only DB handle).
- [x] 4.7 Crash recovery: simulate a restart after a completed migration (re-run the runner against the same DB) and assert no migration re-runs and no data changes — the runner is idempotent and each migration is transactional.

## 5. Docs

- [x] 5.1 Add a `docs/upgrades.md` entry: additive, **no** tenant rebuild, **no** DATA-LOSS marker; note the two new tracking tables (`kysely_migration`, `kysely_migration_lock`) appear on first boot; rollback = revert the tag + redeploy (the reverted binary ignores the inert tracking tables).

## 6. Verify

- [x] 6.1 `pnpm validate` passes (lint, check, test, tofu fmt/validate unaffected).
- [x] 6.2 `pnpm dev --random-port --kill` (backgrounded): grep `[READY]`, then confirm the dev libSQL DB under `.persistence/` contains a `kysely_migration` row for `0001_initial` and `/readyz` reports ready.
- [x] 6.3 Re-boot against the same `.persistence/` DB and confirm no migration re-runs (idempotent baseline holds across restarts) and stores open normally.
- [x] 6.4 `pnpm test:e2e` — persistence/boot path touched; confirm events + queues round-trip against the migrated schema. **Result:** `22-queue-roundtrip` (queue round-trip against the migrated schema) passes in isolation (3.5s); the boot/spawn path works (dev boot applied `0001-initial`, `/readyz` 200). Pre-existing/environmental failures unrelated to this change: browser tests (09/10/11) fail with `browserType.launch: Executable doesn't exist` (chromium not installed); sandbox-eviction tests (05/07) time out at 60s **on the stashed baseline too** (verified — resource-constrained box), so not a migration regression.
