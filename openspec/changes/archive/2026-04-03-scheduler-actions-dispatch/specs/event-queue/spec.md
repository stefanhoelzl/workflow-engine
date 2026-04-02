## MODIFIED Requirements

### Requirement: Minimal Event type

An `Event` SHALL be a plain object with the following properties:
- `id`: string — unique identifier prefixed with `evt_`
- `type`: string — dot-separated event type (e.g., `"order.received"`)
- `payload`: unknown — the event data, passed through without validation
- `targetAction`: string | undefined — the action this event is targeted at, or `undefined` for undispatched events
- `createdAt`: Date — timestamp of event creation

#### Scenario: Trigger creates an event

- **GIVEN** an HTTP trigger with event `"order.received"` fires with body `{ orderId: "123" }`
- **WHEN** the event is created
- **THEN** `id` starts with `evt_`
- **AND** `type` is `"order.received"`
- **AND** `payload` is `{ orderId: "123" }`
- **AND** `targetAction` is `undefined`
- **AND** `createdAt` is the current time

#### Scenario: Dispatch creates a targeted event

- **GIVEN** dispatch fans out an event for action `parseOrder`
- **WHEN** the targeted event is created
- **THEN** `targetAction` is `"parseOrder"`
- **AND** all other properties are copied from the original event (with a new `id`)

### Requirement: EventQueue interface

The system SHALL abstract all queue operations behind a promise-based `EventQueue` interface with methods: `enqueue(event): Promise<void>`, `dequeue(): Promise<Event>`, `ack(eventId): Promise<void>`, `fail(eventId): Promise<void>`.

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

### Requirement: InMemoryEventQueue implementation

`InMemoryEventQueue` SHALL implement the `EventQueue` interface using an in-memory array with state tracking.

#### Scenario: Event lifecycle in memory

- **GIVEN** an `InMemoryEventQueue`
- **WHEN** an event is enqueued, then dequeued, then acked
- **THEN** the event transitions through pending → processing → done

#### Scenario: Multiple events in queue

- **GIVEN** an `InMemoryEventQueue` with three pending events
- **WHEN** `dequeue()` is called
- **THEN** the first pending event is returned
- **AND** the remaining two are still pending
