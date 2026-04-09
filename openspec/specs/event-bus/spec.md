# Event Bus Specification

## Purpose

Provide the central event distribution mechanism that fans out runtime events and bootstrap batches to registered consumers in a deterministic order, with immutable event semantics and a typed schema for event validation.

## Requirements

### Requirement: BusConsumer interface

The system SHALL define a `BusConsumer` interface with two methods:
- `handle(event: RuntimeEvent): Promise<void>` — called for each event at runtime
- `bootstrap(events: RuntimeEvent[], options?: { finished?: boolean; pending?: boolean }): Promise<void>` — called with batches of events during startup recovery

The `pending` option signals the source of the batch:
- `pending: true` — the batch contains active events from the `pending/` directory (at most one per event ID, current state)
- `pending: false` — the batch contains historical events from the `archive/` directory

Both methods SHALL be required (no optional methods). Consumers that do not need bootstrap logic SHALL provide an empty implementation.

#### Scenario: Consumer receives runtime event

- **GIVEN** a registered BusConsumer
- **WHEN** `bus.emit(event)` is called
- **THEN** the consumer's `handle(event)` is called with the full RuntimeEvent

#### Scenario: Consumer receives bootstrap batch

- **GIVEN** a registered BusConsumer
- **WHEN** `bus.bootstrap(events, { finished: false })` is called
- **THEN** the consumer's `bootstrap(events, { finished: false })` is called with the batch

#### Scenario: Consumer receives bootstrap completion signal

- **GIVEN** a registered BusConsumer
- **WHEN** `bus.bootstrap([], { finished: true })` is called
- **THEN** the consumer's `bootstrap([], { finished: true })` is called

#### Scenario: Consumer receives pending batch

- **GIVEN** a registered BusConsumer
- **WHEN** `bus.bootstrap(events, { pending: true })` is called
- **THEN** the consumer's `bootstrap(events, { pending: true })` is called

#### Scenario: Consumer receives archive batch

- **GIVEN** a registered BusConsumer
- **WHEN** `bus.bootstrap(events, { pending: false })` is called
- **THEN** the consumer's `bootstrap(events, { pending: false })` is called

### Requirement: EventBus interface

The system SHALL define an `EventBus` interface with two methods:
- `emit(event: RuntimeEvent): Promise<void>` — fan out a runtime event to all consumers
- `bootstrap(events: RuntimeEvent[], options?: { finished?: boolean }): Promise<void>` — fan out a bootstrap batch to all consumers

#### Scenario: Emit fans out to all consumers in order

- **GIVEN** an EventBus created with consumers `[A, B, C]`
- **WHEN** `bus.emit(event)` is called
- **THEN** `A.handle(event)` is awaited first
- **AND** `B.handle(event)` is awaited second
- **AND** `C.handle(event)` is awaited third

#### Scenario: Bootstrap fans out to all consumers in order

- **GIVEN** an EventBus created with consumers `[A, B, C]`
- **WHEN** `bus.bootstrap(events, options)` is called
- **THEN** `A.bootstrap(events, options)` is awaited first
- **AND** `B.bootstrap(events, options)` is awaited second
- **AND** `C.bootstrap(events, options)` is awaited third

#### Scenario: Consumer error propagates

- **GIVEN** an EventBus with consumer A whose `handle()` throws an error
- **WHEN** `bus.emit(event)` is called
- **THEN** the error propagates to the caller
- **AND** subsequent consumers are NOT called

### Requirement: createEventBus factory

The system SHALL provide a `createEventBus(consumers: BusConsumer[]): EventBus` factory function. Consumers SHALL be fixed at construction time. There SHALL be no `register()` or `unregister()` methods. Consumer order is determined by array position. The recommended consumer order is: Persistence, WorkQueue, EventStore, Logging.

#### Scenario: Create bus with consumers
- **GIVEN** an array of BusConsumer instances `[persistence, workQueue, eventStore, logging]`
- **WHEN** `createEventBus([persistence, workQueue, eventStore, logging])` is called
- **THEN** the returned EventBus fans out events to all four consumers in order

#### Scenario: Empty consumer list
- **GIVEN** an empty array
- **WHEN** `createEventBus([])` is called
- **THEN** the returned EventBus emits and bootstraps without error (no-op fan-out)

### Requirement: RuntimeEvent schema

The system SHALL define a `RuntimeEventSchema` as a Zod discriminated union with the following base fields:
- `id: string` — unique identifier prefixed with `evt_`
- `type: string` — event type
- `payload: unknown` — event data
- `correlationId: string` — correlation chain identifier
- `parentEventId?: string` — parent event for lineage (exact optional)
- `targetAction?: string` — routing hint (exact optional)
- `createdAt: Date` — immutable event birth timestamp (coerced), set once by create/derive/fork
- `emittedAt: Date` — per-emit timestamp (coerced), set on every emit
- `startedAt?: Date` — processing start timestamp (exact optional, coerced)
- `doneAt?: Date` — processing end timestamp (exact optional, coerced)

State-specific fields via discriminated union on `state`:
- `state: "pending" | "processing"` — active events
- `state: "done"` with `result: "succeeded" | "skipped" | "failed"` — terminal events; `failed` includes `error: unknown`

The `RuntimeEvent` type SHALL be derived via `z.infer<typeof RuntimeEventSchema>`.

#### Scenario: Pending event has timestamps

- **GIVEN** a RuntimeEvent with `state: "pending"`
- **WHEN** the event is validated
- **THEN** `createdAt` and `emittedAt` SHALL be `Date` objects
- **AND** `startedAt` and `doneAt` SHALL be `undefined`

#### Scenario: Processing event has startedAt

- **GIVEN** a RuntimeEvent with `state: "processing"` and `startedAt` set
- **WHEN** the event is validated
- **THEN** `startedAt` SHALL be a `Date` object
- **AND** `doneAt` SHALL be `undefined`

#### Scenario: Done event has all timestamps

- **GIVEN** a RuntimeEvent with `state: "done"`, `result: "succeeded"`, `startedAt` and `doneAt` set
- **WHEN** the event is validated
- **THEN** `createdAt`, `emittedAt`, `startedAt`, and `doneAt` SHALL all be `Date` objects

#### Scenario: Failed event includes error

- **GIVEN** a RuntimeEvent with `state: "done"`, `result: "failed"`, and `error: "timeout"`
- **WHEN** the event is validated
- **THEN** `error` SHALL be `"timeout"`

#### Scenario: RuntimeEventSchema parses JSON from disk

- **GIVEN** a JSON object with `createdAt` and `emittedAt` as ISO 8601 strings and `state: "done"`
- **WHEN** `RuntimeEventSchema.parse(json)` is called
- **THEN** `createdAt`, `emittedAt`, `startedAt`, and `doneAt` SHALL be `Date` objects (where present)

#### Scenario: Old events without new timestamp fields

- **GIVEN** a JSON object from persisted storage that lacks `emittedAt`, `startedAt`, and `doneAt` fields
- **WHEN** `RuntimeEventSchema.parse(json)` is called
- **THEN** parsing SHALL succeed with `emittedAt` defaulting to `createdAt`, and `startedAt`/`doneAt` as `undefined`

### Requirement: Events are immutable

Events SHALL be treated as immutable. State transitions SHALL create new RuntimeEvent objects via object spread (`{...event, state: "done"}`). The original event object SHALL never be mutated.

#### Scenario: State transition creates new object

- **GIVEN** a RuntimeEvent `original` with `state: "pending"`
- **WHEN** a state transition creates `{...original, state: "processing"}`
- **THEN** `original.state` remains `"pending"`
- **AND** the new object has `state: "processing"`

### Requirement: Module exports

The `event-bus/index.ts` module SHALL export:
- `RuntimeEventSchema` (Zod schema)
- `RuntimeEvent` type
- `EventBus` interface
- `BusConsumer` interface
- `createEventBus` factory function

#### Scenario: All types importable from event-bus module

- **WHEN** a consumer imports from the event-bus module
- **THEN** `RuntimeEventSchema`, `RuntimeEvent`, `EventBus`, `BusConsumer`, and `createEventBus` are available
