## MODIFIED Requirements

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

### Requirement: Query latest invocations

The EventStore SHALL expose a `query` property (a Kysely-style read-only SelectQueryBuilder) for the dashboard list view to filter and sort invocations. Cross-invocation ordering SHALL use `startedAt` with `id` as tiebreak.

#### Scenario: Query latest invocations

- **GIVEN** an EventStore with multiple invocation rows
- **WHEN** `eventStore.query.selectAll().orderBy('startedAt', 'desc').orderBy('id', 'desc').limit(50).execute()` is called
- **THEN** the EventStore SHALL return the 50 most recently started invocations
- **AND** rows with identical `startedAt` SHALL be ordered by `id` descending
