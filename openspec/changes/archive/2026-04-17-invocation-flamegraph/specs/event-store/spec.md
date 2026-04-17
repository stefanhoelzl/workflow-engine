## MODIFIED Requirements

### Requirement: EventStore indexes invocation events

The EventStore SHALL implement `BusConsumer` and SHALL maintain a DuckDB in-memory table named `events` that indexes individual `InvocationEvent` records, not per-invocation lifecycle rows. Each call to `handle(event)` SHALL append (or, on primary-key collision, update) one row per `InvocationEvent` received.

The `events` table schema SHALL include columns: `id` (text), `seq` (integer), `kind` (text), `ref` (integer, nullable), `at` (TIMESTAMPTZ), `ts` (BIGINT, monotonic µs), `workflow` (text), `workflowSha` (text), `name` (text), `input` (JSON, nullable), `output` (JSON, nullable), `error` (JSON, nullable). Primary key SHALL be `(id, seq)`.

The EventStore SHALL NOT convert event timestamps during insert; `at` values are written through to DuckDB as-is, and `ts` values are written through as integer microseconds. `input`, `output`, and `error` SHALL be serialized to JSON strings on insert when present; absent fields SHALL be stored as SQL `NULL`.

Cross-invocation ordering for the dashboard list is derived by the consuming code from `trigger.request` rows joined with terminal `trigger.response`/`trigger.error` rows — the EventStore itself does not materialize a lifecycle view.

#### Scenario: Single event inserts a row keyed by (id, seq)

- **GIVEN** an EventStore with no rows
- **WHEN** `handle({ kind: "trigger.request", id: "evt_a", seq: 0, ref: null, at: "2026-04-17T10:00:00.000Z", ts: 0, workflow: "w", workflowSha: "sha", name: "webhook", input: {...} })` is called
- **THEN** a row SHALL be inserted with `id: "evt_a"`, `seq: 0`, `kind: "trigger.request"`, `ref: null`, `at = "2026-04-17T10:00:00.000Z"`, `ts = 0`

#### Scenario: Multiple events per invocation all persist

- **GIVEN** an EventStore with no rows
- **WHEN** three `InvocationEvent` records for the same `id: "evt_a"` with `seq: 0, 1, 2` are each passed to `handle()`
- **THEN** the `events` table SHALL contain three rows, one per event, all sharing `id = "evt_a"`
- **AND** each row's `seq` SHALL match its source event

#### Scenario: Re-inserting the same (id, seq) does not duplicate or crash

- **GIVEN** an `events` table already containing a row for `(id: "evt_a", seq: 0)`
- **WHEN** `handle()` is called again with an event carrying the same `(id, seq)`
- **THEN** the `handle()` call SHALL resolve without throwing
- **AND** the table SHALL NOT contain more than one row for `(id: "evt_a", seq: 0)`

### Requirement: EventStore bootstraps from persistence at init

The EventStore consumer factory SHALL accept a persistence reference and SHALL eagerly populate its `events` table from the archive records returned by `persistence.scanArchive()` at construction. Each archived `InvocationEvent` SHALL become one row in the `events` table. The factory function SHALL be async (or expose an `initialized` promise that callers can await) so the dashboard list can render only after the bootstrap completes.

#### Scenario: Index populated from archive at init

- **GIVEN** `archive/` containing 5 invocations, each with N events (for a total of M event records)
- **WHEN** `createEventStore({ persistence })` is called and its `initialized` promise resolves
- **THEN** the `events` table SHALL contain `M` rows
- **AND** each row's `(id, seq)` pair SHALL match an event record found in the archive

### Requirement: Query latest invocations

The EventStore SHALL expose a `query` property (a Kysely-style read-only `SelectQueryBuilder`) scoped to the `events` table. Consumers derive the cross-invocation dashboard list by querying `trigger.request` rows with the appropriate ordering and then joining terminal events for status/duration. Cross-invocation ordering SHALL use the `at` column with `id` as tiebreak.

#### Scenario: Query latest trigger.request rows

- **GIVEN** an EventStore with events for multiple invocations
- **WHEN** `eventStore.query.where('kind', '=', 'trigger.request').selectAll().orderBy('at', 'desc').orderBy('id', 'desc').limit(50).execute()` is called
- **THEN** the EventStore SHALL return at most 50 `trigger.request` rows
- **AND** the rows SHALL be ordered by `at` descending, tiebroken by `id` descending

#### Scenario: Query events by invocation id

- **GIVEN** an EventStore with events for invocation `evt_abc` at seqs 0..N and unrelated events for other invocations
- **WHEN** `eventStore.query.where('id', '=', 'evt_abc').orderBy('seq', 'asc').execute()` is called
- **THEN** the EventStore SHALL return exactly the `N+1` events for `evt_abc`
- **AND** the rows SHALL be ordered by `seq` ascending

### Requirement: handle() inserts event row (non-fatal)

`handle(event)` SHALL INSERT a row into the `events` table for every `InvocationEvent` received. The operation SHALL be wrapped in a try/catch — errors SHALL be logged but NOT rethrown, so the bus pipeline continues.

#### Scenario: Insert failure does not crash pipeline

- **GIVEN** an EventStore whose DuckDB instance has an internal error
- **WHEN** `handle(event)` is called
- **THEN** the error is logged via the injected logger
- **AND** `handle()` resolves without throwing
