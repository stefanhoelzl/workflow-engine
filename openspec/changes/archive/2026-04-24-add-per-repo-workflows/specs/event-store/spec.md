## MODIFIED Requirements

### Requirement: EventStore implements BusConsumer

The EventStore SHALL implement the `BusConsumer` interface. It SHALL be created via a factory function `createEventStore(options?: { logger? }): EventStore` that eagerly creates an in-memory DuckDB instance, runs DDL, and returns an object with `handle()`, a `query(scopes)` method, and a `ping()` method.

#### Scenario: Factory creates EventStore

- **WHEN** `createEventStore()` is called
- **THEN** the returned object implements `BusConsumer` (handle)
- **AND** exposes a `query(scopes: ReadonlyArray<{owner: string, repo: string}>)` method (returns a scope-bound read-only `SelectQueryBuilder`)
- **AND** exposes a `ping(): Promise<void>` method
- **AND** the in-memory DuckDB instance is ready for queries

### Requirement: EventStore indexes invocation events

The EventStore SHALL implement `BusConsumer` and SHALL maintain a DuckDB in-memory table named `events` that indexes individual `InvocationEvent` records, not per-invocation lifecycle rows. Each call to `handle(event)` SHALL append (or, on primary-key collision, update) one row per `InvocationEvent` received.

The `events` table schema SHALL include columns: `id` (text), `seq` (integer), `kind` (text), `ref` (integer, nullable), `at` (TIMESTAMPTZ), `ts` (BIGINT, monotonic µs), `owner` (text, NOT NULL), `repo` (text, NOT NULL), `workflow` (text), `workflowSha` (text), `name` (text), `input` (JSON, nullable), `output` (JSON, nullable), `error` (JSON, nullable), `meta` (JSON, nullable). Primary key SHALL be `(id, seq)`. The table SHALL have an index on `(owner, repo)` to accelerate scope-filtered queries.

The `meta` column SHALL be kind-agnostic in name but its population SHALL be kind-specific: it carries `{ dispatch: { source, user? } }` for `trigger.request` rows only and SHALL be `NULL` for all other kinds.

The EventStore SHALL NOT convert event timestamps during insert; `at` values are written through as-is, and `ts` values are written through as integer microseconds. `input`, `output`, `error`, and `meta` SHALL be serialized to JSON strings on insert when present; absent fields SHALL be stored as SQL `NULL`. The `owner` and `repo` columns SHALL be written through unchanged from the `InvocationEvent.owner` and `InvocationEvent.repo` fields.

The archive loader that bootstraps the EventStore from persistence at startup SHALL NOT tolerate archived events missing the `owner` or `repo` fields. Archives produced by prior runtime versions are wiped as part of this change's deploy-time migration; any row lacking these fields indicates a corrupt archive and SHALL cause the archive loader to log and skip the row without inserting it.

Cross-invocation ordering for the dashboard list is derived by the consuming code from `trigger.request` rows joined with terminal `trigger.response`/`trigger.error` rows.

#### Scenario: Single event inserts a row keyed by (id, seq)

- **GIVEN** an EventStore with no rows
- **WHEN** `handle({ kind: "trigger.request", id: "evt_a", seq: 0, ref: null, at: "2026-04-17T10:00:00.000Z", ts: 0, owner: "acme", repo: "foo", workflow: "w", workflowSha: "sha", name: "webhook", input: {...} })` is called
- **THEN** a row SHALL be inserted with `id: "evt_a"`, `seq: 0`, `kind: "trigger.request"`, `ref: null`, `at = "2026-04-17T10:00:00.000Z"`, `ts = 0`, `owner = "acme"`, `repo = "foo"`
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

#### Scenario: Archive loader skips rows missing owner or repo

- **GIVEN** an `archive/` containing an event record missing `owner` (corrupted file)
- **WHEN** `createEventStore({ persistence })` bootstraps and awaits `initialized`
- **THEN** the archive loader SHALL log a warning naming the missing field
- **AND** SHALL NOT insert the malformed row
- **AND** SHALL continue loading other valid archive records

### Requirement: Query latest invocations

The EventStore SHALL expose a `query(scopes: ReadonlyArray<{owner: string, repo: string}>)` method that returns a Kysely-style read-only `SelectQueryBuilder` scoped to the `events` table AND pre-bound with a `WHERE (owner, repo) IN ((?, ?), ...)` clause derived from the supplied scopes. Consumers derive the cross-invocation dashboard list by querying `trigger.request` rows for the requested scopes with the appropriate ordering and then joining terminal events for status/duration. Cross-invocation ordering SHALL use the `at` column with `id` as tiebreak.

The `scopes` argument SHALL be required and SHALL NOT be empty; an empty scopes array SHALL cause `query` to throw a precondition error (no read is permitted without at least one scope). There SHALL be no API for issuing an unscoped read of the `events` table from outside the EventStore module.

The EventStore SHALL NOT validate that scopes belong to a particular user; scope resolution is a caller responsibility (see the middleware layer in the `dashboard-list-view` and `trigger-ui` specs). The EventStore treats the supplied scopes as an allow-list and MUST NOT return any row outside it.

#### Scenario: Query latest trigger.request rows for a single scope

- **GIVEN** an EventStore with events for multiple invocations across scopes `{owner: "acme", repo: "foo"}` and `{owner: "acme", repo: "bar"}`
- **WHEN** `eventStore.query([{owner: "acme", repo: "foo"}]).where('kind', '=', 'trigger.request').selectAll().orderBy('at', 'desc').orderBy('id', 'desc').limit(50).execute()` is called
- **THEN** the EventStore SHALL return at most 50 `trigger.request` rows
- **AND** every returned row SHALL have `owner = "acme"` AND `repo = "foo"`
- **AND** no row from `repo = "bar"` SHALL appear
- **AND** the rows SHALL be ordered by `at` descending, tiebroken by `id` descending

#### Scenario: Query across multiple scopes returns union

- **GIVEN** an EventStore with events for `(acme, foo)`, `(acme, bar)`, and `(alice, utils)`
- **WHEN** `eventStore.query([{owner: "acme", repo: "foo"}, {owner: "acme", repo: "bar"}]).selectAll().execute()` is called
- **THEN** the EventStore SHALL return rows from both `(acme, foo)` and `(acme, bar)`
- **AND** NO row from `(alice, utils)` SHALL appear

#### Scenario: Empty scopes array rejected

- **WHEN** `eventStore.query([])` is called
- **THEN** the method SHALL throw a precondition error
- **AND** no SQL query SHALL be executed

#### Scenario: Query events by invocation id is scope-filtered

- **GIVEN** an EventStore with events for invocation `evt_abc` at seqs 0..N owned by scope `(acme, foo)`, and unrelated events owned by scope `(evil-corp, phish)` (including, hypothetically, a row sharing the same id)
- **WHEN** `eventStore.query([{owner: "acme", repo: "foo"}]).where('id', '=', 'evt_abc').orderBy('seq', 'asc').execute()` is called
- **THEN** the EventStore SHALL return exactly the `N+1` events for `evt_abc` belonging to scope `(acme, foo)`
- **AND** no row from any other scope SHALL appear, regardless of id

### Requirement: query property exposes read-only SelectQueryBuilder

The `query(scopes)` method SHALL return a Kysely `SelectQueryBuilder` pre-scoped to the `events` table AND pre-bound with the scope allow-list clause. Consumers chain `.where()`, `.select()`, `.groupBy()`, `.execute()`, etc. The returned builder SHALL NOT expose insert, update, or delete capabilities.

Additional `.where()` predicates added by the caller SHALL be additive (Kysely AND-combines them); the scope binding cannot be removed by the caller.

#### Scenario: Query by workflow within a scope

- **GIVEN** an EventStore with invocations for workflows "foo" and "bar" in `(acme, foo)`, plus invocations for workflow "foo" in `(other, repo)`
- **WHEN** `eventStore.query([{owner: "acme", repo: "foo"}]).where('workflow', '=', 'foo').selectAll().execute()` is called
- **THEN** only the `(acme, foo)` invocations for workflow "foo" are returned

#### Scenario: Aggregation query within a scope

- **GIVEN** an EventStore with 3 invocations for "foo" and 2 for "bar" in `(acme, foo)`, plus 5 invocations in `(other, repo)`
- **WHEN** a GROUP BY query with `eb.fn.count('id')` is executed via `eventStore.query([{owner: "acme", repo: "foo"}])`
- **THEN** results show foo=3, bar=2 (no contribution from `(other, repo)`)

### Requirement: Security context

The implementation SHALL conform to the owner/repo isolation invariant documented at `/SECURITY.md §1 "Owner/repo isolation invariants"` (I-T2, renamed). The `EventStore.query(scopes)` API is the load-bearing enforcement point for this invariant on invocation-event reads: the required `scopes` argument is pre-bound into a `WHERE (owner, repo) IN (...)` clause on the returned Kysely `SelectQueryBuilder`, and no unscoped read API is exposed. This makes scope-omission structurally impossible — a caller cannot construct a read against the `events` table without supplying at least one `(owner, repo)` scope at the call site.

Because `query` accepts a caller-supplied allow-list rather than a single identifier, the invariant has one additional clause: **every caller of `query` MUST resolve the scope list from a trusted source** (the authenticated user's owner-membership intersected with registered `(owner, repo)` bundles). Passing a user-supplied path parameter directly into `scopes` is a defect. The runtime SHALL provide a single helper (e.g. `resolveQueryScopes(user, constraint?)`) that middleware uses to produce scope lists; call sites SHALL route through this helper and SHALL NOT construct scope lists from untrusted input.

Changes to this capability that introduce a new read path against the `events` table (including new public methods on `EventStore`, new utilities that accept a `Kysely` instance, or re-exports that would allow a consumer to build a query bypassing `query(scopes)`), or that weaken the pre-binding behaviour of `query(scopes)`, MUST update `/SECURITY.md §1` in the same change proposal.

#### Scenario: Change introduces a new read path

- **GIVEN** a change proposal that adds a new method, re-export, or utility that allows consumers to read from the `events` table
- **WHEN** the change is proposed
- **THEN** the proposal SHALL demonstrate that the new read path is scope-bound at its API surface (the `scopes` argument is required and the scopes cannot be removed by the caller)
- **AND** the proposal SHALL update `/SECURITY.md §1 "Owner/repo isolation invariants"` to reference the new read path

#### Scenario: Change is orthogonal to the invariant

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not introduce a new read path and does not alter the `query(scopes)` pre-binding
- **THEN** no update to `/SECURITY.md §1` is required
- **AND** the proposal SHALL note that owner/repo-isolation alignment was checked

#### Scenario: Middleware routes scope resolution through the helper

- **GIVEN** a dashboard handler that needs to query events for the current user
- **WHEN** the handler builds a scope list
- **THEN** it SHALL call `resolveQueryScopes(user)` (or an equivalent trusted helper)
- **AND** SHALL NOT construct `{owner, repo}` entries from request path parameters or query-string input
