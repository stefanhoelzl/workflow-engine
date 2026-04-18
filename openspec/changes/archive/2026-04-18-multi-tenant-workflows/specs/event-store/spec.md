## MODIFIED Requirements

### Requirement: EventStore indexes invocation lifecycle records

The EventStore SHALL implement `BusConsumer` and SHALL maintain a DuckDB in-memory table indexing invocation lifecycle. Each invocation SHALL be represented by a single row that is inserted on `started` and updated on `completed` or `failed`. The schema SHALL include columns: `id`, `tenant` (string, written from the `started` event's `tenant` field), `workflow`, `trigger`, `status` (`"pending" | "succeeded" | "failed"`), `startedAt` (`TIMESTAMPTZ`, written from the `started` event's `at` field), `completedAt` (`TIMESTAMPTZ`, nullable, written from the terminal event's `at` field), `startedTs` (`BIGINT`, µs, written from the `started` event's `ts` field), `completedTs` (`BIGINT`, nullable, written from the terminal event's `ts` field), and serialized `error` (nullable).

`startedAt` / `completedAt` remain the ordering axis for cross-invocation queries. `startedTs` / `completedTs` exist to support accurate monotonic-duration queries within a single invocation; their difference equals the sandbox-observable execution duration in microseconds.

The `tenant` column SHALL be the primary scope filter for the dashboard and trigger UIs. Queries from authenticated UIs SHALL always include `WHERE tenant = ?` to prevent cross-tenant data leakage (see `dashboard-list-view` and `trigger-ui`).

The EventStore SHALL NOT convert event timestamps during insert; `at` values are written through to DuckDB as-is, and `ts` values are written through as integer microseconds.

#### Scenario: Started event inserts pending row with tenant

- **GIVEN** an EventStore with no rows
- **WHEN** `handle({ kind: "started", id: "evt_a", tenant: "acme", workflow: "w", trigger: "t", at: "2026-04-17T10:00:00.000Z", ts: 0, input })` is called
- **THEN** a row SHALL be inserted with `id: "evt_a"`, `tenant: "acme"`, `status: "pending"`, `startedAt = "2026-04-17T10:00:00.000Z"`, `startedTs = 0`, `completedAt = null`, `completedTs = null`

#### Scenario: Completed event updates row without touching tenant

- **GIVEN** the row from the started scenario above
- **WHEN** `handle({ kind: "completed", id: "evt_a", tenant: "acme", at: "2026-04-17T10:00:01.234Z", ts: 1_234_567, result })` is called
- **THEN** the existing row SHALL be updated to `status: "succeeded"`, `completedAt = "2026-04-17T10:00:01.234Z"`, `completedTs = 1_234_567`
- **AND** the `tenant` column SHALL remain `"acme"`

#### Scenario: Failed event updates row with error

- **GIVEN** a pending row for `evt_a` with tenant `"acme"`
- **WHEN** `handle({ kind: "failed", id: "evt_a", tenant: "acme", at, ts, error })` is called
- **THEN** the row SHALL be updated to `status: "failed"`, `completedAt = at`, `completedTs = ts`, `error = serialize(error)`

### Requirement: Query latest invocations

The EventStore SHALL expose a `query` property (a Kysely-style read-only SelectQueryBuilder) for the dashboard list view to filter and sort invocations. Cross-invocation ordering SHALL use `startedAt` with `id` as tiebreak. Queries scoped to a tenant SHALL use `WHERE tenant = ?`.

#### Scenario: Query latest invocations within a tenant

- **GIVEN** an EventStore with multiple invocation rows across tenants "acme" and "contoso"
- **WHEN** `eventStore.query.where('tenant', '=', 'acme').selectAll().orderBy('startedAt', 'desc').orderBy('id', 'desc').limit(50).execute()` is called
- **THEN** the EventStore SHALL return the 50 most recently started invocations for tenant "acme" only
- **AND** rows with identical `startedAt` SHALL be ordered by `id` descending

### Requirement: query property exposes read-only SelectQueryBuilder

The EventStore SHALL expose a `query` property that returns a Kysely `SelectQueryBuilder` pre-scoped to the invocations table. Consumers chain `.where()`, `.select()`, `.groupBy()`, `.execute()`, etc. The property SHALL NOT expose insert, update, or delete capabilities. Consumers SHALL apply `WHERE tenant = ?` when rendering authenticated UI content; unfiltered queries are permitted only for internal operators / system-level tooling.

#### Scenario: Query by tenant

- **GIVEN** an EventStore with invocations for tenants "acme" and "contoso"
- **WHEN** `eventStore.query.where('tenant', '=', 'acme').selectAll().execute()` is called
- **THEN** only invocations for tenant "acme" are returned

#### Scenario: Query by tenant and workflow

- **GIVEN** an EventStore with invocations for tenants "acme" (workflows "foo", "bar") and "contoso" (workflows "foo")
- **WHEN** a query with `.where('tenant', '=', 'acme').where('workflow', '=', 'foo')` is executed
- **THEN** only "acme"'s "foo" invocations SHALL be returned (no "contoso" rows, no "acme/bar" rows)

#### Scenario: Aggregation query with tenant filter

- **GIVEN** an EventStore with 3 invocations for tenant "acme" ("foo") and 2 for tenant "contoso" ("foo")
- **WHEN** a GROUP BY query with `eb.fn.count('id')` filtered by `tenant = 'acme'` is executed
- **THEN** results show foo=3 (acme only)
