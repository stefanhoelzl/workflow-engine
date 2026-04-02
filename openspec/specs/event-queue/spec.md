# Event Queue Specification

## Purpose

Provide a minimal event type and queue abstraction for the Trigger → Event → Action pipeline. Events are persisted to disk for durability and crash recovery, with the interface abstracted for future backend swaps.

## Requirements

### Requirement: Minimal Event type

An `Event` SHALL be a plain object with the following properties:
- `id`: string — unique identifier prefixed with `evt_`
- `type`: string — dot-separated event type (e.g., `"order.received"`)
- `payload`: unknown — the event data, passed through without validation
- `createdAt`: Date — timestamp of event creation

#### Scenario: Trigger creates an event
- **GIVEN** an HTTP trigger with event `"order.received"` fires with body `{ orderId: "123" }`
- **WHEN** the event is created
- **THEN** `id` starts with `evt_`
- **AND** `type` is `"order.received"` (from the trigger definition's `event` field)
- **AND** `payload` is `{ orderId: "123" }`
- **AND** `createdAt` is the current time

### Requirement: EventQueue interface

The system SHALL abstract all queue operations behind an `EventQueue` interface with methods: `enqueue`, `dequeue`, `markProcessing`, `ack`, `fail`.

#### Scenario: Enqueue an event
- **GIVEN** an `EventQueue` implementation
- **WHEN** `enqueue(event)` is called with a valid event
- **THEN** the event is stored in the queue

#### Scenario: Swap backend without runtime changes
- **GIVEN** the runtime uses `EventQueue` for all queue operations
- **WHEN** a new implementation (e.g., SQLite) is provided
- **THEN** the runtime works without modification

### Requirement: InMemoryEventQueue implementation

`InMemoryEventQueue` SHALL implement the `EventQueue` interface using an in-memory array.

#### Scenario: Events accumulate in memory
- **GIVEN** an `InMemoryEventQueue`
- **WHEN** three events are enqueued
- **THEN** all three events are stored in order

### Requirement: Trigger callback enqueues events

The `onTrigger` callback in the runtime entry point SHALL construct an `Event` from the trigger definition and request body, then enqueue it via the `EventQueue`.

#### Scenario: HTTP request becomes queued event
- **GIVEN** a running runtime with an HTTP trigger for `"order"` / `"POST"` with event `"order.received"`
- **WHEN** `POST /webhooks/order` is received with body `{ orderId: "123" }`
- **THEN** an event with type `"order.received"` and payload `{ orderId: "123" }` is enqueued
- **AND** the HTTP response is the trigger's configured static response

### Requirement: Filesystem implementation

The system SHALL implement `EventQueue` using filesystem directories: `pending/`, `processing/`, `done/`, `failed/`.

#### Scenario: Event lifecycle on disk
- **GIVEN** a new event is enqueued
- **WHEN** it is written to `pending/` as a JSON file
- **AND** the scheduler picks it up and renames it to `processing/`
- **AND** the action succeeds and it is renamed to `done/`
- **THEN** the file exists in `done/` with its full payload and metadata

### Requirement: Atomic state transitions

The system SHALL use `fs.rename` for all state transitions between queue directories.

#### Scenario: Crash during processing
- **GIVEN** an event file is in `processing/`
- **WHEN** the process crashes before completion
- **THEN** on restart, the file remains in `processing/`
- **AND** the system treats it as pending (moves it back or processes it)

### Requirement: Crash recovery on startup

The system SHALL, on startup, read all files from `pending/` and `processing/` into an in-memory list and treat all as pending.

#### Scenario: Service restarts after crash
- **GIVEN** 3 files in `pending/` and 1 file in `processing/` on disk
- **WHEN** the service starts
- **THEN** the in-memory pending list contains 4 events

### Requirement: In-memory pending list

The system SHALL maintain an in-memory list of pending events. The scheduler reads from this list; filesystem operations happen in the background.

#### Scenario: New event enqueued during processing
- **GIVEN** the scheduler is processing events
- **WHEN** a trigger enqueues a new event
- **THEN** the event is written to `pending/` on disk
- **AND** appended to the in-memory list
- **AND** the scheduler can pick it up on its next iteration

### Requirement: Append-only retention

The system SHALL never delete event files. Completed events remain in `done/`, failed events in `failed/`.

#### Scenario: Storage grows over time
- **GIVEN** 1000 events have been processed
- **THEN** 1000 files exist across `done/` and `failed/`
- **AND** all files are available for audit, debugging, or replay
