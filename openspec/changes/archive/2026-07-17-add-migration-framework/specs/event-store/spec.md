## MODIFIED Requirements

### Requirement: EventStore is the sole consumer of invocation lifecycle events

The runtime SHALL host a single `EventStore` component that owns durable storage of invocation events and serves all queries over them. There SHALL NOT be an event bus, a separate persistence consumer, a recovery scan path, or a logging consumer in the runtime; their responsibilities collapse into the executor (lifecycle logging) and the EventStore (durable archive + queries).

EventStore SHALL be created via `createEventStore({ db, logger, config })`, where `db` is a libSQL-backed `Kysely<Database>` (the caller builds it from the configured `DATABASE_URL` — a `file:…` URL for an embedded on-disk database or a `libsql://…`/`https://…` URL for a remote libSQL service — and owns the underlying client's lifecycle), `logger` is the runtime logger, and `config` carries the `EVENT_STORE_*` settings. The schema SHALL be ensured by the migration runner (see the `database-migrations` capability), which the caller runs to latest **before** constructing the EventStore. The factory SHALL NOT execute schema DDL (`CREATE TABLE/INDEX`); it SHALL open against the already-migrated database and SHALL return a Promise that resolves once it is ready to accept `record` and `query` calls.

#### Scenario: Factory opens the migrated schema and resolves ready

- **GIVEN** the migration runner has applied all migrations against a fresh libSQL database
- **WHEN** `createEventStore({ db, logger, config })` is awaited
- **THEN** the returned object exposes `record`, `query`, `hasUploadEvent`, `ping`, `drainAndClose`
- **AND** the `events` table and its read index exist (created by the migration runner, not the factory)
- **AND** the factory SHALL NOT have executed `CREATE TABLE` or `CREATE INDEX`
- **AND** the connection is ready to accept `record` and `query` calls

#### Scenario: Factory opens an existing database without scanning per-invocation files

- **GIVEN** an existing, migrated libSQL `events.db` containing a million archived invocations
- **WHEN** `createEventStore` is awaited
- **THEN** the factory SHALL NOT enumerate, list, or read per-invocation archive files
- **AND** the factory SHALL resolve in time bounded by opening the connection, not by historical event count
