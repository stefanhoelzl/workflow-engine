# Persistence Specification

## Purpose

Provide crash-resilient event persistence using an append-only filesystem queue, ensuring events survive process restarts through atomic writes, ordered archival, and startup recovery.

## Requirements

### Requirement: Persistence consumer implements BusConsumer

The persistence consumer SHALL implement the `BusConsumer` interface. It SHALL be created via a factory function that accepts the queue directory path and returns an object with `handle()`, `bootstrap()`, and `recover()`.

#### Scenario: Factory creates persistence consumer

- **GIVEN** a directory path `"./data/queue"`
- **WHEN** the persistence factory is called
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

All file writes SHALL use a write-then-rename pattern: write content to a `<filepath>.tmp` temporary file, then atomically rename to the final path.

#### Scenario: Crash during file write

- **GIVEN** the process crashes while writing an event file
- **WHEN** the system restarts
- **THEN** no partial or corrupted JSON files exist in `pending/`
- **AND** only `.tmp` files (ignored on recovery) may remain

### Requirement: Fire-and-forget archive on terminal states

When `handle()` receives a RuntimeEvent with `state === "done"`, it SHALL write the terminal state file (awaited), then initiate archiving of all files for that event ID without awaiting. Archive moves files from `pending/` to `archive/` in ascending counter order.

#### Scenario: Archive does not block the bus

- **GIVEN** an event with `state: "done"` and `result: "succeeded"` is emitted to the bus
- **WHEN** persistence's `handle()` is called
- **THEN** the terminal state file write is awaited
- **AND** `handle()` returns before archiving completes
- **AND** archiving proceeds in the background

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

The persistence consumer SHALL expose a `recover()` method that returns an `AsyncIterable<RecoveryBatch>` where `RecoveryBatch` is `{ events: RuntimeEvent[], pending: boolean, finished: boolean }`. It SHALL:

1. Create `pending/` and `archive/` directories if they do not exist
2. Recover the global counter from the maximum counter across both `pending/` and `archive/`
3. Read `pending/` files, group by event ID, take the latest (highest counter) per event, and move older files to `archive/`
4. Yield pending events with `{ pending: true }`
5. Read all `archive/` files
6. Yield archive events with `{ pending: false, finished: true }`
7. If no events exist in either directory, yield an empty batch with `{ pending: true, finished: true }`

#### Scenario: Recover single pending event

- **GIVEN** `pending/` contains `000001_evt_abc.json` with `state: "pending"`
- **AND** `archive/` is empty
- **WHEN** `recover()` is iterated
- **THEN** one batch is yielded with `pending: true`, `finished: true`, containing the event

#### Scenario: Recover handles crash case (2 files per event)

- **GIVEN** `pending/` contains `000001_evt_abc.json` (pending) and `000002_evt_abc.json` (processing)
- **WHEN** `recover()` is iterated
- **THEN** `000001_evt_abc.json` is moved to `archive/`
- **AND** a batch with `pending: true` is yielded containing only the processing event

#### Scenario: Recover yields pending then archive

- **GIVEN** `pending/` contains `000003_evt_active.json` (pending)
- **AND** `archive/` contains `000001_evt_done.json` (pending) and `000002_evt_done.json` (done)
- **WHEN** `recover()` is iterated
- **THEN** the first batch has `pending: true`, `finished: false` with the active event
- **AND** the second batch has `pending: false`, `finished: true` with both archived events

#### Scenario: Counter recovered from max across both directories

- **GIVEN** `archive/` contains `000042_evt_old.json` and `pending/` contains `000043_evt_abc.json`
- **WHEN** `recover()` completes
- **THEN** the next `handle()` call uses counter value 44

#### Scenario: Empty directories

- **GIVEN** both `pending/` and `archive/` are empty
- **WHEN** `recover()` is iterated
- **THEN** one batch is yielded with `events: []`, `pending: true`, `finished: true`
- **AND** the counter starts at 0

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
