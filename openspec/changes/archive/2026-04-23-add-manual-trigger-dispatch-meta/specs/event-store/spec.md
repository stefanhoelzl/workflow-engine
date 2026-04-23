## MODIFIED Requirements

### Requirement: EventStore indexes invocation events

The EventStore SHALL implement `BusConsumer` and SHALL maintain a DuckDB in-memory table named `events` that indexes individual `InvocationEvent` records, not per-invocation lifecycle rows. Each call to `handle(event)` SHALL append (or, on primary-key collision, update) one row per `InvocationEvent` received.

The `events` table schema SHALL include columns: `id` (text), `seq` (integer), `kind` (text), `ref` (integer, nullable), `at` (TIMESTAMPTZ), `ts` (BIGINT, monotonic µs), `tenant` (text, NOT NULL), `workflow` (text), `workflowSha` (text), `name` (text), `input` (JSON, nullable), `output` (JSON, nullable), `error` (JSON, nullable), `meta` (JSON, nullable). Primary key SHALL be `(id, seq)`.

The `meta` column SHALL be kind-agnostic in name (like `input`/`output`/`error`) but its population SHALL be kind-specific: in the current change it carries `{ dispatch: { source, user? } }` for `trigger.request` rows only and SHALL be `NULL` for all other kinds. Future kind-specific runtime metadata MAY be nested under `meta` without a schema migration.

The EventStore SHALL NOT convert event timestamps during insert; `at` values are written through to DuckDB as-is, and `ts` values are written through as integer microseconds. `input`, `output`, `error`, and `meta` SHALL be serialized to JSON strings on insert when present; absent fields SHALL be stored as SQL `NULL`. The `tenant` column SHALL be written through unchanged from the `InvocationEvent.tenant` field.

The archive loader that bootstraps the EventStore from persistence at startup SHALL tolerate archived events that carry no `meta` field. For such events the `meta` column SHALL be set to `NULL`; no migration of archive files SHALL be required.

Cross-invocation ordering for the dashboard list is derived by the consuming code from `trigger.request` rows joined with terminal `trigger.response`/`trigger.error` rows — the EventStore itself does not materialize a lifecycle view.

#### Scenario: Single event inserts a row keyed by (id, seq)

- **GIVEN** an EventStore with no rows
- **WHEN** `handle({ kind: "trigger.request", id: "evt_a", seq: 0, ref: null, at: "2026-04-17T10:00:00.000Z", ts: 0, tenant: "t0", workflow: "w", workflowSha: "sha", name: "webhook", input: {...} })` is called
- **THEN** a row SHALL be inserted with `id: "evt_a"`, `seq: 0`, `kind: "trigger.request"`, `ref: null`, `at = "2026-04-17T10:00:00.000Z"`, `ts = 0`, `tenant = "t0"`
- **AND** the `meta` column for that row SHALL be `NULL`

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

#### Scenario: trigger.request with dispatch meta serializes to the meta column

- **GIVEN** an EventStore with no rows
- **WHEN** `handle({ kind: "trigger.request", id: "evt_a", seq: 0, ..., meta: { dispatch: { source: "manual", user: { name: "Jane", mail: "jane@example.com" } } } })` is called
- **THEN** a row SHALL be inserted with `meta` containing the JSON-serialized `{ "dispatch": { "source": "manual", "user": { "name": "Jane", "mail": "jane@example.com" } } }`

#### Scenario: Non-trigger events persist with NULL meta

- **GIVEN** an EventStore with no rows
- **WHEN** `handle({ kind: "action.request", id: "evt_a", seq: 1, ..., input: {...} })` is called with no `meta` field
- **THEN** a row SHALL be inserted with `meta = NULL`

#### Scenario: Archive loader tolerates legacy events without meta

- **GIVEN** an `archive/` containing invocations persisted before this change (no `meta` field on any event)
- **WHEN** `createEventStore({ persistence })` bootstraps and awaits `initialized`
- **THEN** the `events` table SHALL contain one row per archived event
- **AND** every loaded row's `meta` column SHALL be `NULL`
- **AND** no exception SHALL be thrown during bootstrap
