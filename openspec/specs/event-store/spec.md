# Event Store Specification

## Purpose

Provide an in-memory DuckDB-based event index that implements BusConsumer, enabling SQL queries over the event stream for dashboards, debugging, and analytics.

## Requirements

### Requirement: EventStore implements BusConsumer

The EventStore SHALL implement the `BusConsumer` interface. It SHALL be created via a factory function `createEventStore(options?: { logger? }): EventStore` that eagerly creates an in-memory DuckDB instance, runs DDL, and returns an object with `handle()`, `bootstrap()`, and a `query` property.

#### Scenario: Factory creates EventStore

- **WHEN** `createEventStore()` is called
- **THEN** the returned object implements `BusConsumer` (handle + bootstrap)
- **AND** exposes a `query` property (read-only SelectQueryBuilder)
- **AND** the in-memory DuckDB instance is ready for queries

### Requirement: DuckDB in-memory storage

The EventStore SHALL use DuckDB in `:memory:` mode via `@duckdb/node-api`. The database instance SHALL be created eagerly in the factory function. No explicit close/destroy is required.

#### Scenario: Database is in-memory

- **GIVEN** a newly created EventStore
- **WHEN** the process exits
- **THEN** all indexed data is lost (expected — rebuilt from FS on next startup)

### Requirement: DDL from Zod schema

The EventStore SHALL generate its DDL using `@datazod/zod-sql` with the `postgres` dialect, replacing `JSONB` with `JSON` in the output. The events table SHALL contain columns matching RuntimeEventSchema fields: `id`, `type`, `payload`, `targetAction`, `correlationId`, `parentEventId`, `createdAt`, `state`, `error`. The table SHALL have no explicit primary key and no indexes (DuckDB columnar storage handles query patterns without them).

#### Scenario: Table schema matches RuntimeEventSchema

- **GIVEN** a newly created EventStore
- **WHEN** an event with all fields populated is inserted
- **THEN** all fields are stored and queryable

#### Scenario: Table has no primary key

- **GIVEN** a newly created EventStore
- **WHEN** two events with the same `id` but different `state` are inserted
- **THEN** both rows exist in the table (append-only)

### Requirement: handle() inserts event row (non-fatal)

`handle(event)` SHALL INSERT a new row into the events table for every RuntimeEvent received, regardless of state. The insert SHALL be wrapped in a try/catch — errors SHALL be logged but NOT rethrown, so the bus pipeline continues.

#### Scenario: Event is indexed

- **GIVEN** an EventStore
- **WHEN** `handle({ id: "evt_abc", state: "pending", correlationId: "corr_1", ... })` is called
- **THEN** a row with `id="evt_abc"` and `state="pending"` exists in the events table

#### Scenario: State transition adds new row

- **GIVEN** an EventStore with a row for `evt_abc` with `state="pending"`
- **WHEN** `handle({ id: "evt_abc", state: "processing", ... })` is called
- **THEN** a second row with `id="evt_abc"` and `state="processing"` exists
- **AND** the original `state="pending"` row is unchanged

#### Scenario: Insert failure does not crash pipeline

- **GIVEN** an EventStore whose DuckDB instance has an internal error
- **WHEN** `handle(event)` is called
- **THEN** the error is logged
- **AND** `handle()` resolves without throwing

### Requirement: bootstrap() bulk inserts events

`bootstrap(events, options)` SHALL INSERT all provided events into the events table. The `pending` option SHALL be ignored — EventStore inserts all events regardless of whether they come from `pending/` or `archive/`.

#### Scenario: Bootstrap inserts pending batch

- **GIVEN** an EventStore
- **WHEN** `bootstrap([evt1, evt2], { pending: true })` is called
- **THEN** two rows exist in the events table

#### Scenario: Bootstrap inserts archive batch

- **GIVEN** an EventStore
- **WHEN** `bootstrap([evt1, evt2, evt3], { pending: false })` is called
- **THEN** three rows exist in the events table

#### Scenario: Bootstrap with empty array

- **GIVEN** an EventStore
- **WHEN** `bootstrap([], { pending: true })` is called
- **THEN** no rows are added

### Requirement: query property exposes read-only SelectQueryBuilder

The EventStore SHALL expose a `query` property that returns a Kysely `SelectQueryBuilder` pre-scoped to the events table (i.e., `selectFrom('events')` is already applied). Consumers chain `.where()`, `.select()`, `.groupBy()`, `.execute()`, etc. The property SHALL NOT expose insert, update, or delete capabilities.

#### Scenario: Query by correlationId

- **GIVEN** an EventStore with events for correlationIds "corr_A" and "corr_B"
- **WHEN** `eventStore.query.where('correlationId', '=', 'corr_A').selectAll().execute()` is called
- **THEN** only events with `correlationId="corr_A"` are returned

#### Scenario: Aggregation query

- **GIVEN** an EventStore with 3 events for "corr_A" and 2 events for "corr_B"
- **WHEN** a GROUP BY query with `eb.fn.count('id')` is executed
- **THEN** results show corr_A=3, corr_B=2

#### Scenario: Expression builder available via callback

- **GIVEN** an EventStore
- **WHEN** `eventStore.query.select(eb => [eb.fn.count('id').as('total')]).execute()` is called
- **THEN** the query executes and returns the count

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
