## MODIFIED Requirements

### Requirement: DDL from Zod schema

The EventStore SHALL generate its DDL with columns matching RuntimeEventSchema fields: `id`, `type`, `payload`, `targetAction`, `correlationId`, `parentEventId`, `createdAt`, `emittedAt`, `startedAt`, `doneAt`, `state`, `result`, `error`. The `emittedAt`, `startedAt`, and `doneAt` columns SHALL be nullable `TIMESTAMPTZ` to handle events from older persisted formats. The table SHALL have no explicit primary key and no indexes.

#### Scenario: Table schema matches updated RuntimeEventSchema

- **GIVEN** a newly created EventStore
- **WHEN** an event with all fields populated (including `emittedAt`, `startedAt`, `doneAt`) is inserted
- **THEN** all fields are stored and queryable

#### Scenario: Old events without new timestamp fields

- **GIVEN** a newly created EventStore
- **WHEN** an event without `emittedAt`, `startedAt`, or `doneAt` is inserted (from old persistence format)
- **THEN** the row is stored with null values for the missing timestamp columns

#### Scenario: Table has no primary key

- **GIVEN** a newly created EventStore
- **WHEN** two events with the same `id` but different `state` are inserted
- **THEN** both rows exist in the table (append-only)

### Requirement: Dashboard query patterns

The EventStore SHALL support the query patterns required by the dashboard. The `LATEST_STATE_CTE` SHALL use `emittedAt` (instead of `createdAt`) for row ordering within partitions. Timeline queries SHALL order by `emittedAt`.

#### Scenario: Latest state per event

- **WHEN** the dashboard queries for current event states
- **THEN** a `ROW_NUMBER() OVER (PARTITION BY id ORDER BY emittedAt DESC)` window function can be used to select the latest row per event `id`

#### Scenario: Correlation summary query

- **WHEN** the dashboard queries for correlation summaries
- **THEN** the query can group by `correlationId` and compute: aggregate state, initial event type (where `parentEventId IS NULL`), distinct event count, and max `emittedAt`

#### Scenario: Events by correlationId query

- **WHEN** the dashboard queries for all events in a correlation chain
- **THEN** the query can filter by `correlationId` and return the latest state per event with all fields including `emittedAt`, `startedAt`, `doneAt`
