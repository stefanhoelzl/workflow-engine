# Event Store Specification

## Purpose

Provide an in-memory DuckDB-based invocation index that implements BusConsumer, enabling SQL queries over invocation lifecycle records for the dashboard.

## Requirements

### Requirement: EventStore implements BusConsumer

The EventStore SHALL implement the `BusConsumer` interface. It SHALL be created via a factory function `createEventStore(options?: { logger? }): EventStore` that eagerly creates an in-memory DuckDB instance, runs DDL, and returns an object with `handle()` and a `query` property.

#### Scenario: Factory creates EventStore

- **WHEN** `createEventStore()` is called
- **THEN** the returned object implements `BusConsumer` (handle)
- **AND** exposes a `query` property (read-only SelectQueryBuilder)
- **AND** the in-memory DuckDB instance is ready for queries

### Requirement: DuckDB in-memory storage

The EventStore SHALL use DuckDB in `:memory:` mode via `@duckdb/node-api`. The database instance SHALL be created eagerly in the factory function. No explicit close/destroy is required.

#### Scenario: Database is in-memory

- **GIVEN** a newly created EventStore
- **WHEN** the process exits
- **THEN** all indexed data is lost (expected --- rebuilt from persistence on next startup)

### Requirement: EventStore indexes invocation lifecycle records

The EventStore SHALL implement `BusConsumer` and SHALL maintain a DuckDB in-memory table indexing invocation lifecycle. Each invocation SHALL be represented by a single row that is inserted on `started` and updated on `completed` or `failed`. The schema SHALL include columns: `id`, `workflow`, `trigger`, `status` (`"pending" | "succeeded" | "failed"`), `startedAt` (`TIMESTAMPTZ`, written from the `started` event's `at` field), `completedAt` (`TIMESTAMPTZ`, nullable, written from the terminal event's `at` field), `startedTs` (`BIGINT`, µs, written from the `started` event's `ts` field), `completedTs` (`BIGINT`, nullable, written from the terminal event's `ts` field), and serialized `error` (nullable).

`startedAt` / `completedAt` remain the ordering axis for cross-invocation queries. `startedTs` / `completedTs` exist to support accurate monotonic-duration queries within a single invocation; their difference equals the sandbox-observable execution duration in microseconds.

The EventStore SHALL NOT convert event timestamps during insert; `at` values are written through to DuckDB as-is, and `ts` values are written through as integer microseconds.

#### Scenario: Started event inserts pending row

- **GIVEN** an EventStore with no rows
- **WHEN** `handle({ kind: "started", id: "evt_a", workflow: "w", trigger: "t", at: "2026-04-17T10:00:00.000Z", ts: 0, input })` is called
- **THEN** a row SHALL be inserted with `id: "evt_a"`, `status: "pending"`, `startedAt = "2026-04-17T10:00:00.000Z"`, `startedTs = 0`, `completedAt = null`, `completedTs = null`

#### Scenario: Completed event updates row

- **GIVEN** the row from the started scenario above
- **WHEN** `handle({ kind: "completed", id: "evt_a", at: "2026-04-17T10:00:01.234Z", ts: 1_234_567, result })` is called
- **THEN** the existing row SHALL be updated to `status: "succeeded"`, `completedAt = "2026-04-17T10:00:01.234Z"`, `completedTs = 1_234_567`

#### Scenario: Failed event updates row with error

- **GIVEN** a pending row for `evt_a`
- **WHEN** `handle({ kind: "failed", id: "evt_a", at, ts, error })` is called
- **THEN** the row SHALL be updated to `status: "failed"`, `completedAt = at`, `completedTs = ts`, `error = serialize(error)`

### Requirement: EventStore bootstraps from persistence at init

The EventStore consumer factory SHALL accept a persistence reference and SHALL eagerly populate its index from `persistence.scanArchive()` at construction. The factory function SHALL be async or expose an `initialized` promise that callers can await.

#### Scenario: Index populated from archive at init

- **GIVEN** `archive/` containing 5 invocation records
- **WHEN** `createEventStore({ persistence })` is called and the initialization completes
- **THEN** the EventStore index SHALL contain 5 rows mirroring the archive records

### Requirement: Query latest invocations

The EventStore SHALL expose a `query` property (a Kysely-style read-only SelectQueryBuilder) for the dashboard list view to filter and sort invocations. Cross-invocation ordering SHALL use `startedAt` with `id` as tiebreak.

#### Scenario: Query latest invocations

- **GIVEN** an EventStore with multiple invocation rows
- **WHEN** `eventStore.query.selectAll().orderBy('startedAt', 'desc').orderBy('id', 'desc').limit(50).execute()` is called
- **THEN** the EventStore SHALL return the 50 most recently started invocations
- **AND** rows with identical `startedAt` SHALL be ordered by `id` descending

### Requirement: handle() inserts or updates event row (non-fatal)

`handle(event)` SHALL INSERT or UPDATE a row in the invocations table for every InvocationLifecycleEvent received. The operation SHALL be wrapped in a try/catch --- errors SHALL be logged but NOT rethrown, so the bus pipeline continues.

#### Scenario: Insert failure does not crash pipeline

- **GIVEN** an EventStore whose DuckDB instance has an internal error
- **WHEN** `handle(event)` is called
- **THEN** the error is logged
- **AND** `handle()` resolves without throwing

### Requirement: query property exposes read-only SelectQueryBuilder

The EventStore SHALL expose a `query` property that returns a Kysely `SelectQueryBuilder` pre-scoped to the invocations table. Consumers chain `.where()`, `.select()`, `.groupBy()`, `.execute()`, etc. The property SHALL NOT expose insert, update, or delete capabilities.

#### Scenario: Query by workflow

- **GIVEN** an EventStore with invocations for workflows "foo" and "bar"
- **WHEN** `eventStore.query.where('workflow', '=', 'foo').selectAll().execute()` is called
- **THEN** only invocations for workflow "foo" are returned

#### Scenario: Aggregation query

- **GIVEN** an EventStore with 3 invocations for "foo" and 2 for "bar"
- **WHEN** a GROUP BY query with `eb.fn.count('id')` is executed
- **THEN** results show foo=3, bar=2

### Requirement: Module re-exports Kysely utilities

The `event-bus/event-store.ts` module SHALL re-export `sql` from `kysely` and any types consumers need for building queries. Consumers SHALL NOT need to import from `kysely` directly.

#### Scenario: Consumer imports sql from event-store

- **WHEN** a consumer imports `{ sql }` from the event-store module
- **THEN** the `sql` tagged template is available for raw SQL expressions

### Requirement: EventStore module exports

The `event-bus/event-store.ts` module SHALL export:
- `createEventStore` factory function
- `EventStore` type
- `sql` (re-exported from kysely)
- Kysely types needed by consumers for query building

#### Scenario: All exports available

- **WHEN** a consumer imports from the event-store module
- **THEN** `createEventStore`, `EventStore`, and `sql` are available
