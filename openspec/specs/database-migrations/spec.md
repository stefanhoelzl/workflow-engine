# Database Migrations Specification

## Purpose

Own the libSQL schema lifecycle: a boot-time, forward-only migration runner that applies all pending schema migrations to latest before any store opens, so the store factories issue no schema DDL and `/readyz` never reports ready against an incompletely-migrated database.

## Requirements

### Requirement: Boot-time forward-only migration runner

The runtime SHALL, at boot — after opening the libSQL client named by `DATABASE_URL` and **before** constructing `EventStore` or `QueueStore` — apply all pending schema migrations to latest, in ascending version order, against that database. Migrations SHALL be forward-only: each migration exposes an `up` step and SHALL NOT define a `down` step. Migrations already recorded as applied (in the `kysely_migration` tracking table) SHALL NOT re-run. A migration that fails SHALL abort boot: the runtime SHALL log the failing migration's version and throw before any store opens and before any HTTP listener binds, so `/readyz` never reports ready against a database whose migrations did not complete.

The runner SHALL use a dedicated `Kysely` instance over the shared libSQL client; migrations SHALL issue DDL via raw `sql` statements so the instance's typed schema is irrelevant.

#### Scenario: Fresh database applies all migrations in order

- **GIVEN** a fresh libSQL database with no `kysely_migration` table
- **WHEN** the runtime boots and the migration runner runs
- **THEN** the runner SHALL create the tracking tables and apply every migration in ascending version order
- **AND** each applied migration SHALL be recorded in `kysely_migration`
- **AND** `EventStore` and `QueueStore` SHALL be constructed only after the runner resolves successfully

#### Scenario: Already-migrated database re-runs nothing

- **GIVEN** a database whose `kysely_migration` table records every compiled-in migration as applied
- **WHEN** the runtime boots and the migration runner runs
- **THEN** no migration's `up` step SHALL execute
- **AND** boot SHALL proceed to open the stores

#### Scenario: Migration failure aborts boot fail-closed

- **GIVEN** a migration whose `up` step throws when applied
- **WHEN** the runtime boots and the migration runner runs
- **THEN** the runner SHALL log the failing migration's version
- **AND** the runtime SHALL throw before constructing `EventStore` or `QueueStore`
- **AND** no HTTP listener SHALL bind

### Requirement: In-code static migration provider

Migrations SHALL be supplied by an in-code static provider — an object literal mapping each version key (e.g. `0001_initial`) to its migration module — imported into the runtime bundle at build time. The runner SHALL NOT discover migrations from the filesystem at runtime (no directory read), because the runtime ships as a single-file SSR bundle (`dist/main.js`) with no source-tree migrations directory present at run time.

#### Scenario: Provider returns the compiled-in migration set

- **WHEN** the migration runner requests the available migrations
- **THEN** the provider SHALL return the compiled-in object literal of migrations
- **AND** the runner SHALL NOT perform any filesystem read to enumerate migrations

### Requirement: Idempotent initial migration baselines existing databases

Migration `0001_initial` SHALL reproduce the current schema — the `events` table, the `queue_items` table, and their indexes — using `CREATE TABLE/INDEX IF NOT EXISTS`, matching the DDL the store factories issued prior to this change. Against a database that already contains that schema but carries no migration-tracking record (the live, currently-unversioned databases), running `0001` SHALL leave the existing objects unchanged and SHALL be recorded as applied. Against a fresh database, `0001` SHALL create the baseline schema.

#### Scenario: Existing unversioned database is baselined without data loss

- **GIVEN** a live database containing populated `events` and `queue_items` tables and no `kysely_migration` table
- **WHEN** the migration runner runs for the first time
- **THEN** the runner SHALL create the tracking tables and record `0001_initial` as applied
- **AND** the existing `events` and `queue_items` rows SHALL be retained unchanged
- **AND** no `DROP` or destructive statement SHALL execute

#### Scenario: Fresh database builds the baseline from 0001

- **GIVEN** a fresh libSQL database
- **WHEN** the migration runner applies `0001_initial`
- **THEN** the `events` and `queue_items` tables and their indexes SHALL exist
- **AND** their columns and indexes SHALL match the schema the store factories previously created

### Requirement: Centralized schema DDL ownership

The migration runner SHALL be the sole issuer of schema DDL against the libSQL database. After migrations run, the store factories SHALL open against the already-migrated database and SHALL NOT execute any schema DDL — no `CREATE TABLE`, no `CREATE INDEX`, no `ALTER TABLE`.

#### Scenario: EventStore factory issues no schema DDL

- **GIVEN** a database already migrated to latest
- **WHEN** `createEventStore` is awaited
- **THEN** it SHALL NOT execute `CREATE TABLE`, `CREATE INDEX`, or `ALTER TABLE`
- **AND** it SHALL be ready to `record` and `query` against the existing schema

#### Scenario: QueueStore factory issues no schema DDL

- **GIVEN** a database already migrated to latest
- **WHEN** `createQueueStore` is awaited
- **THEN** it SHALL NOT execute `CREATE TABLE`, `CREATE INDEX`, or `ALTER TABLE`
- **AND** it SHALL be ready to `put` and `get` against the existing `queue_items` schema
