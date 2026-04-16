## MODIFIED Requirements

### Requirement: DuckDB in-memory storage

The event store SHALL use an in-memory DuckDB instance. The schema SHALL be an `events` table with columns: `id TEXT NOT NULL`, `seq INTEGER NOT NULL`, `kind TEXT NOT NULL`, `ref INTEGER`, `ts TIMESTAMPTZ NOT NULL`, `workflow TEXT NOT NULL`, `workflowSha TEXT NOT NULL`, `name TEXT NOT NULL`, `input JSON`, `output JSON`, `error JSON`, with primary key `(id, seq)`.

#### Scenario: Database is in-memory
- **WHEN** the event store is created
- **THEN** it SHALL use a fresh DuckDB in-memory instance with the events table DDL

#### Scenario: Table is append-only
- **WHEN** events are persisted
- **THEN** they SHALL be inserted, never updated

#### Scenario: Primary key enforces uniqueness
- **WHEN** two events with the same `id` and `seq` are inserted
- **THEN** the second insert SHALL fail

### Requirement: handle() inserts or updates event row (non-fatal)

`handle(event)` SHALL insert a single row into the `events` table. It SHALL never update existing rows. If the insert fails (e.g., duplicate primary key), the error SHALL be logged but not propagated.

#### Scenario: Event inserts a row
- **WHEN** `handle()` receives an `InvocationEvent`
- **THEN** it SHALL insert one row with all event fields serialized (JSON fields as JSON strings, timestamps as ISO strings)

#### Scenario: Insert failure does not crash pipeline
- **WHEN** a DuckDB insert fails
- **THEN** the error SHALL be logged and the consumer SHALL return normally

### Requirement: EventStore bootstraps from persistence at init

At creation time, the event store SHALL accept an optional persistence backend. If provided, it SHALL scan archived event files and bulk-insert all events into the `events` table.

#### Scenario: Index populated from archive at init
- **WHEN** the event store is created with a persistence backend containing archived events
- **THEN** the `events` table SHALL be populated with all archived events

### Requirement: Query API exposed for dashboard

The event store SHALL expose a `query` property (Kysely `SelectQueryBuilder` on the `events` table) and a `with()` method for CTE-based queries. Dashboard code SHALL use these to derive invocation summaries by joining `trigger.request` events with their terminal events.

#### Scenario: Query latest invocations
- **WHEN** the dashboard queries for recent invocations
- **THEN** it SHALL join `trigger.request` events (as start) with `trigger.response` or `trigger.error` events (as terminal) to derive status, duration, and error information

#### Scenario: Query full trace for an invocation (flame graph)
- **WHEN** the dashboard queries for a specific invocation's trace
- **THEN** it SHALL select all events with the given `id` ordered by `seq`
- **AND** pairing requests with their responses (via `ref`) SHALL produce a valid call tree with no orphans and no mismatches

## REMOVED Requirements

### Requirement: EventStore indexes invocation lifecycle records
**Reason**: Replaced by the flat `events` table. There is no longer a separate `invocations` summary table with `status`, `startedAt`, `completedAt` columns. Invocation status is derived from event data.
**Migration**: Dashboard queries that previously read from the `invocations` table now query the `events` table, joining `trigger.request` with terminal events.
