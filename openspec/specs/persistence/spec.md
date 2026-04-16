# Persistence Specification

## Purpose

Provide crash-resilient invocation persistence using pending/archive lifecycle records, ensuring invocations survive process restarts through atomic writes and startup recovery.

## Requirements

### Requirement: Persistence consumer implements BusConsumer

The persistence consumer SHALL implement the `BusConsumer` interface. It SHALL be created via a factory function that accepts a `StorageBackend` instance and returns an object with `handle()`.

#### Scenario: Factory creates persistence consumer

- **GIVEN** a `StorageBackend` instance
- **WHEN** the persistence factory is called with the backend
- **THEN** the returned object implements `BusConsumer` (handle)

### Requirement: Persistence consumer writes invocation lifecycle records

The persistence consumer SHALL implement `BusConsumer` and SHALL persist invocation lifecycle events received from the bus. On `started` events, the consumer SHALL write `pending/<invocation-id>.json` containing the invocation's start record (id, workflow, trigger, input, startedAt). On `completed` and `failed` events, the consumer SHALL write `archive/<invocation-id>.json` containing the full archive record (start fields plus completedAt, status, result-or-error) AND remove the corresponding `pending/<invocation-id>.json`.

The naming pattern SHALL be `<invocation-id>.json` (no counter prefix). Each invocation produces exactly one `pending/` file (written at start, removed at completion) and exactly one `archive/` file (written at completion).

#### Scenario: Started event writes pending file

- **GIVEN** a `started` lifecycle event for invocation `evt_abc`
- **WHEN** the persistence consumer receives the event via the bus
- **THEN** the consumer SHALL write `pending/evt_abc.json` containing the start record

#### Scenario: Completed event writes archive and removes pending

- **GIVEN** a `completed` lifecycle event for invocation `evt_abc`
- **AND** `pending/evt_abc.json` exists from the prior `started` event
- **WHEN** the persistence consumer receives the completed event
- **THEN** the consumer SHALL write `archive/evt_abc.json` containing the full archive record
- **AND** SHALL remove `pending/evt_abc.json`

#### Scenario: Failed event writes archive and removes pending

- **GIVEN** a `failed` lifecycle event for invocation `evt_abc` carrying `error: { message, stack }` or `error: { kind: "engine_crashed" }`
- **AND** `pending/evt_abc.json` exists
- **WHEN** the persistence consumer receives the failed event
- **THEN** the consumer SHALL write `archive/evt_abc.json` with `status: "failed"` and the error
- **AND** SHALL remove `pending/evt_abc.json`

### Requirement: Atomic file writes via StorageBackend

All file writes SHALL be delegated to `StorageBackend.write()`. The backend is responsible for atomicity (FS uses tmp+rename, S3 uses PutObject). The persistence consumer SHALL NOT use `node:fs/promises` directly.

#### Scenario: Write delegates to StorageBackend

- **GIVEN** a persistence consumer created with a `StorageBackend`
- **WHEN** any lifecycle event triggers a file write
- **THEN** the consumer SHALL call `backend.write(path, data)`

### Requirement: Persistence exposes scan helpers for recovery

The persistence module SHALL expose `scanPending()` and `scanArchive()` async iterators returning invocation records read from `pending/` and `archive/` respectively. These SHALL be called by the recovery startup function and the EventStore consumer's bootstrap; they SHALL NOT be wired through the bus.

#### Scenario: scanPending yields each pending record

- **GIVEN** `pending/` contains two files
- **WHEN** `scanPending()` is iterated
- **THEN** the iterator SHALL yield two invocation records

#### Scenario: scanArchive yields each archived record

- **GIVEN** `archive/` contains five files
- **WHEN** `scanArchive()` is iterated
- **THEN** the iterator SHALL yield five invocation records
