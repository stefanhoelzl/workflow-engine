## RENAMED Requirements

- FROM: `### Requirement: DuckDB-backed durable archive`
- TO: `### Requirement: libSQL-backed durable archive`

- FROM: `### Requirement: ping verifies the DuckLake connection`
- TO: `### Requirement: ping verifies the libSQL connection`

## MODIFIED Requirements

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

### Requirement: ping verifies the libSQL connection

EventStore SHALL expose `ping(): Promise<void>` that runs `SELECT 1` against the libSQL connection. `ping()` SHALL resolve on success and reject on failure. The readiness endpoint (`/readyz`) consumes this to determine whether the runtime is serving.

#### Scenario: Ping succeeds when the connection is healthy

- **WHEN** `ping()` is awaited on a healthy EventStore
- **THEN** it SHALL resolve with no value

#### Scenario: Ping rejects when the connection is broken

- **GIVEN** the libSQL connection has been closed
- **WHEN** `ping()` is awaited
- **THEN** it SHALL reject with the underlying connection error

### Requirement: Single-writer is a deployment contract

EventStore SHALL NOT implement runtime split-brain coordination. The single-writer guarantee rests entirely on the deployment contract: at most one runtime instance exists per env. Unlike DuckDB, embedded libSQL does NOT acquire an exclusive lock at open — a second process could open the same file and contend at write time rather than failing fast — so the guarantee is assumed from the deployment shape, not enforced by the store.

The deployment contract is encoded in two capabilities: `infrastructure` declares exactly one Quadlet `wfe-<env>.container` unit per env on a single VPS, with `podman-auto-update.timer` rotating the unit sequentially (stop, pull, start) on the same data dir and no overlap window between old and new containers; `bunny-staging` pins `autoscaling_min = autoscaling_max = 1` and `regions_max_allowed = 1`. There is no orchestrator that could spawn a second concurrent process for the same env. (Pointing the store at a remote libSQL service, where no file-level exclusion exists at all, is out of scope here and treated by the separate remote-backend change.)

#### Scenario: Single instance is guaranteed by infrastructure

- **GIVEN** an env whose infrastructure pins the instance count to exactly 1 (one Quadlet unit with sequential rotation, or `autoscaling_min = autoscaling_max = 1`)
- **WHEN** a deploy rotates the runtime
- **THEN** there SHALL be no overlap window in which two runtime processes hold the same `events.db` for that env

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
