# Event Store Specification

## Purpose

Provide an in-memory DuckDB-based invocation index that implements BusConsumer, enabling SQL queries over invocation lifecycle records for the dashboard.
## Requirements
### Requirement: EventStore is the sole consumer of invocation lifecycle events

The runtime SHALL host a single `EventStore` component that owns durable storage of invocation events and serves all queries over them. There SHALL NOT be an event bus, a separate persistence consumer, a recovery scan path, or a logging consumer in the runtime; their responsibilities collapse into the executor (lifecycle logging) and the EventStore (durable archive + queries).

EventStore SHALL be created via `createEventStore({ persistenceRoot, logger, config })`, where `persistenceRoot` is the absolute filesystem path under which the DuckDB database file lives, `logger` is the runtime logger, and `config` carries the `EVENT_STORE_*` settings. The factory SHALL return a Promise that resolves once the DuckDB database file has been opened (creating it on first boot, or replaying its WAL on subsequent boots).

#### Scenario: Factory opens the database and resolves ready

- **WHEN** `createEventStore({ persistenceRoot, logger, config })` is awaited against an empty directory
- **THEN** the returned object exposes `record`, `query`, `hasUploadEvent`, `ping`, `drainAndClose`
- **AND** the file `<persistenceRoot>/events.duckdb` has been created
- **AND** the connection is ready to accept `record` and `query` calls

#### Scenario: Factory opens an existing database without scanning per-invocation files

- **GIVEN** an existing `<persistenceRoot>/events.duckdb` containing a million archived invocations
- **WHEN** `createEventStore` is awaited
- **THEN** the factory SHALL NOT enumerate, list, or read per-invocation archive files
- **AND** the factory SHALL resolve in time bounded by the database file open + WAL replay, not by historical event count

### Requirement: DuckDB-backed durable archive

EventStore SHALL persist invocation events using a plain DuckDB database file at `<persistenceRoot>/events.duckdb`. There SHALL NOT be a separate Parquet directory, a lakehouse catalog, or any DuckDB extension load (`ducklake`, `httpfs`) at boot.

The events table SHALL have columns: `id` (text), `seq` (integer), `kind` (text), `ref` (integer, nullable), `at` (TIMESTAMPTZ), `ts` (BIGINT, monotonic µs), `owner` (text NOT NULL), `repo` (text NOT NULL), `workflow` (text), `workflowSha` (text), `name` (text), `input` (JSON, nullable), `output` (JSON, nullable), `error` (JSON, nullable), `meta` (JSON, nullable).

The events table SHALL declare `PRIMARY KEY (id, seq)`. EventStore SHALL also create a secondary index on `(owner, repo)` to bound scope-filtered scans.

Idempotency is enforced by the `PRIMARY KEY (id, seq)` constraint. The in-memory accumulator continues to evict on successful commit; PK violations during retry are treated as fatal (see "Bounded retry then drop") because pre-eviction structurally prevents legitimate duplicate inserts — a PK conflict signals a logic bug, not a transient.

#### Scenario: Database file is created at the configured path

- **GIVEN** a fresh `PERSISTENCE_PATH=/var/lib/wfe`
- **WHEN** EventStore initialises and commits an invocation under `(owner: "acme", repo: "foo")`
- **THEN** `/var/lib/wfe/events.duckdb` SHALL exist
- **AND** no `/var/lib/wfe/events/` Parquet directory SHALL be created

#### Scenario: Events table declares PRIMARY KEY (id, seq)

- **GIVEN** a freshly-initialised EventStore
- **WHEN** the schema is inspected via `PRAGMA table_info(events)` or `SHOW TABLES`
- **THEN** the events table SHALL declare a `PRIMARY KEY` over `(id, seq)`
- **AND** an index on `(owner, repo)` SHALL exist

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

When a DuckDB commit fails (file I/O error, lock contention), EventStore SHALL retry with exponential backoff. The maximum number of attempts is `EVENT_STORE_COMMIT_MAX_RETRIES` (default 5). The base backoff between attempts is `EVENT_STORE_COMMIT_BACKOFF_MS` (default 500 ms), doubling each attempt up to a sensible cap. On each retry attempt, EventStore SHALL log `event-store.commit-retry { id, owner, repo, attempt, error }`.

If the commit fails with a `PRIMARY KEY` constraint violation, EventStore SHALL NOT retry. PK violations indicate a logic bug (the accumulator pre-eviction makes legitimate duplicates structurally impossible). EventStore SHALL log `event-store.commit-dropped { id, owner, repo, reason: "primary-key-violation", error }`, evict the accumulator entry, and continue.

If all transient retries are exhausted, EventStore SHALL log `event-store.commit-dropped { id, owner, repo, attempts, error }`, evict the accumulator entry for that id, and continue. The `record()` Promise SHALL resolve normally — the runtime SHALL NOT exit on commit-drop. The dropped invocation SHALL NOT appear in subsequent `query()` results.

#### Scenario: Successful retry after transient failure

- **GIVEN** EventStore is committing a terminal for `evt_a`
- **AND** the first commit attempt fails with a transient I/O error
- **AND** the second attempt succeeds
- **THEN** `record()` SHALL resolve normally
- **AND** one `event-store.commit-retry { id: "evt_a", attempt: 1 }` log line SHALL have been emitted
- **AND** one `event-store.commit-ok` log line SHALL have been emitted
- **AND** the events table SHALL contain rows for `evt_a`

#### Scenario: PK violation is fatal-drop, not retried

- **GIVEN** EventStore is committing a terminal whose batch would conflict with an existing `(id, seq)` row
- **WHEN** the commit attempt fails with a PRIMARY KEY violation
- **THEN** EventStore SHALL NOT retry the commit
- **AND** EventStore SHALL log `event-store.commit-dropped { reason: "primary-key-violation", id, owner, repo, error }`
- **AND** the accumulator entry for that id SHALL be cleared
- **AND** subsequent `query()` results SHALL reflect the pre-existing committed state

#### Scenario: Drop after transient retry exhaustion

- **GIVEN** EventStore is committing a terminal for `evt_a` with `EVENT_STORE_COMMIT_MAX_RETRIES=2`
- **AND** every commit attempt fails with a transient I/O error
- **WHEN** `record()` is awaited
- **THEN** `record()` SHALL resolve without throwing
- **AND** an `event-store.commit-dropped { id: "evt_a", attempts: 2, error }` log line SHALL have been emitted
- **AND** the accumulator entry for `evt_a` SHALL be cleared
- **AND** subsequent `query()` calls SHALL NOT return any rows for `evt_a`
- **AND** the runtime process SHALL still be running

### Requirement: SIGTERM drain commits in-flight invocations

On SIGTERM, EventStore SHALL drain in-flight invocations within `EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS` (default 60 000 ms). For each invocation in the accumulator, EventStore SHALL synthesise a terminal `trigger.error { reason: "shutdown" }` event with the next seq number, append it to the accumulator, and commit. After all accumulator entries are drained or the timeout elapses, EventStore SHALL close the DuckDB connection and resolve.

`EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS` MUST be less than the systemd `TimeoutStopSec` of the Quadlet unit; otherwise the unit is killed mid-drain. The Quadlet template owns `TimeoutStopSec`; the runtime owns the drain timeout. See the `infrastructure` capability for the unit-side timeout.

If the timeout elapses before all invocations are drained, the remaining in-flight invocations are lost (same outcome as SIGKILL for those entries). EventStore SHALL log `event-store.sigterm-drain-timeout { remaining }` in that case.

#### Scenario: Graceful drain commits each in-flight as trigger.error{shutdown}

- **GIVEN** EventStore's accumulator holds non-terminal events for `evt_a` and `evt_b`
- **WHEN** SIGTERM is delivered and the drain runs to completion within the timeout
- **THEN** the events table SHALL contain a `trigger.error { reason: "shutdown" }` terminal row for both `evt_a` and `evt_b`
- **AND** the accumulator SHALL be empty
- **AND** the DuckDB connection SHALL be closed

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

EventStore SHALL NOT implement runtime split-brain coordination. DuckDB acquires an exclusive file lock on `events.duckdb` at open. A second writer process attempting to open the same file SHALL fail fast with a lock error and exit non-zero; the running writer's data SHALL NOT be affected.

The deployment contract is encoded in the `infrastructure` capability: exactly one Quadlet `wfe-<env>.container` unit per env on a single VPS, with `podman-auto-update.timer` rotating the unit sequentially (stop, pull, start) on the same data dir. There is no orchestrator that could spawn a second concurrent process for the same env, and the upgrade path has no overlap window between an old and new container holding the file. EventStore therefore relies on the deployment shape, not on an internal fence.

#### Scenario: Second writer fails fast on file lock

- **GIVEN** a runtime process holding `<persistenceRoot>/events.duckdb` open
- **WHEN** a second process invokes `createEventStore` against the same path
- **THEN** the second factory SHALL reject with a lock error
- **AND** the first process SHALL continue serving without data loss or corruption

### Requirement: Module exports

The runtime SHALL export `createEventStore`, the `EventStore` interface, the Kysely `Database` type for the events table, the `Scope` type, and re-export `sql` from `kysely` so consumers do not import `kysely` directly. The module path SHALL be `packages/runtime/src/event-store.ts`.

#### Scenario: Consumers import from the canonical path

- **WHEN** `auth/scopes.ts` imports `EventStore`
- **THEN** the import SHALL resolve from `../event-store.js` (relative)

