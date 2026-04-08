# Filesystem Event Queue Specification

## Purpose

Provide a filesystem-backed EventQueue implementation with crash recovery and an immutable audit trail. FileSystemEventQueue extends InMemoryEventQueue, adding disk persistence via append-only JSON files organized in `pending/` and `archive/` directories.

## Requirements

### Requirement: FileSystemEventQueue extends InMemoryEventQueue

`FileSystemEventQueue` SHALL extend `InMemoryEventQueue`, inheriting all in-memory state tracking and the waiter/Promise dequeue pattern. It SHALL add filesystem persistence for crash recovery and auditing.

#### Scenario: Drop-in replacement for InMemoryEventQueue

- **GIVEN** a `FileSystemEventQueue` instance
- **WHEN** used through the `EventQueue` interface
- **THEN** it SHALL behave identically to `InMemoryEventQueue` for all `enqueue`, `dequeue`, `ack`, and `fail` operations

### Requirement: Async factory method for initialization

`FileSystemEventQueue` SHALL provide a static `create(dir: string)` factory method that returns a `Promise<FileSystemEventQueue>`. The factory SHALL create `pending/` and `archive/` subdirectories if they do not exist, recover pending events from disk, and return a ready-to-use instance.

#### Scenario: Create a new queue with empty directories

- **WHEN** `FileSystemEventQueue.create("./data/queue")` is called on a path with no existing data
- **THEN** `./data/queue/pending/` and `./data/queue/archive/` directories SHALL be created
- **AND** the returned queue SHALL have no pending events

#### Scenario: Create a queue with existing pending events

- **GIVEN** `pending/` contains `000001_evt_abc.json` with state `"pending"`
- **WHEN** `FileSystemEventQueue.create("./data/queue")` is called
- **THEN** the event from `000001_evt_abc.json` SHALL be available via `dequeue()`

### Requirement: Immutable append-only event files

Each state transition SHALL write a new JSON file. Files SHALL never be modified after creation. File naming SHALL follow the pattern `<counter>_evt_<uuid>.json` where counter is a zero-padded global monotonic integer shared across all events. The counter provides a total chronological ordering of all operations.

#### Scenario: Enqueue writes a file with the next counter value

- **GIVEN** the current counter is 5
- **WHEN** an event with id `"evt_abc"` is enqueued
- **THEN** a file `000006_evt_abc.json` SHALL be written to `pending/`
- **AND** the file SHALL contain the full event data with `"state": "pending"`

#### Scenario: Ack writes a file with the next counter value

- **GIVEN** an event with id `"evt_abc"` has been enqueued and dequeued, and the current counter is 10
- **WHEN** `ack("evt_abc")` is called
- **THEN** a file `000011_evt_abc.json` SHALL be written containing the full event data with `"state": "done"`

#### Scenario: Fail writes a file with the next counter value

- **GIVEN** an event with id `"evt_abc"` has been enqueued and dequeued, and the current counter is 10
- **WHEN** `fail("evt_abc")` is called
- **THEN** a file `000011_evt_abc.json` SHALL be written containing the full event data with `"state": "failed"`

### Requirement: Global counter recovery

On startup, the factory method SHALL recover the global counter by finding the maximum counter value across all filenames in both `pending/` and `archive/` directories. If both directories are empty, the counter SHALL start at 0.

#### Scenario: Counter recovered from existing files

- **GIVEN** `archive/` contains `000042_evt_old.json` and `pending/` contains `000043_evt_abc.json`
- **WHEN** the factory method runs
- **THEN** the next file written SHALL use counter value 44

### Requirement: Atomic file writes

All file writes SHALL use a write-then-rename pattern: write content to a temporary file in the same directory, then atomically rename to the final path.

#### Scenario: Crash during file write

- **GIVEN** the process crashes while writing an event file
- **WHEN** the system restarts
- **THEN** no partial or corrupted JSON files SHALL exist in `pending/`
- **AND** only complete `.tmp` files (which are ignored on recovery) may remain

### Requirement: Enqueue persists to disk

`enqueue(event)` SHALL atomically write the event file to `pending/` and then call `super.enqueue(event)` to update in-memory state and notify waiters.

#### Scenario: Event persisted before in-memory update

- **WHEN** `enqueue(event)` is called
- **THEN** the file SHALL be written to disk before the in-memory state is updated

### Requirement: Ack/fail operation sequence

`ack(eventId)` and `fail(eventId)` SHALL execute in this order:
1. Call `super.ack(eventId)` or `super.fail(eventId)` to update in-memory state and retrieve the event
2. Atomic-write the terminal state file to `pending/`
3. Move all `*_evt_<id>.json` files from `pending/` to `archive/`, lowest counter first

All steps SHALL be awaited before returning.

#### Scenario: Ack updates memory, persists, then archives

- **GIVEN** an event `"evt_abc"` is in processing state and `000001_evt_abc.json` exists in `pending/`
- **WHEN** `ack("evt_abc")` is called
- **THEN** the in-memory state SHALL be updated to done
- **AND** a new file `<counter>_evt_abc.json` (state: done) SHALL be written to `pending/`
- **AND** `000001_evt_abc.json` SHALL be moved to `archive/` before the terminal file
- **AND** the terminal file SHALL be moved to `archive/`

#### Scenario: Fail updates memory, persists, then archives

- **GIVEN** an event `"evt_abc"` is in processing state and `000001_evt_abc.json` exists in `pending/`
- **WHEN** `fail("evt_abc")` is called
- **THEN** the in-memory state SHALL be updated to failed
- **AND** a new file `<counter>_evt_abc.json` (state: failed) SHALL be written to `pending/`
- **AND** all `*_evt_abc.json` files SHALL be moved to `archive/` in ascending counter order

### Requirement: Archive move order

When moving event files from `pending/` to `archive/`, files SHALL be moved in ascending counter order (lowest counter first). This ensures that if the process crashes mid-archive, the highest-counter file remaining in `pending/` is authoritative for recovery.

#### Scenario: Crash during archive move

- **GIVEN** `ack("evt_abc")` wrote `000010_evt_abc.json` (done) and moved `000005_evt_abc.json` to `archive/`
- **WHEN** the process crashes before moving `000010_evt_abc.json`
- **THEN** on restart, `pending/` contains `000010_evt_abc.json` with state `"done"`
- **AND** recovery SHALL complete the archive (move remaining files to `archive/`)

### Requirement: Crash recovery on startup

On startup, the factory method SHALL read all `*.json` files from `pending/`, group them by event ID, and inspect the file with the highest counter per event:
- If state is `"pending"`: the event SHALL be requeued (passed to the constructor for in-memory seeding)
- If state is `"done"` or `"failed"`: the interrupted archive SHALL be completed (all files moved to `archive/`)

#### Scenario: Recover pending events after crash

- **GIVEN** `pending/` contains `000005_evt_abc.json` with state `"pending"`
- **WHEN** the factory method runs
- **THEN** the event SHALL be available via `dequeue()`

#### Scenario: Complete interrupted archive after crash

- **GIVEN** `pending/` contains `000005_evt_abc.json` (pending) and `000010_evt_abc.json` (done)
- **WHEN** the factory method runs
- **THEN** both files SHALL be moved to `archive/`
- **AND** the event SHALL NOT be available via `dequeue()`

### Requirement: Self-contained event files

Each event file SHALL contain all event fields (`id`, `type`, `payload`, `targetAction`, `correlationId`, `parentEventId`, `createdAt`) plus a `state` field. Files SHALL be independently useful for auditing without needing other files.

#### Scenario: Event file contains full data

- **WHEN** an event is enqueued
- **THEN** the written file SHALL contain all event properties and `"state": "pending"`
- **AND** `createdAt` SHALL be serialized as an ISO 8601 string

### Requirement: Dequeue is in-memory only

`dequeue()` SHALL NOT perform any filesystem operations. It SHALL be inherited from `InMemoryEventQueue` without modification.

#### Scenario: Dequeue does not write to disk

- **GIVEN** a `FileSystemEventQueue` with pending events
- **WHEN** `dequeue()` is called
- **THEN** no files SHALL be written or renamed on disk
