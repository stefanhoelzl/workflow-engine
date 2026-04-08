## ADDED Requirements

### Requirement: Persistence consumer implements BusConsumer

The persistence consumer SHALL implement the `BusConsumer` interface. It SHALL be created via a factory function that accepts the queue directory path and returns an object with `handle()`, `bootstrap()`, and `recover()`.

#### Scenario: Factory creates persistence consumer

- **GIVEN** a directory path `"./data/queue"`
- **WHEN** the persistence factory is called
- **THEN** the returned object implements `BusConsumer` (handle + bootstrap)
- **AND** exposes a `recover()` method for startup

### Requirement: handle() writes append-only state files

`handle(event)` SHALL write a new JSON file to the `pending/` directory for every RuntimeEvent received, regardless of state. The file SHALL contain the full RuntimeEvent data (all fields including state and error). Files SHALL use the naming pattern `<counter>_evt_<uuid>.json` where counter is a zero-padded 6-digit global monotonic integer.

#### Scenario: Pending event is persisted

- **GIVEN** the current counter is 5
- **WHEN** `handle({ id: "evt_abc", state: "pending", ... })` is called
- **THEN** a file `000006_evt_abc.json` is written to `pending/`
- **AND** the file contains the full event with `"state": "pending"`

#### Scenario: Processing event is persisted

- **GIVEN** the current counter is 6
- **WHEN** `handle({ id: "evt_abc", state: "processing", ... })` is called
- **THEN** a file `000007_evt_abc.json` is written to `pending/`
- **AND** the file contains the full event with `"state": "processing"`

#### Scenario: Terminal state event is persisted and archived

- **GIVEN** the current counter is 7
- **WHEN** `handle({ id: "evt_abc", state: "done", ... })` is called
- **THEN** a file `000008_evt_abc.json` is written to `pending/` (awaited)
- **AND** archiving of all `*_evt_abc.json` files is initiated (fire-and-forget, NOT awaited)

### Requirement: Atomic file writes

All file writes SHALL use a write-then-rename pattern: write content to a `<filepath>.tmp` temporary file, then atomically rename to the final path.

#### Scenario: Crash during file write

- **GIVEN** the process crashes while writing an event file
- **WHEN** the system restarts
- **THEN** no partial or corrupted JSON files exist in `pending/`
- **AND** only `.tmp` files (ignored on recovery) may remain

### Requirement: Fire-and-forget archive on terminal states

When `handle()` receives a RuntimeEvent with state `"done"`, `"failed"`, or `"skipped"`, it SHALL write the terminal state file (awaited), then initiate archiving of all files for that event ID without awaiting. Archive moves files from `pending/` to `archive/` in ascending counter order.

#### Scenario: Archive does not block the bus

- **GIVEN** an event with state `"done"` is emitted to the bus
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

The persistence consumer SHALL expose a `recover()` method that returns an `AsyncIterable<RuntimeEvent[]>`. It SHALL:
1. Create `pending/` and `archive/` directories if they do not exist
2. Read all `*.json` files from `pending/`
3. Group files by event ID
4. For each event, use the file with the highest counter to derive current state
5. For events with terminal state (done/failed/skipped), complete the archive (move all files to `archive/`)
6. Yield remaining events as `RuntimeEvent` batches
7. Recover the global counter from the maximum counter across both `pending/` and `archive/`

#### Scenario: Recover pending events

- **GIVEN** `pending/` contains `000001_evt_abc.json` with `state: "pending"`
- **WHEN** `recover()` is iterated
- **THEN** a batch containing the event with `state: "pending"` is yielded

#### Scenario: Recover processing events (crash recovery)

- **GIVEN** `pending/` contains `000001_evt_abc.json` (pending) and `000002_evt_abc.json` (processing)
- **WHEN** `recover()` is iterated
- **THEN** a batch containing the event with `state: "processing"` is yielded

#### Scenario: Complete interrupted archive

- **GIVEN** `pending/` contains `000001_evt_abc.json` (pending) and `000005_evt_abc.json` (done)
- **WHEN** `recover()` is iterated
- **THEN** both files are moved to `archive/`
- **AND** the event is NOT yielded in any batch

#### Scenario: Counter recovered from existing files

- **GIVEN** `archive/` contains `000042_evt_old.json` and `pending/` contains `000043_evt_abc.json`
- **WHEN** `recover()` completes
- **THEN** the next `handle()` call uses counter value 44

#### Scenario: Empty directories

- **GIVEN** both `pending/` and `archive/` are empty (or do not exist)
- **WHEN** `recover()` is iterated
- **THEN** no batches are yielded
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
