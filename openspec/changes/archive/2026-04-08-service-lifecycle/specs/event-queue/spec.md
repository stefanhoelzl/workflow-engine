## MODIFIED Requirements

### Requirement: EventQueue interface

The system SHALL abstract all queue operations behind a promise-based `EventQueue` interface with methods: `enqueue(event): Promise<void>`, `dequeue(signal?: AbortSignal): Promise<Event>`, `ack(eventId): Promise<void>`, `fail(eventId): Promise<void>`.

#### Scenario: Enqueue an event

- **GIVEN** an `EventQueue` implementation
- **WHEN** `await enqueue(event)` is called with a valid event
- **THEN** the event is stored in the queue as pending

#### Scenario: Dequeue an event

- **GIVEN** an `EventQueue` with pending events
- **WHEN** `await dequeue()` is called
- **THEN** the next pending event is returned
- **AND** the event is marked as processing

#### Scenario: Dequeue blocks when queue is empty

- **GIVEN** an `EventQueue` with no pending events
- **WHEN** `dequeue()` is called
- **THEN** the returned promise does not resolve
- **AND** when an event is subsequently enqueued
- **THEN** the promise resolves with that event

#### Scenario: Dequeue is cancelled via AbortSignal

- **GIVEN** an `EventQueue` with no pending events
- **WHEN** `dequeue(signal)` is called with an `AbortSignal`
- **AND** the signal is aborted before an event arrives
- **THEN** the returned promise rejects with an error where `error.name` is `'AbortError'`

#### Scenario: Dequeue with AbortSignal resolves normally when event arrives first

- **GIVEN** an `EventQueue` with no pending events
- **WHEN** `dequeue(signal)` is called with an `AbortSignal`
- **AND** an event is enqueued before the signal is aborted
- **THEN** the returned promise resolves with the event
- **AND** the abort listener is cleaned up

#### Scenario: Aborted dequeue cleans up waiter

- **GIVEN** an `EventQueue` with no pending events and a pending `dequeue(signal)` call
- **WHEN** the signal is aborted
- **THEN** the waiter is removed from the internal waiter list
- **AND** a subsequently enqueued event does not resolve the aborted promise

#### Scenario: Acknowledge a processed event

- **GIVEN** an event in processing state
- **WHEN** `await ack(eventId)` is called
- **THEN** the event is marked as done

#### Scenario: Fail a processed event

- **GIVEN** an event in processing state
- **WHEN** `await fail(eventId)` is called
- **THEN** the event is marked as failed

#### Scenario: Swap backend without runtime changes

- **GIVEN** the runtime uses `EventQueue` for all queue operations
- **WHEN** a new implementation (e.g., SQLite) is provided
- **THEN** the runtime works without modification
