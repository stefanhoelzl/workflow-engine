# Persistence Specification

## Purpose

Provide crash-resilient event persistence using an append-only filesystem queue, ensuring events survive process restarts through atomic writes, ordered archival, and startup recovery.

## Requirements

### Requirement: Persistence consumer implements BusConsumer

The persistence consumer SHALL implement the `BusConsumer` interface. It SHALL be created via a factory function that accepts a `StorageBackend` instance and returns an object with `handle()`, `bootstrap()`, and `recover()`.

#### Scenario: Factory creates persistence consumer

- **GIVEN** a `StorageBackend` instance
- **WHEN** the persistence factory is called with the backend
- **THEN** the returned object implements `BusConsumer` (handle + bootstrap)
- **AND** exposes a `recover()` method for startup

### Requirement: handle() writes append-only state files

`handle(event)` SHALL write a new JSON file for every RuntimeEvent received. The write behavior depends on the event state:

- **Non-terminal states** (`state: "pending"` or `state: "processing"`): Write to the `pending/` directory. After writing, initiate fire-and-forget archival of any older files for the same event ID in `pending/`.
- **Terminal state** (`state: "done"`): Write directly to the `archive/` directory. After writing, initiate fire-and-forget archival of any remaining files for the same event ID in `pending/`.

Files SHALL use the naming pattern `<counter>_evt_<uuid>.json` where counter is a zero-padded 6-digit global monotonic integer.

#### Scenario: Pending event is persisted

- **GIVEN** the current counter is 5
- **WHEN** `handle({ id: "evt_abc", state: "pending", ... })` is called
- **THEN** a file `000006_evt_abc.json` is written to `pending/`
- **AND** no archive operation is initiated (first file for this event)

#### Scenario: Processing event is persisted and older files archived

- **GIVEN** the current counter is 6
- **AND** `pending/` contains `000006_evt_abc.json` with state "pending"
- **WHEN** `handle({ id: "evt_abc", state: "processing", ... })` is called
- **THEN** a file `000007_evt_abc.json` is written to `pending/`
- **AND** archiving of `000006_evt_abc.json` from `pending/` to `archive/` is initiated (fire-and-forget)

#### Scenario: Succeeded event is written directly to archive

- **GIVEN** the current counter is 7
- **AND** `pending/` contains `000007_evt_abc.json` with state "processing"
- **WHEN** `handle({ id: "evt_abc", state: "done", result: "succeeded", ... })` is called
- **THEN** a file `000008_evt_abc.json` is written to `archive/` (not `pending/`)
- **AND** archiving of `000007_evt_abc.json` from `pending/` to `archive/` is initiated (fire-and-forget)

#### Scenario: Failed event is written directly to archive

- **GIVEN** the current counter is 8
- **AND** `pending/` contains `000008_evt_abc.json` with state "processing"
- **WHEN** `handle({ id: "evt_abc", state: "done", result: "failed", error: "timeout", ... })` is called
- **THEN** a file `000009_evt_abc.json` is written to `archive/` (not `pending/`)
- **AND** archiving of `000008_evt_abc.json` from `pending/` to `archive/` is initiated (fire-and-forget)

#### Scenario: Skipped event is written directly to archive

- **GIVEN** the current counter is 9
- **AND** `pending/` contains `000009_evt_abc.json` with state "processing"
- **WHEN** `handle({ id: "evt_abc", state: "done", result: "skipped", ... })` is called
- **THEN** a file `000010_evt_abc.json` is written to `archive/` (not `pending/`)
- **AND** archiving of `000009_evt_abc.json` from `pending/` to `archive/` is initiated (fire-and-forget)

#### Scenario: Archive failure is logged but does not throw

- **GIVEN** an archive operation fails
- **WHEN** the background archive runs
- **THEN** the error is logged
- **AND** no exception propagates to the bus

### Requirement: Atomic file writes

All file writes SHALL be delegated to `StorageBackend.write()`. The backend is responsible for atomicity guarantees (FS uses tmp+rename, S3 uses PutObject).

#### Scenario: Write delegates to StorageBackend

- **GIVEN** a persistence consumer created with a `StorageBackend`
- **WHEN** `handle(event)` is called
- **THEN** it SHALL call `backend.write(path, data)` to persist the event
- **AND** it SHALL NOT import or use `node:fs/promises` directly

### Requirement: Fire-and-forget archive on terminal states

When `handle()` receives a RuntimeEvent with `state === "done"`, it SHALL write the terminal state file (awaited), then initiate archiving of all files for that event ID without awaiting. Archive moves files from `pending/` to `archive/` in ascending counter order using `StorageBackend.move()`.

#### Scenario: Archive uses StorageBackend.move

- **GIVEN** an event with `state: "done"` and `result: "succeeded"` is emitted to the bus
- **WHEN** persistence's `handle()` is called
- **THEN** the terminal state file write is awaited
- **AND** `handle()` returns before archiving completes
- **AND** archiving proceeds in the background via `backend.move()`

#### Scenario: Archive failure is logged but does not throw

- **GIVEN** an archive operation fails (e.g., file already moved)
- **WHEN** the background archive runs
- **THEN** the error is logged
- **AND** no exception propagates to the bus

### Requirement: bootstrap() is a no-op

The persistence consumer's `bootstrap()` SHALL be an empty implementation. The persistence consumer provides bootstrap data via `recover()`, it does not consume it.

#### Scenario: Bootstrap does nothing

- **GIVEN** a persistence consumer
- **WHEN** `bootstrap(events, { finished: true })` is called
- **THEN** no files are written or read

### Requirement: recover() scans filesystem and yields batches

The persistence consumer SHALL expose a `recover()` method that returns an `AsyncIterable<RecoveryBatch>`. It SHALL use `StorageBackend.list()` to discover event files instead of `readdir` directly.

#### Scenario: Recovery uses StorageBackend.list

- **GIVEN** a persistence consumer with a `StorageBackend`
- **WHEN** `recover()` is called
- **THEN** it SHALL use `backend.list("pending/")` and `backend.list("archive/")` to discover files
- **AND** it SHALL use `backend.read(path)` to load event content

### Requirement: Single-threaded counter

The global file counter SHALL be a simple in-memory integer, incremented on each write. It is NOT safe for concurrent writes. This limitation SHALL be documented in the code for when parallel scheduling is introduced.

#### Scenario: Sequential writes use incrementing counters

- **GIVEN** the counter is at 10
- **WHEN** two events are written sequentially via `handle()`
- **THEN** the first file uses counter 11 and the second uses counter 12

### Requirement: Archive move order

When moving event files from `pending/` to `archive/`, files SHALL be moved in ascending counter order (lowest first). This ensures that if the process crashes mid-archive, the highest-counter file remaining in `pending/` is authoritative for recovery.

#### Scenario: Crash during archive preserves recovery

- **GIVEN** `pending/` has `000001_evt_abc.json` (pending) and `000005_evt_abc.json` (done)
- **AND** archiving moves `000001_evt_abc.json` to `archive/` but crashes before moving `000005_evt_abc.json`
- **WHEN** the system restarts and `recover()` runs
- **THEN** `000005_evt_abc.json` (done) is found in `pending/`
- **AND** the archive is completed
