# Queue Specification

## Purpose

Provide a durable, append-only event queue that persists every event to disk, supports crash recovery, and is abstracted behind an interface for future backend swaps.

## Requirements

### Requirement: QueueStore interface

The system SHALL abstract all queue operations behind a `QueueStore` interface with methods: `enqueue`, `dequeue`, `markProcessing`, `ack`, `fail`.

#### Scenario: Swap backend without runtime changes

- GIVEN the runtime uses `QueueStore` for all queue operations
- WHEN a new implementation (e.g., SQLite) is provided
- THEN the runtime works without modification

### Requirement: Filesystem implementation

The system SHALL implement `QueueStore` using filesystem directories: `pending/`, `processing/`, `done/`, `failed/`.

#### Scenario: Event lifecycle on disk

- GIVEN a new event is enqueued
- WHEN it is written to `pending/` as a JSON file
- AND the scheduler picks it up and renames it to `processing/`
- AND the action succeeds and it is renamed to `done/`
- THEN the file exists in `done/` with its full payload and metadata

### Requirement: Atomic state transitions

The system SHALL use `fs.rename` for all state transitions between queue directories.

#### Scenario: Crash during processing

- GIVEN an event file is in `processing/`
- WHEN the process crashes before completion
- THEN on restart, the file remains in `processing/`
- AND the system treats it as pending (moves it back or processes it)

### Requirement: Crash recovery on startup

The system SHALL, on startup, read all files from `pending/` and `processing/` into an in-memory list and treat all as pending.

#### Scenario: Service restarts after crash

- GIVEN 3 files in `pending/` and 1 file in `processing/` on disk
- WHEN the service starts
- THEN the in-memory pending list contains 4 events

### Requirement: In-memory pending list

The system SHALL maintain an in-memory list of pending events. The scheduler reads from this list; filesystem operations happen in the background.

#### Scenario: New event enqueued during processing

- GIVEN the scheduler is processing events
- WHEN a trigger enqueues a new event
- THEN the event is written to `pending/` on disk
- AND appended to the in-memory list
- AND the scheduler can pick it up on its next iteration

### Requirement: Append-only retention

The system SHALL never delete event files. Completed events remain in `done/`, failed events in `failed/`.

#### Scenario: Storage grows over time

- GIVEN 1000 events have been processed
- THEN 1000 files exist across `done/` and `failed/`
- AND all files are available for audit, debugging, or replay
