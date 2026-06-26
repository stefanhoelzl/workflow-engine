## MODIFIED Requirements

### Requirement: EventStore is the sole consumer of invocation lifecycle events

The runtime SHALL host a single `EventStore` component that owns durable storage of invocation events and serves all queries over them. There SHALL NOT be an event bus, a separate persistence consumer, a recovery scan path, or a logging consumer in the runtime; their responsibilities collapse into the executor (lifecycle logging) and the EventStore (durable archive + queries).

EventStore SHALL be created via `createEventStore({ db, logger, config })`, where `db` is a libSQL-backed `Kysely<Database>` (the caller builds it from the configured `DATABASE_URL` — a `file:…` URL for an embedded on-disk database or a `libsql://…`/`https://…` URL for a remote libSQL service — and owns the underlying client's lifecycle), `logger` is the runtime logger, and `config` carries the `EVENT_STORE_*` settings. The factory SHALL return a Promise that resolves once the schema has been ensured (idempotent `CREATE TABLE/INDEX IF NOT EXISTS`).

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

### Requirement: Single-writer is a deployment contract

EventStore SHALL NOT implement runtime split-brain coordination. The single-writer guarantee rests entirely on the deployment contract: at most one runtime instance exists per env. The strength of the underlying backstop varies by backend and is, in all cases, weaker than DuckDB's exclusive open-lock:

- **Embedded libSQL** (`file:…`) does NOT acquire an exclusive lock at open — a second process could open the same file and contend at write time rather than failing fast — so the guarantee is assumed from the deployment shape, not enforced by the store.
- **Remote libSQL** (`libsql://…`/`https://…`) has NO file-level exclusion at all: there is no local file to contend on and the service does not serialize writers by connection. The guarantee rests entirely on the deployment shape pinning the instance count to exactly one.

The deployment contract is encoded in two capabilities: `infrastructure` declares exactly one Quadlet `wfe-<env>.container` unit per env on a single VPS, with `podman-auto-update.timer` rotating the unit sequentially (stop, pull, start) on the same data dir and no overlap window between old and new containers; `bunny-staging` pins `autoscaling_min = autoscaling_max = 1` and `regions_max_allowed = 1`. There is no orchestrator that could spawn a second concurrent process for the same env.

EventStore SHALL NOT implement an application-level lease or fence in this change. An app-level lease/fence (so a second writer fails fast even against a remote service with no exclusion) is a documented future option, conditioned on observed need once a live remote backend is in use.

#### Scenario: Single instance is guaranteed by infrastructure

- **GIVEN** an env whose infrastructure pins the instance count to exactly 1 (one Quadlet unit with sequential rotation, or `autoscaling_min = autoscaling_max = 1`)
- **WHEN** a deploy rotates the runtime
- **THEN** there SHALL be no overlap window in which two runtime processes hold the same database for that env

#### Scenario: Remote backend has no file-level exclusion

- **GIVEN** the store is pointed at a remote libSQL service via a `libsql://` `DATABASE_URL`
- **WHEN** two runtime processes connect concurrently
- **THEN** the service SHALL NOT serialize or reject the second writer on its own
- **AND** the single-writer guarantee SHALL rest solely on the infrastructure instance-count pin, not on any store- or service-level lock
