## MODIFIED Requirements

### Requirement: Describe wraps spawn lifecycle

The `describe(name, body)` function SHALL spawn one runtime child per describe block and tear it down at end-of-describe.

#### Scenario: One child per describe

- **WHEN** a describe block executes
- **THEN** exactly one `node packages/runtime/dist/main.js` subprocess SHALL be spawned at `beforeAll`
- **AND** the child SHALL be killed at `afterAll`

#### Scenario: Custom env per describe

- **WHEN** `describe(name, {env: {KEY: "value"}}, body)` is called
- **THEN** the spawned child's environment SHALL include the provided env vars
- **AND** these vars SHALL override any defaults

#### Scenario: Default env

- **WHEN** `describe(name, body)` is called without env opts
- **THEN** the spawned child SHALL receive: `PORT` (random free port), `PERSISTENCE_PATH` (tmp dir), `DATABASE_URL` (`file:<persistencePath>/events.db`), `DATABASE_WAL=true`, `SECRETS_PRIVATE_KEYS` (fresh keypair), `LOCAL_DEPLOYMENT=1`, `AUTH_ALLOW=local:dev,local:alice:acme,local:bob:other`, `LOG_LEVEL=info`
- **AND** `DATABASE_WAL=true` SHALL be set so the harness's second read connection can read the live database concurrently (WAL mode)

### Requirement: Event source via the persisted event store

`state.events` and `.waitForEvent` SHALL source committed invocation events from the spawned child's libSQL database (`<persistencePath>/events.db`, named by the child's `DATABASE_URL=file:<persistencePath>/events.db`) by opening a **second** `@libsql/client` read connection on that file. The child SHALL be spawned with `DATABASE_WAL=true` so WAL mode permits concurrent readers alongside the live runtime; without WAL the embedded database would fall back to rollback-journal mode and the second connection could not read during writes. The framework SHALL query the `events` table. The framework SHALL NOT copy or snapshot the database file, and SHALL NOT subscribe to runtime log lines for invocation events. Only committed events are observable — events still held in the EventStore's in-memory accumulator for an in-flight invocation are not yet on disk and therefore are not visible to the harness (consistent with the `event-store` accumulator/commit-on-terminal model).

#### Scenario: Harness reads committed events via a second connection

- **GIVEN** a spawned child writing to `<persistencePath>/events.db` with `DATABASE_WAL=true`
- **WHEN** the harness resolves `state.events` or a `.waitForEvent`
- **THEN** the framework SHALL query the `events` table via a second `@libsql/client` read connection on `<persistencePath>/events.db`
- **AND** the framework SHALL NOT copy or snapshot the database file
