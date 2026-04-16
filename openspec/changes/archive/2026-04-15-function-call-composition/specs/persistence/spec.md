## ADDED Requirements

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

## REMOVED Requirements

### Requirement: handle() writes append-only state files

**Reason**: The append-only state file model (one file per state transition with a global counter prefix) does not apply to the new invocation lifecycle. Each invocation now produces exactly one `pending/<id>.json` (removed on completion) and one `archive/<id>.json` (kept) with no intermediate state files.

**Migration**: Adopt the new lifecycle write behavior described in the v1 requirements above.

### Requirement: Fire-and-forget archive on terminal states

**Reason**: There is no longer a window in which a `done` event coexists with prior pending files for the same id (each invocation has exactly one pending file). The completion handler synchronously removes `pending/<id>.json` after writing `archive/<id>.json`.

**Migration**: No archive-move dance is needed; the completion path writes archive then deletes pending in sequence.

### Requirement: bootstrap() is a no-op

**Reason**: The persistence consumer no longer participates in the bus's `bootstrap` phase. EventStore bootstraps from `archive/` directly via `scanArchive()`.

**Migration**: Persistence's `BusConsumer` interface in v1 implements `handle()` only; `bootstrap()` is removed if the new bus interface no longer requires it.

### Requirement: recover() scans filesystem and yields batches

**Reason**: Recovery is no longer a method on the persistence consumer. It is a standalone startup function `recover(persistence, bus)` (see `recovery` capability spec).

**Migration**: Use `recover(persistence, bus)` from the runtime startup sequence; persistence exposes `scanPending()`/`scanArchive()` for the recovery function to use.

### Requirement: Single-threaded counter

**Reason**: No global counter. Each invocation file is named by its invocation id alone (`<id>.json`), which is globally unique by construction.

**Migration**: No counter is required; the invocation id (UUID-based) is the sort key.

### Requirement: Archive move order

**Reason**: There is no `move` operation; completion writes archive directly and deletes pending. Crash recovery handles orphaned pending files by transitioning them to `failed: engine_crashed` (see `recovery` capability).

**Migration**: No author action required.
