## ADDED Requirements

### Requirement: EventStore indexes invocation lifecycle records

The EventStore SHALL implement `BusConsumer` and SHALL maintain a DuckDB in-memory table indexing invocation lifecycle. Each invocation SHALL be represented by a single row that is inserted on `started` and updated on `completed` or `failed`. The schema SHALL include columns: `id`, `workflow`, `trigger`, `status` (`"pending" | "succeeded" | "failed"`), `startedAt`, `completedAt` (nullable), and serialized `error` (nullable).

#### Scenario: Started event inserts pending row

- **GIVEN** an EventStore with no rows
- **WHEN** `handle({ kind: "started", id: "evt_a", workflow: "w", trigger: "t", ts, input })` is called
- **THEN** a row SHALL be inserted with `id: "evt_a"`, `status: "pending"`, `startedAt = ts`, `completedAt = null`

#### Scenario: Completed event updates row

- **GIVEN** the row from the started scenario above
- **WHEN** `handle({ kind: "completed", id: "evt_a", ts, result })` is called
- **THEN** the existing row SHALL be updated to `status: "succeeded"`, `completedAt = ts`

#### Scenario: Failed event updates row with error

- **GIVEN** a pending row for `evt_a`
- **WHEN** `handle({ kind: "failed", id: "evt_a", ts, error })` is called
- **THEN** the row SHALL be updated to `status: "failed"`, `completedAt = ts`, `error = serialize(error)`

### Requirement: EventStore bootstraps from persistence at init

The EventStore consumer factory SHALL accept a persistence reference and SHALL eagerly populate its index from `persistence.scanArchive()` at construction. The factory function SHALL be async or expose an `initialized` promise that callers can await.

#### Scenario: Index populated from archive at init

- **GIVEN** `archive/` containing 5 invocation records
- **WHEN** `createEventStore({ persistence })` is called and the initialization completes
- **THEN** the EventStore index SHALL contain 5 rows mirroring the archive records

### Requirement: Query API exposed for dashboard

The EventStore SHALL expose a `query` property (a Kysely-style read-only SelectQueryBuilder) for the dashboard list view to filter and sort invocations.

#### Scenario: Query latest invocations

- **GIVEN** an EventStore with multiple invocation rows
- **WHEN** `eventStore.query.selectAll().orderBy('startedAt', 'desc').limit(50).execute()` is called
- **THEN** the EventStore SHALL return the 50 most recently started invocations

## REMOVED Requirements

### Requirement: DDL from Zod schema

**Reason**: The DDL is no longer derived from `RuntimeEventSchema` because RuntimeEvent no longer exists in the new model. The schema is derived from invocation lifecycle records, which have a much smaller column set (id, workflow, trigger, status, startedAt, completedAt, error).

**Migration**: DDL is generated from the new invocation row schema.
