## ADDED Requirements

### Requirement: EventStore is the sole consumer of invocation lifecycle events

The runtime SHALL host a single `EventStore` component that owns durable storage of invocation events and serves all queries over them. There SHALL NOT be an event bus, a separate persistence consumer, a recovery scan path, or a logging consumer in the runtime; their responsibilities collapse into the executor (lifecycle logging) and the EventStore (durable archive + queries).

EventStore SHALL be created via `createEventStore({ backend, logger, config })`, where `backend` is a `StorageBackend` whose `locator()` provides the concrete connection used to configure DuckLake, `logger` is the runtime logger, and `config` carries the `EVENT_STORE_*` settings. The factory SHALL return a Promise that resolves once the DuckLake catalog has been opened (downloaded for the S3 backend, or attached locally for the FS backend).

#### Scenario: Factory opens the catalog and resolves ready

- **WHEN** `createEventStore({ backend, logger, config })` is awaited against an empty backend
- **THEN** the returned object exposes `record`, `query`, `hasUploadEvent`, `ping`, `dispose`
- **AND** the DuckLake catalog file `<root>/events.duckdb` has been created or attached
- **AND** the connection is ready to accept `record` and `query` calls

#### Scenario: Factory opens an existing catalog without scanning per-invocation files

- **GIVEN** an existing `<root>/events.duckdb` containing a million archived invocations
- **WHEN** `createEventStore` is awaited
- **THEN** the factory SHALL NOT enumerate, list, or read per-invocation archive files
- **AND** the factory SHALL resolve in time bounded by the catalog file fetch / open, not by historical event count

### Requirement: DuckLake-backed durable archive

EventStore SHALL persist invocation events using DuckLake v1.0 as the storage format. The catalog SHALL be a DuckDB file at `<root>/events.duckdb`. Data files SHALL be Parquet files partitioned by `(owner, repo)` under `<root>/events/main/events/owner=<owner>/repo=<repo>/` (DuckLake nests under `<schema>/<table>` beneath the configured `DATA_PATH`; `main` is the default schema and `events` is the table name). EventStore SHALL configure DuckLake by translating the `StorageBackend.locator()` result into the appropriate `ATTACH 'ducklake:…'` and (for the S3 backend) `CREATE SECRET (TYPE S3, …)` SQL.

The events table SHALL have columns: `id` (text), `seq` (integer), `kind` (text), `ref` (integer, nullable), `at` (TIMESTAMPTZ), `ts` (BIGINT, monotonic µs), `owner` (text NOT NULL), `repo` (text NOT NULL), `workflow` (text), `workflowSha` (text), `name` (text), `input` (JSON, nullable), `output` (JSON, nullable), `error` (JSON, nullable), `meta` (JSON, nullable).

The events table SHALL NOT declare a `PRIMARY KEY` or `UNIQUE` constraint — DuckLake does not support either. Idempotency is enforced at the application layer: each terminal commit is one DuckLake transaction inserting all rows for an invocation atomically, and the in-memory accumulator entry is evicted only after a successful commit. Retries only occur when the commit's Promise rejects, so a successful-but-acknowledged-as-failed commit (the only window in which a duplicate could appear) requires a network failure between DuckLake's commit and the client receiving the success — a narrow, ambiguous edge case that the runtime accepts (the `(id, seq)` tuple uniquely identifies events, and dashboard queries deduplicate-on-display if needed).

#### Scenario: Catalog and data files use the events prefix

- **GIVEN** an FS backend with `PERSISTENCE_PATH=/var/lib/wfe`
- **WHEN** EventStore commits an invocation under `(owner: "acme", repo: "foo")` and a `CHECKPOINT` has flushed inlined rows to Parquet
- **THEN** the catalog SHALL exist at `/var/lib/wfe/events.duckdb`
- **AND** at least one Parquet file SHALL exist under `/var/lib/wfe/events/main/events/owner=acme/repo=foo/`

#### Scenario: S3 backend translates locator into DuckLake SECRET

- **GIVEN** an S3 backend whose `locator()` returns `{ kind: "s3", bucket: "wfe", endpoint: "s2.local:9000", region: "auto", accessKeyId, secretAccessKey, urlStyle: "path", useSsl: true }`
- **WHEN** EventStore initialises
- **THEN** DuckLake SHALL be configured with `ATTACH 'ducklake:s3://wfe/events.duckdb'` and the matching `DATA_PATH 's3://wfe/events/'`
- **AND** a `CREATE SECRET (TYPE S3, KEY_ID, SECRET, REGION, ENDPOINT, URL_STYLE, USE_SSL)` SQL statement SHALL have run with the locator's values
- **AND** secret values SHALL be revealed via `Secret.reveal()` only at the SQL composition site

### Requirement: record() accumulates events and commits per terminal invocation

EventStore SHALL expose `record(event: InvocationEvent): Promise<void>`. Each call SHALL append the event to an in-memory accumulator keyed by `event.id`. On terminal events (`event.kind === "trigger.response"` or `event.kind === "trigger.error"`), `record` SHALL commit the full accumulated event list for that id as a single DuckLake transaction (`INSERT INTO events VALUES …` for every event), then evict the accumulator entry.

Non-terminal events SHALL NOT trigger any storage I/O. There SHALL NOT be per-event durability; in-flight events live only in RAM.

`record()` SHALL resolve once the commit has either succeeded or been dropped per the retry policy (see "Bounded retry then drop"). It SHALL NOT throw on commit failure under any condition the retry policy can handle.

#### Scenario: Non-terminal events accumulate without I/O

- **GIVEN** an EventStore with an empty accumulator
- **WHEN** `record({ kind: "action.request", id: "evt_a", seq: 1, … })` is called
- **THEN** the accumulator entry for `evt_a` SHALL contain that event
- **AND** no DuckLake write SHALL have occurred

#### Scenario: Terminal event commits the entire accumulated list atomically

- **GIVEN** an EventStore whose accumulator for `evt_a` holds events with seqs 0, 1, 2
- **WHEN** `record({ kind: "trigger.response", id: "evt_a", seq: 3, … })` is called and the commit succeeds
- **THEN** the events table SHALL contain exactly four rows for id `evt_a` (seqs 0, 1, 2, 3)
- **AND** the accumulator entry for `evt_a` SHALL be removed
- **AND** an `event-store.commit-ok { id: "evt_a", durationMs, etag }` log line SHALL have been emitted

#### Scenario: trigger.error terminal commits identically

- **GIVEN** an EventStore whose accumulator for `evt_a` holds events with seqs 0, 1
- **WHEN** `record({ kind: "trigger.error", id: "evt_a", seq: 2, error: { … } })` is called and the commit succeeds
- **THEN** the events table SHALL contain three rows for `evt_a`
- **AND** the accumulator entry SHALL be removed

### Requirement: Bounded retry then drop on commit failure

When a DuckLake commit fails (S3 transient error, catalog write error), EventStore SHALL retry with exponential backoff. The maximum number of attempts is `EVENT_STORE_COMMIT_MAX_RETRIES` (default 5). The base backoff between attempts is `EVENT_STORE_COMMIT_BACKOFF_MS` (default 500 ms), doubling each attempt up to a sensible cap. On each retry attempt, EventStore SHALL log `event-store.commit-retry { id, owner, repo, attempt, error }`.

If all retries are exhausted, EventStore SHALL log `event-store.commit-dropped { id, owner, repo, attempts, error }`, evict the accumulator entry for that id, and continue. The `record()` Promise SHALL resolve normally — the runtime SHALL NOT exit on commit-drop. The dropped invocation SHALL NOT appear in subsequent `query()` results.

#### Scenario: Successful retry after transient failure

- **GIVEN** EventStore is committing a terminal for `evt_a`
- **AND** the first commit attempt fails with a transient network error
- **AND** the second attempt succeeds
- **THEN** `record()` SHALL resolve normally
- **AND** one `event-store.commit-retry { id: "evt_a", attempt: 1 }` log line SHALL have been emitted
- **AND** one `event-store.commit-ok` log line SHALL have been emitted
- **AND** the events table SHALL contain rows for `evt_a`

#### Scenario: Drop after retry exhaustion

- **GIVEN** EventStore is committing a terminal for `evt_a` with `EVENT_STORE_COMMIT_MAX_RETRIES=2`
- **AND** every commit attempt fails
- **WHEN** `record()` is awaited
- **THEN** `record()` SHALL resolve without throwing
- **AND** an `event-store.commit-dropped { id: "evt_a", attempts: 2, error }` log line SHALL have been emitted
- **AND** the accumulator entry for `evt_a` SHALL be cleared
- **AND** subsequent `query()` calls SHALL NOT return any rows for `evt_a`
- **AND** the runtime process SHALL still be running

### Requirement: SIGTERM drain commits in-flight invocations

On SIGTERM, EventStore SHALL drain in-flight invocations within `EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS` (default 60 000 ms, MUST be less than the K8s `terminationGracePeriodSeconds`). For each invocation in the accumulator, EventStore SHALL synthesise a terminal `trigger.error { reason: "shutdown" }` event with the next seq number, append it to the accumulator, and commit. After all accumulator entries are drained or the timeout elapses, EventStore SHALL call `dispose()` to close the DuckLake connection and resolve.

If the timeout elapses before all invocations are drained, the remaining in-flight invocations are lost (same outcome as SIGKILL for those entries). EventStore SHALL log `event-store.sigterm-drain-timeout { remaining }` in that case.

#### Scenario: Graceful drain commits each in-flight as trigger.error{shutdown}

- **GIVEN** EventStore's accumulator holds non-terminal events for `evt_a` and `evt_b`
- **WHEN** SIGTERM is delivered and the drain runs to completion within the timeout
- **THEN** the events table SHALL contain a `trigger.error { reason: "shutdown" }` terminal row for both `evt_a` and `evt_b`
- **AND** the accumulator SHALL be empty
- **AND** the DuckLake connection SHALL be closed

#### Scenario: Drain timeout logs and drops the remaining

- **GIVEN** EventStore's accumulator holds 1000 entries
- **AND** `EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS` is 100 ms (insufficient)
- **WHEN** SIGTERM triggers the drain
- **THEN** as many entries as the timeout permits SHALL be committed
- **AND** an `event-store.sigterm-drain-timeout { remaining }` log line SHALL have been emitted naming the unflushed count

### Requirement: SIGKILL loses in-flight invocations

SIGKILL, OOM, force-delete, kernel panic, or any unclean process death SHALL cause all events held only in the in-memory accumulator to be lost. There SHALL NOT be a per-event WAL, an `orphans/` spill prefix, or any other on-disk record of in-flight events. Cold start of a fresh process SHALL NOT attempt to recover such invocations.

#### Scenario: Process dies mid-invocation

- **GIVEN** EventStore's accumulator holds events for `evt_a` whose terminal has not yet been committed
- **WHEN** the process is terminated by SIGKILL
- **AND** a fresh process starts against the same backend
- **THEN** `query()` SHALL NOT return any rows for `evt_a`
- **AND** no recovery scan, replay, or synthetic terminal SHALL be attempted

### Requirement: Background CHECKPOINT compacts the catalog and data files

EventStore SHALL run DuckLake's `CHECKPOINT` operation in the background according to the configured triggers. Triggers (logical OR):

- `EVENT_STORE_CHECKPOINT_INTERVAL_MS` elapsed since the last successful checkpoint (default 3 600 000 = 1 h),
- inlined-row count exceeds `EVENT_STORE_CHECKPOINT_MAX_INLINED_ROWS` (default 100 000),
- catalog file size exceeds `EVENT_STORE_CHECKPOINT_MAX_CATALOG_BYTES` (default 10 485 760 = 10 MiB).

`CHECKPOINT` SHALL flush inlined rows to Parquet, merge small Parquets, apply deletion vectors, and update the catalog snapshot. EventStore SHALL expire snapshots on every checkpoint (no time-travel retention). EventStore SHALL log `event-store.checkpoint-run { durationMs, catalogBytesBefore, catalogBytesAfter, inlinedRowsFlushed, filesCompacted }` on success and `event-store.checkpoint-skip { reason: "no-work" }` when no work is required.

`CHECKPOINT` SHALL run on the same DuckDB connection that owns writes, off the commit hot path. It SHALL NOT block `record()` calls beyond DuckDB's normal connection-level serialisation.

#### Scenario: Timer-driven checkpoint runs once interval elapses

- **GIVEN** EventStore configured with `EVENT_STORE_CHECKPOINT_INTERVAL_MS=1000` and no other thresholds tripping
- **AND** at least one commit has occurred since the last checkpoint
- **WHEN** 1100 ms have elapsed since the last checkpoint
- **THEN** EventStore SHALL run `CHECKPOINT`
- **AND** an `event-store.checkpoint-run` log line SHALL have been emitted

#### Scenario: Threshold-driven checkpoint after enough inlined rows

- **GIVEN** EventStore configured with `EVENT_STORE_CHECKPOINT_MAX_INLINED_ROWS=100`
- **WHEN** the inlined-row count crosses 100
- **THEN** EventStore SHALL trigger `CHECKPOINT` without waiting for the interval timer

#### Scenario: Skip checkpoint when there is no work

- **GIVEN** EventStore has not committed any new event since the last checkpoint
- **WHEN** the interval timer fires
- **THEN** EventStore SHALL log `event-store.checkpoint-skip { reason: "no-work" }`
- **AND** SHALL NOT run a no-op `CHECKPOINT`

### Requirement: query exposes a scope-bound Kysely SelectQueryBuilder

EventStore SHALL expose `query(scopes: readonly Scope[]): SelectQueryBuilder<Database, "events", object>` where `Scope = { owner: string; repo: string }`. The returned builder SHALL be pre-filtered to rows whose `(owner, repo)` is in the supplied allow-list. An empty `scopes` argument SHALL throw — empty allow-lists must never compile to a tautological `WHERE 1=0` or `WHERE 1=1` and silently leak or hide data.

The query path SHALL execute against the DuckLake-attached events table. Partition pruning on `(owner, repo)` SHALL bound scan cost to the relevant Parquet files.

#### Scenario: Single-scope query returns only that owner/repo's rows

- **GIVEN** EventStore contains rows for `(acme, foo)` and `(acme, bar)`
- **WHEN** a caller invokes `query([{ owner: "acme", repo: "foo" }]).execute()`
- **THEN** the result SHALL contain only the `(acme, foo)` rows

#### Scenario: Empty scope list throws

- **WHEN** a caller invokes `query([])`
- **THEN** the call SHALL throw an Error
- **AND** the message SHALL mention that scopes must be a non-empty (owner, repo) allow-list

### Requirement: hasUploadEvent gates duplicate workflow uploads

EventStore SHALL expose `hasUploadEvent(owner: string, repo: string, workflow: string, workflowSha: string): Promise<boolean>` returning true iff a `system.upload` event already exists for the exact `(owner, repo, workflow, workflowSha)` tuple. This method bypasses the scope allow-list contract that `query()` enforces because the upload handler authorises `(owner, repo)` via `requireOwnerMember()`. Other callers MUST NOT use this method to fetch event data.

#### Scenario: Returns true for an existing upload

- **GIVEN** EventStore has a row with `kind: "system.upload"`, `owner: "acme"`, `repo: "foo"`, `workflow: "main"`, `workflowSha: "sha1"`
- **WHEN** `hasUploadEvent("acme", "foo", "main", "sha1")` resolves
- **THEN** the result SHALL be `true`

#### Scenario: Returns false for an unseen sha

- **WHEN** `hasUploadEvent("acme", "foo", "main", "sha-never-uploaded")` resolves
- **THEN** the result SHALL be `false`

### Requirement: ping verifies the DuckLake connection

EventStore SHALL expose `ping(): Promise<void>` that runs `SELECT 1` against the DuckDB connection holding the DuckLake catalog. `ping()` SHALL resolve on success and reject on failure. The readiness endpoint (`/readyz`) consumes this to determine whether the runtime is serving.

#### Scenario: Ping succeeds when the connection is healthy

- **WHEN** `ping()` is awaited on a healthy EventStore
- **THEN** it SHALL resolve with no value

#### Scenario: Ping rejects when the connection is broken

- **GIVEN** the DuckDB connection has been closed
- **WHEN** `ping()` is awaited
- **THEN** it SHALL reject with the underlying connection error

### Requirement: Single-writer is a deployment contract

EventStore SHALL NOT implement runtime split-brain fencing. The catalog round-trip uses an unconditional PUT, because S2 (local development) and UpCloud Object Storage (production) do not implement `If-Match` conditional PUT. Single-writer correctness depends on the Kubernetes Deployment manifest enforcing `replicas: 1` with `strategy: Recreate` (see the `infrastructure` capability). Operating with two concurrent writers SHALL silently corrupt the catalog. This regression is documented in `SECURITY.md` and `docs/upgrades.md`.

#### Scenario: Catalog PUT does not include If-Match

- **WHEN** EventStore commits a terminal and PUTs the catalog file to S3
- **THEN** the request SHALL NOT include an `If-Match` header
- **AND** the response ETag SHALL be logged as part of `event-store.commit-ok` for ops visibility only — never used as a guard

### Requirement: Module exports

The runtime SHALL export `createEventStore`, the `EventStore` interface, the Kysely `Database` type for the events table, the `Scope` type, and re-export `sql` from `kysely` so consumers do not import `kysely` directly. The module path SHALL be `packages/runtime/src/event-store.ts` (no longer under `event-bus/`, which has been removed).

#### Scenario: Consumers import from the canonical path

- **WHEN** `auth/scopes.ts` imports `EventStore`
- **THEN** the import SHALL resolve from `../event-store.js` (relative)

## REMOVED Requirements

### Requirement: EventStore implements BusConsumer

**Reason**: The bus abstraction is removed (only one consumer remains and the strict-vs-best-effort tier collapsed when the per-event WAL was removed). EventStore is now invoked directly by the executor.

**Migration**: Replace `bus.emit(event)` (with EventStore registered as a consumer) with `eventStore.record(event)` direct calls from `executor/index.ts`.

### Requirement: DuckDB in-memory storage

**Reason**: EventStore now uses DuckLake (catalog + Parquet) for durable storage. There is no longer an in-memory-only DuckDB layer that must be rebuilt from an archive on boot.

**Migration**: The in-memory archive bootstrap is gone. Cold start opens the DuckLake catalog file and is constant-time regardless of historical event count.

### Requirement: EventStore indexes invocation events

**Reason**: Schema and write-path requirements are folded into the new "DuckLake-backed durable archive" and "record() accumulates events and commits per terminal invocation" requirements above. The events table schema is the same; the storage substrate is different.

**Migration**: Existing schema is preserved (same columns, same `(id, seq)` PK). Producers continue to populate every column the same way they did under the in-memory implementation.

### Requirement: EventStore bootstraps from persistence at init

**Reason**: There is no longer an archive scan at boot. The DuckLake catalog opens directly and is the live store; there is no separate "bootstrap from disk" step.

**Migration**: Operators wipe legacy `archive/` and `pending/` artefacts before deploying the new code (see `docs/upgrades.md`). Historical events from before the cutover are not migrated.

### Requirement: handle() inserts event row (non-fatal)

**Reason**: Replaced by the new `record()` method which is the only entry point for event storage. The strict-vs-non-fatal distinction is gone (the bus is gone). Failures are now handled by the bounded retry-then-drop policy on terminals.

**Migration**: Callers of `handle()` (only the bus, now removed) are replaced by direct `eventStore.record()` calls.

### Requirement: Liveness ping

**Reason**: Renamed and clarified under "ping verifies the DuckLake connection" above. The shape (`ping(): Promise<void>` running `SELECT 1`) is preserved; the description now reflects the DuckLake substrate.

**Migration**: No code changes; the method signature is unchanged.

### Requirement: Module re-exports Kysely utilities

**Reason**: Folded into the new "Module exports" requirement above. The re-exports are unchanged in substance; only the file path moves from `event-bus/event-store.ts` to `event-store.ts`.

**Migration**: Update import paths from `./event-bus/event-store.js` to `./event-store.js`.

### Requirement: Query latest invocations

**Reason**: Folded into the new "query exposes a scope-bound Kysely SelectQueryBuilder" requirement. The CTE-chaining helpers (`with(name, fn)`) are preserved; the underlying connection is now DuckLake-attached.

**Migration**: Dashboard queries continue to use `eventStore.query(scopes)` and the `with()` helper unchanged.

### Requirement: query property exposes read-only SelectQueryBuilder

**Reason**: Folded into the new "query exposes a scope-bound Kysely SelectQueryBuilder" requirement.

**Migration**: No call-site change; same interface, same return shape.

### Requirement: EventStore module exports

**Reason**: Folded into the new "Module exports" requirement. The list of exports is unchanged in substance; only the file path moves.

**Migration**: Update import paths.

### Requirement: Security context

**Reason**: The security-relevant invariants (scope-allow-list enforcement, `hasUploadEvent` bypass justification) are restated inline in the new "query exposes a scope-bound Kysely SelectQueryBuilder" and "hasUploadEvent gates duplicate workflow uploads" requirements above. The catalog round-trip's relationship to single-writer correctness is captured in "Single-writer is a deployment contract".

**Migration**: No call-site change; the invariants continue to hold.
