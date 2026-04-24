# Event Store Specification

## Purpose

Provide an in-memory DuckDB-based invocation index that implements BusConsumer, enabling SQL queries over invocation lifecycle records for the dashboard.
## Requirements
### Requirement: EventStore implements BusConsumer

The EventStore SHALL implement the `BusConsumer` interface. It SHALL be created via a factory function `createEventStore(options?: { logger? }): EventStore` that eagerly creates an in-memory DuckDB instance, runs DDL, and returns an object with `handle()`, a `query(tenant)` method, and a `ping()` method.

#### Scenario: Factory creates EventStore

- **WHEN** `createEventStore()` is called
- **THEN** the returned object implements `BusConsumer` (handle)
- **AND** exposes a `query(tenant: string)` method (returns a tenant-scoped read-only `SelectQueryBuilder`)
- **AND** exposes a `ping(): Promise<void>` method
- **AND** the in-memory DuckDB instance is ready for queries

### Requirement: DuckDB in-memory storage

The EventStore SHALL use DuckDB in `:memory:` mode via `@duckdb/node-api`. The database instance SHALL be created eagerly in the factory function. No explicit close/destroy is required.

#### Scenario: Database is in-memory

- **GIVEN** a newly created EventStore
- **WHEN** the process exits
- **THEN** all indexed data is lost (expected --- rebuilt from persistence on next startup)

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
- **WHEN** `createEventStore({ persistence: { backend } })` bootstraps and awaits `initialized`
- **THEN** the `events` table SHALL contain one row per archived event
- **AND** every loaded row's `meta` column SHALL be `NULL`
- **AND** no exception SHALL be thrown during bootstrap

### Requirement: EventStore bootstraps from persistence at init

The EventStore consumer factory SHALL accept an optional `persistence: { backend: StorageBackend }` option (the `StorageBackend` itself, wrapped in a struct for future extensibility — NOT the persistence consumer). When supplied, the factory SHALL eagerly populate its `events` table at construction by invoking the module-level `scanArchive(backend)` helper from `persistence.ts` and inserting one row per archived `InvocationEvent`. The factory function SHALL be async (or expose an `initialized` promise that callers can await) so the dashboard list can render only after the bootstrap completes.

The wrapping struct exists so the signature can grow additional persistence-related knobs (logger, prefix override, etc.) without a breaking change. It is NOT a reference to the `Persistence` BusConsumer — EventStore and Persistence are independent bus consumers and neither holds a reference to the other.

#### Scenario: Index populated from archive at init

- **GIVEN** `archive/` containing 5 invocations, each with N events (for a total of M event records)
- **WHEN** `createEventStore({ persistence: { backend } })` is called and its `initialized` promise resolves
- **THEN** the `events` table SHALL contain `M` rows
- **AND** each row's `(id, seq)` pair SHALL match an event record found in the archive

### Requirement: Query latest invocations

The EventStore SHALL expose a `query(tenant: string)` method that returns a Kysely-style read-only `SelectQueryBuilder` scoped to the `events` table AND pre-bound with `.where("tenant", "=", tenant)`. Consumers derive the cross-invocation dashboard list by querying `trigger.request` rows for the active tenant with the appropriate ordering and then joining terminal events for status/duration. Cross-invocation ordering SHALL use the `at` column with `id` as tiebreak.

The `tenant` argument SHALL be required. There SHALL be no API for issuing an unscoped read of the `events` table from outside the EventStore module.

#### Scenario: Query latest trigger.request rows for a tenant

- **GIVEN** an EventStore with events for multiple invocations across tenants `"t0"` and `"t1"`
- **WHEN** `eventStore.query("t0").where('kind', '=', 'trigger.request').selectAll().orderBy('at', 'desc').orderBy('id', 'desc').limit(50).execute()` is called
- **THEN** the EventStore SHALL return at most 50 `trigger.request` rows
- **AND** every returned row SHALL have `tenant = "t0"`
- **AND** the rows SHALL be ordered by `at` descending, tiebroken by `id` descending

#### Scenario: Query events by invocation id is tenant-scoped

- **GIVEN** an EventStore with events for invocation `evt_abc` at seqs 0..N owned by tenant `"t0"`, and unrelated events owned by tenant `"t1"` (including, hypothetically, a row sharing the same id)
- **WHEN** `eventStore.query("t0").where('id', '=', 'evt_abc').orderBy('seq', 'asc').execute()` is called
- **THEN** the EventStore SHALL return exactly the `N+1` events for `evt_abc` belonging to tenant `"t0"`
- **AND** no row from any other tenant SHALL appear in the result, regardless of id

#### Scenario: Querying a tenant the caller is not a member of returns no rows

- **GIVEN** an EventStore with events for invocation `evt_xyz` belonging to tenant `"t1"` and no rows for tenant `"t0"`
- **WHEN** `eventStore.query("t0").where('id', '=', 'evt_xyz').execute()` is called
- **THEN** the EventStore SHALL return zero rows

### Requirement: handle() inserts event row (non-fatal)

`handle(event)` SHALL INSERT a row into the `events` table for every `InvocationEvent` received. The operation SHALL be wrapped in a try/catch — errors SHALL be logged but NOT rethrown, so the bus pipeline continues.

#### Scenario: Insert failure does not crash pipeline

- **GIVEN** an EventStore whose DuckDB instance has an internal error
- **WHEN** `handle(event)` is called
- **THEN** the error is logged via the injected logger
- **AND** `handle()` resolves without throwing

### Requirement: query property exposes read-only SelectQueryBuilder

The `query(tenant)` method SHALL return a Kysely `SelectQueryBuilder` pre-scoped to the `events` table AND pre-bound with `.where("tenant", "=", tenant)`. Consumers chain `.where()`, `.select()`, `.groupBy()`, `.execute()`, etc. The returned builder SHALL NOT expose insert, update, or delete capabilities.

Additional `.where("tenant", "=", X)` predicates SHALL be additive (Kysely AND-combines them); the tenant binding cannot be removed by the caller.

#### Scenario: Query by workflow within a tenant

- **GIVEN** an EventStore with invocations for workflows "foo" and "bar" in tenant `"t0"`, plus invocations for workflow "foo" in tenant `"t1"`
- **WHEN** `eventStore.query("t0").where('workflow', '=', 'foo').selectAll().execute()` is called
- **THEN** only the tenant-`"t0"` invocations for workflow "foo" are returned

#### Scenario: Aggregation query within a tenant

- **GIVEN** an EventStore with 3 invocations for "foo" and 2 for "bar" in tenant `"t0"`, plus 5 invocations in tenant `"t1"`
- **WHEN** a GROUP BY query with `eb.fn.count('id')` is executed via `eventStore.query("t0")`
- **THEN** results show foo=3, bar=2 (no contribution from `"t1"`)

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

### Requirement: Liveness ping

The EventStore SHALL expose a `ping(): Promise<void>` method that issues a `SELECT 1` round-trip against the underlying DuckDB connection. The method SHALL resolve on success and SHALL reject (propagating the underlying error) on connection or query failure. `ping()` SHALL NOT require a tenant argument; it does not read from the `events` table.

#### Scenario: ping resolves on a healthy store

- **GIVEN** an EventStore whose DuckDB instance is responsive
- **WHEN** `eventStore.ping()` is called
- **THEN** the returned promise SHALL resolve

#### Scenario: ping rejects on a failed store

- **GIVEN** an EventStore whose DuckDB instance has an internal error
- **WHEN** `eventStore.ping()` is called
- **THEN** the returned promise SHALL reject with the underlying error

### Requirement: Security context

The implementation SHALL conform to the tenant isolation invariant
documented at `/SECURITY.md §1 "Tenant isolation invariants"` (I-T2).
The `EventStore.query(tenant)` API is the load-bearing enforcement point
for I-T2 on invocation-event reads: the required `tenant` argument is
pre-bound into a `.where("tenant", "=", tenant)` clause on the returned
Kysely `SelectQueryBuilder`, and no unscoped read API is exposed. This
makes tenant-scope omission structurally impossible — a caller cannot
construct a read against the `events` table without supplying a tenant
at the call site.

Changes to this capability that introduce a new read path against the
`events` table (including new public methods on `EventStore`, new
utilities that accept a `Kysely` instance, or re-exports that would
allow a consumer to build a query bypassing `query(tenant)`), or that
weaken the pre-binding behaviour of `query(tenant)`, MUST update
`/SECURITY.md §1` in the same change proposal.

#### Scenario: Change introduces a new read path

- **GIVEN** a change proposal that adds a new method, re-export, or
  utility that allows consumers to read from the `events` table
- **WHEN** the change is proposed
- **THEN** the proposal SHALL demonstrate that the new read path is
  tenant-scoped at its API surface (the `tenant` argument is required
  and the scope cannot be removed by the caller)
- **AND** the proposal SHALL update `/SECURITY.md §1 "Tenant isolation
  invariants"` to reference the new read path

#### Scenario: Change is orthogonal to the invariant

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not introduce a new read path and does not
  alter the `query(tenant)` pre-binding
- **THEN** no update to `/SECURITY.md §1` is required
- **AND** the proposal SHALL note that tenant-isolation alignment was
  checked

