## Why

The libSQL schema (both `events` and `queue_items`) is created ad hoc by each store's factory via `CREATE TABLE/INDEX IF NOT EXISTS`, with no version tracking and no way to evolve an existing table. Every past schema change was therefore a **DATA LOSS** event (NDJSON→DuckDB, DuckDB→libSQL each discarded all rows). The next planned change — adding a `key` column to `queue_items` for keyed queues — must land against a *live* managed Bunny Database without wiping it, which the current mechanism cannot do. This change introduces a real, versioned, forward-only migration runner so schema can evolve losslessly from here on.

## What Changes

- Introduce a **migration runner** (Kysely `Migrator`) that runs once at boot, before either store opens, and applies all pending migrations in order. A failed migration crashes boot (fail-closed) before the runtime serves.
- Migrations are supplied by an **in-code static `MigrationProvider`** (an object literal of migration modules under `packages/runtime/src/migrations/`). The stock `FileMigrationProvider` is unusable because the runtime ships as a single-file SSR bundle (`dist/main.js`) with no source-tree `migrations/` directory at runtime.
- Migration **`0001_initial`** reproduces the current schema (`events`, `queue_items`, and their indexes) using `CREATE … IF NOT EXISTS`. On existing prod/staging DBs it is a recorded no-op; on a fresh DB it builds the baseline. This baselines the live, currently-unversioned databases without detection logic.
- **Centralize schema ownership:** remove the `CREATE TABLE/INDEX` DDL from `createEventStore` and `createQueueStore`; both stores open against an already-migrated database. The migration runner becomes the single source of truth for schema.
- Migrations are **forward-only** (no `down()`), consistent with the roll-forward deploy model (app rollback = revert the tag + redeploy).
- Kysely creates and manages its `kysely_migration` + `kysely_migration_lock` tracking tables in the same libSQL database.
- **No new env var, no manifest change, no SDK/workflow-author-visible change.** No new runtime dependency (`Migrator` ships in the already-present `kysely`).

## Capabilities

### New Capabilities
- `database-migrations`: the boot-time, forward-only, versioned schema migration runner over the libSQL database — the in-code static provider convention, ordered application, baselining of existing unversioned databases via an idempotent initial migration, fail-closed boot on error, and centralized ownership of all table/index DDL.

### Modified Capabilities
- `event-store`: `createEventStore` no longer ensures the schema (drops the idempotent `CREATE TABLE/INDEX IF NOT EXISTS` responsibility from the factory). Schema is guaranteed by the migration runner before the factory is called; the factory SHALL NOT execute DDL.

## Impact

- **New:** `packages/runtime/src/migrations/` — `index.ts` (assembles the static provider) and `0001_initial.ts` (baseline DDL for `events` + `queue_items` + indexes).
- **New:** a migration-runner module wrapping Kysely `Migrator` + `migrateToLatest()`, invoked from `main.ts` after `buildSqlClient` and before `createEventStore` / `createQueueStore`.
- **Modified:** `packages/runtime/src/event-store.ts` and `packages/runtime/src/queue-store.ts` drop their `CREATE_TABLE_DDL` / `CREATE_INDEX_DDL` execution.
- **Modified:** `main.ts` boot sequence gains the migration step; a non-`ok` migration result throws before serving.
- **Modified:** store test-utils (`test-utils/event-store.ts`, `test-utils/queue-store.ts`) run the migrator before returning a store, so tests exercise the production schema path.
- **Database:** two tracking tables (`kysely_migration`, `kysely_migration_lock`) appear in every environment's libSQL database on first boot after the upgrade. No tenant rebuild; no operator action beyond deploying the new image.
