## MODIFIED Requirements

### Requirement: Persistence consumer implements BusConsumer

The persistence consumer SHALL implement the `BusConsumer` interface. It SHALL be created via a factory function that accepts a `StorageBackend` instance and returns an object with `handle()`, `bootstrap()`, and `recover()`.

#### Scenario: Factory creates persistence consumer

- **GIVEN** a `StorageBackend` instance
- **WHEN** the persistence factory is called with the backend
- **THEN** the returned object implements `BusConsumer` (handle + bootstrap)
- **AND** exposes a `recover()` method for startup

### Requirement: Atomic file writes

All file writes SHALL be delegated to `StorageBackend.write()`. The backend is responsible for atomicity guarantees (FS uses tmp+rename, S3 uses PutObject).

#### Scenario: Write delegates to StorageBackend

- **GIVEN** a persistence consumer created with a `StorageBackend`
- **WHEN** `handle(event)` is called
- **THEN** it SHALL call `backend.write(path, data)` to persist the event
- **AND** it SHALL NOT import or use `node:fs/promises` directly

### Requirement: recover() scans filesystem and yields batches

The persistence consumer SHALL expose a `recover()` method that returns an `AsyncIterable<RecoveryBatch>`. It SHALL use `StorageBackend.list()` to discover event files instead of `readdir` directly.

#### Scenario: Recovery uses StorageBackend.list

- **GIVEN** a persistence consumer with a `StorageBackend`
- **WHEN** `recover()` is called
- **THEN** it SHALL use `backend.list("pending/")` and `backend.list("archive/")` to discover files
- **AND** it SHALL use `backend.read(path)` to load event content

### Requirement: Fire-and-forget archive on terminal states

When archiving event files, the persistence consumer SHALL use `StorageBackend.move()` instead of `fs.rename()`.

#### Scenario: Archive uses StorageBackend.move

- **GIVEN** a file `pending/000001_evt_abc.json` exists
- **WHEN** the persistence consumer archives it
- **THEN** it SHALL call `backend.move("pending/000001_evt_abc.json", "archive/000001_evt_abc.json")`
