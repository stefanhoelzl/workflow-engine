# Event Store Specification

## Purpose

Provide a libSQL-backed invocation index that implements BusConsumer, enabling SQL queries over invocation lifecycle records for the dashboard.
## Requirements
### Requirement: EventStore is the sole consumer of invocation lifecycle events

The runtime SHALL host a single `EventStore` component that owns durable storage of invocation events and serves all queries over them. There SHALL NOT be an event bus, a separate persistence consumer, a recovery scan path, or a logging consumer in the runtime; their responsibilities collapse into the executor (lifecycle logging) and the EventStore (durable archive + queries).

EventStore SHALL be created via `createEventStore({ db, logger, config })`, where `db` is a libSQL-backed `Kysely<Database>` (the caller builds it from the configured connection, e.g. `file:<PERSISTENCE_PATH>/events.db`, and owns the underlying client's lifecycle), `logger` is the runtime logger, and `config` carries the `EVENT_STORE_*` settings. The factory SHALL return a Promise that resolves once the schema has been ensured (idempotent `CREATE TABLE/INDEX IF NOT EXISTS`).

#### Scenario: Factory ensures the schema and resolves ready

- **WHEN** `createEventStore({ db, logger, config })` is awaited against a fresh libSQL database
- **THEN** the returned object exposes `record`, `query`, `hasUploadEvent`, `ping`, `drainAndClose`
- **AND** the `events` table and its read index exist
- **AND** the connection is ready to accept `record` and `query` calls

#### Scenario: Factory opens an existing database without scanning per-invocation files

- **GIVEN** an existing libSQL `events.db` containing a million archived invocations
- **WHEN** `createEventStore` is awaited
- **THEN** the factory SHALL NOT enumerate, list, or read per-invocation archive files
- **AND** the factory SHALL resolve in time bounded by ensuring the schema, not by historical event count

### Requirement: record() accumulates events and commits per terminal invocation

EventStore SHALL expose `record(event: InvocationEvent): Promise<void>`. Each call SHALL append the event to an in-memory accumulator keyed by `event.id`. On terminal events (`event.kind === "trigger.response"` or `event.kind === "trigger.error"`), `record` SHALL commit the full accumulated event list for that id as a single batch insert (`INSERT INTO events VALUES …` for every event), then evict the accumulator entry.

Non-terminal events SHALL NOT trigger any storage I/O. There SHALL NOT be per-event durability; in-flight events live only in RAM.

`record()` SHALL resolve once the commit has either succeeded or been dropped per the retry policy (see "Bounded retry then drop"). It SHALL NOT throw on commit failure under any condition the retry policy can handle.

#### Scenario: Non-terminal events accumulate without I/O

- **GIVEN** an EventStore with an empty accumulator
- **WHEN** `record({ kind: "action.request", id: "evt_a", seq: 1, … })` is called
- **THEN** the accumulator entry for `evt_a` SHALL contain that event
- **AND** no write to the events table SHALL have occurred

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

When a commit fails (file I/O error, lock contention), EventStore SHALL retry with exponential backoff. The maximum number of attempts is `EVENT_STORE_COMMIT_MAX_RETRIES` (default 5). The base backoff between attempts is `EVENT_STORE_COMMIT_BACKOFF_MS` (default 500 ms), doubling each attempt up to a sensible cap. On each retry attempt, EventStore SHALL log `event-store.commit-retry { id, owner, repo, attempt, error }`.

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

On SIGTERM, EventStore SHALL drain in-flight invocations within `EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS` (default 60 000 ms). Before draining, `drainAndClose` SHALL clear the retention timer (if one was scheduled) so that no new prune starts during shutdown. For each invocation in the accumulator, EventStore SHALL synthesise a terminal `trigger.error { reason: "shutdown" }` event with the next seq number, append it to the accumulator, and commit. After all accumulator entries are drained or the timeout elapses, EventStore SHALL destroy its Kysely handle and resolve (the caller closes the shared libSQL client).

`drainAndClose` SHALL NOT add prune execution time to the drain budget: it guarantees no *new* prune starts once shutting down, but a prune already in flight that does not finish before process exit is cut off by the exit. Because each prune is a single atomic DELETE, an interrupted prune rolls back on next open with no partial deletion, and is retried on the next boot's schedule.

`EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS` MUST be less than the systemd `TimeoutStopSec` of the Quadlet unit; otherwise the unit is killed mid-drain. The Quadlet template owns `TimeoutStopSec`; the runtime owns the drain timeout. See the `infrastructure` capability for the unit-side timeout.

If the timeout elapses before all invocations are drained, the remaining in-flight invocations are lost (same outcome as SIGKILL for those entries). EventStore SHALL log `event-store.sigterm-drain-timeout { remaining }` in that case.

#### Scenario: Graceful drain commits each in-flight as trigger.error{shutdown}

- **GIVEN** EventStore's accumulator holds non-terminal events for `evt_a` and `evt_b`
- **WHEN** SIGTERM is delivered and the drain runs to completion within the timeout
- **THEN** the events table SHALL contain a `trigger.error { reason: "shutdown" }` terminal row for both `evt_a` and `evt_b`
- **AND** the accumulator SHALL be empty
- **AND** the Kysely handle SHALL be destroyed

#### Scenario: Drain timeout logs and drops the remaining

- **GIVEN** EventStore's accumulator holds 1000 entries
- **AND** `EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS` is 100 ms (insufficient)
- **WHEN** SIGTERM triggers the drain
- **THEN** as many entries as the timeout permits SHALL be committed
- **AND** an `event-store.sigterm-drain-timeout { remaining }` log line SHALL have been emitted naming the unflushed count

#### Scenario: Drain clears the retention timer

- **GIVEN** retention is enabled (a retention timer is scheduled)
- **WHEN** `drainAndClose` is invoked
- **THEN** the retention timer SHALL be cleared before the drain proceeds
- **AND** no new prune SHALL start after `drainAndClose` is invoked

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

The query path SHALL execute against the libSQL `events` table. The `(owner, repo, kind, "at")` index SHALL bound scope-filtered, kind-filtered, time-ordered scan cost.

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

### Requirement: Single-writer is a deployment contract

EventStore SHALL NOT implement runtime split-brain coordination. The single-writer guarantee rests entirely on the deployment contract: at most one runtime instance exists per env. Unlike DuckDB, embedded libSQL does NOT acquire an exclusive lock at open — a second process could open the same file and contend at write time rather than failing fast — so the guarantee is assumed from the deployment shape, not enforced by the store.

The deployment contract is encoded in two capabilities: `infrastructure` declares exactly one Quadlet `wfe-<env>.container` unit per env on a single VPS, with `podman-auto-update.timer` rotating the unit sequentially (stop, pull, start) on the same data dir and no overlap window between old and new containers; `bunny-staging` pins `autoscaling_min = autoscaling_max = 1` and `regions_max_allowed = 1`. There is no orchestrator that could spawn a second concurrent process for the same env. (Pointing the store at a remote libSQL service, where no file-level exclusion exists at all, is out of scope here and treated by the separate remote-backend change.)

#### Scenario: Single instance is guaranteed by infrastructure

- **GIVEN** an env whose infrastructure pins the instance count to exactly 1 (one Quadlet unit with sequential rotation, or `autoscaling_min = autoscaling_max = 1`)
- **WHEN** a deploy rotates the runtime
- **THEN** there SHALL be no overlap window in which two runtime processes hold the same `events.db` for that env

### Requirement: Module exports

The runtime SHALL export `createEventStore`, the `EventStore` interface, the Kysely `Database` type for the events table, the `Scope` type, and re-export `sql` from `kysely` so consumers do not import `kysely` directly. The module path SHALL be `packages/runtime/src/event-store.ts`.

#### Scenario: Consumers import from the canonical path

- **WHEN** `auth/scopes.ts` imports `EventStore`
- **THEN** the import SHALL resolve from `../event-store.js` (relative)

### Requirement: Time-based retention prune

EventStore SHALL expose a public `prune({ olderThan })` method that deletes aged invocations and returns the number of invocations deleted. `olderThan` is a wall-clock cutoff. `prune` SHALL delete an invocation only when **every** event sharing its `id` is older than the cutoff, evaluated as `max("at") < olderThan` grouped by `id`, so an invocation's call graph is never partially deleted. The cutoff SHALL be compared against the `at` column (TEXT ISO-8601 wall-clock, which sorts lexicographically in chronological order), NOT `ts` (a monotonic value not comparable to wall-clock time).

The count and the delete SHALL run within a single transaction on the EventStore's single read-write connection, serialized with commits so a prune and a commit never execute concurrently on the connection.

`prune` SHALL NOT shrink the `events.db` file on disk — libSQL/SQLite reuses freed pages for subsequent writes, so the file plateaus at its high-water mark rather than returning space to the OS. Reclaiming already-consumed disk is an out-of-band operator action, not part of `prune`. There is no `CHECKPOINT` step.

#### Scenario: Prune deletes only fully-aged invocations

- **GIVEN** invocation `evt_old` whose every event has `at` older than the cutoff
- **AND** invocation `evt_recent` with at least one event at or newer than the cutoff
- **WHEN** `prune({ olderThan: cutoff })` is awaited
- **THEN** `query()` SHALL NOT return any rows for `evt_old`
- **AND** `query()` SHALL still return all rows for `evt_recent`
- **AND** `prune` SHALL return a count of `1`

#### Scenario: Prune keeps a straddling call graph whole

- **GIVEN** invocation `evt_span` with an early event older than the cutoff and a later event newer than the cutoff
- **WHEN** `prune({ olderThan: cutoff })` is awaited
- **THEN** all rows for `evt_span` SHALL remain (the invocation's `max("at")` is newer than the cutoff)

#### Scenario: Prune is exposed on the factory result

- **WHEN** `createEventStore(...)` resolves
- **THEN** the returned object SHALL expose `prune` alongside `record`, `query`, `hasUploadEvent`, `ping`, and `drainAndClose`

### Requirement: EventStore self-schedules retention pruning

The EventStore SHALL own retention scheduling internally; there SHALL NOT be a separate retention service. When `config.retentionDays` is greater than `0`, the factory SHALL start a recurring timer that prunes invocations older than `retentionDays`. The prune interval SHALL be derived from the window — the EventStore prunes 100 times per window, i.e. every `retentionDays / 100` days (`retentionDays * 864_000` ms, floored, minimum 1 ms). There SHALL NOT be a separate interval configuration value. When `config.retentionDays` is `0` or unset, the EventStore SHALL NOT schedule any pruning.

The factory SHALL NOT await the first prune before resolving — the first prune SHALL be deferred so it does not delay factory resolution, startup recovery, or HTTP server bind. Each scheduled prune SHALL compute its cutoff as the current wall-clock time minus `retentionDays`.

A scheduled prune that fails SHALL be caught, SHALL log `event-store.prune-failed { error }` at error level, and SHALL NOT propagate — the runtime SHALL NOT exit because a prune failed. The next interval tick is the retry; there is no inner retry loop. A scheduled prune that succeeds SHALL log `event-store.prune-ok { invocations, durationMs }`.

#### Scenario: Retention disabled by default

- **GIVEN** `config.retentionDays` is `0` or unset
- **WHEN** `createEventStore(...)` resolves
- **THEN** no retention timer SHALL be scheduled
- **AND** no invocation SHALL be deleted on any timer

#### Scenario: Scheduled prune runs on the derived interval

- **GIVEN** `config.retentionDays` is `30` (interval derived as `30 / 100` days)
- **AND** the store contains invocations older than 30 days
- **WHEN** a scheduled prune tick fires
- **THEN** invocations older than the cutoff SHALL be deleted
- **AND** an `event-store.prune-ok { invocations, durationMs }` log line SHALL have been emitted

#### Scenario: Scheduled prune failure does not crash the runtime

- **GIVEN** retention is enabled and a scheduled prune fails (e.g. transient I/O error or full disk)
- **WHEN** the prune tick runs
- **THEN** an `event-store.prune-failed { error }` log line SHALL have been emitted
- **AND** the runtime process SHALL still be running
- **AND** the timer SHALL remain scheduled so the next tick retries

### Requirement: libSQL-backed durable archive

EventStore SHALL persist invocation events using a libSQL embedded database file at `<persistenceRoot>/events.db`, accessed via `@libsql/client` through Kysely with the `@libsql/kysely-libsql` dialect. There SHALL NOT be a separate Parquet directory, a lakehouse catalog, a DuckDB file, or any DuckDB/DuckLake/`httpfs` artefact.

The events table SHALL have columns: `id` (TEXT), `seq` (INTEGER), `kind` (TEXT), `ref` (INTEGER, nullable), `at` (TEXT, ISO-8601 wall-clock), `ts` (INTEGER, monotonic milliseconds), `owner` (TEXT NOT NULL), `repo` (TEXT NOT NULL), `workflow` (TEXT), `workflowSha` (TEXT), `name` (TEXT), `input` (TEXT JSON, nullable), `output` (TEXT JSON, nullable), `error` (TEXT JSON, nullable), `meta` (TEXT JSON, nullable). JSON values are stringified by the application on write and parsed on read.

The events table SHALL declare `PRIMARY KEY (id, seq)`. EventStore SHALL also create a composite secondary index on `(owner, repo, kind, "at")` to serve the scope-filtered, kind-filtered, time-ordered dashboard reads (this replaces the prior `(owner, repo)`-only index; on a row store the narrower index is required to keep hot-repo reads sub-millisecond rather than scanning the whole owner/repo partition).

Idempotency is enforced by the `PRIMARY KEY (id, seq)` constraint. The in-memory accumulator continues to evict on successful commit; PK violations during retry are treated as fatal (see "Bounded retry then drop") because pre-eviction structurally prevents legitimate duplicate inserts — a PK conflict signals a logic bug, not a transient.

#### Scenario: Database file is created at the configured path

- **GIVEN** a fresh `PERSISTENCE_PATH=/var/lib/wfe`
- **WHEN** EventStore initialises and commits an invocation under `(owner: "acme", repo: "foo")`
- **THEN** `/var/lib/wfe/events.db` SHALL exist
- **AND** no `/var/lib/wfe/events.duckdb` file and no `/var/lib/wfe/events/` Parquet directory SHALL be created

#### Scenario: Events table declares PRIMARY KEY (id, seq) and the read index

- **GIVEN** a freshly-initialised EventStore
- **WHEN** the schema is inspected via `PRAGMA table_info(events)` / `PRAGMA index_list(events)`
- **THEN** the events table SHALL declare a `PRIMARY KEY` over `(id, seq)`
- **AND** a composite index over `(owner, repo, kind, "at")` SHALL exist

### Requirement: ping verifies the libSQL connection

EventStore SHALL expose `ping(): Promise<void>` that runs `SELECT 1` against the libSQL connection. `ping()` SHALL resolve on success and reject on failure. The readiness endpoint (`/readyz`) consumes this to determine whether the runtime is serving.

#### Scenario: Ping succeeds when the connection is healthy

- **WHEN** `ping()` is awaited on a healthy EventStore
- **THEN** it SHALL resolve with no value

#### Scenario: Ping rejects when the connection is broken

- **GIVEN** the libSQL connection has been closed
- **WHEN** `ping()` is awaited
- **THEN** it SHALL reject with the underlying connection error

