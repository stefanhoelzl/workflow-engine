# Event Bus Specification

## Purpose

Provide the central event distribution mechanism that fans out runtime events and bootstrap batches to registered consumers in a deterministic order, with immutable event semantics and a typed schema for event validation.

## Requirements

### Requirement: BusConsumer interface

The system SHALL define a `BusConsumer` interface with two methods:
- `handle(event: RuntimeEvent): Promise<void>` — called for each event at runtime
- `bootstrap(events: RuntimeEvent[], options?: { finished?: boolean }): Promise<void>` — called with batches of events during startup recovery

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

The system SHALL provide a `createEventBus(consumers: BusConsumer[]): EventBus` factory function. Consumers SHALL be fixed at construction time. There SHALL be no `register()` or `unregister()` methods. Consumer order is determined by array position.

#### Scenario: Create bus with consumers

- **GIVEN** an array of BusConsumer instances `[persistence, workQueue]`
- **WHEN** `createEventBus([persistence, workQueue])` is called
- **THEN** the returned EventBus fans out events to persistence first, then workQueue

#### Scenario: Empty consumer list

- **GIVEN** an empty array
- **WHEN** `createEventBus([])` is called
- **THEN** the returned EventBus emits and bootstraps without error (no-op fan-out)

### Requirement: RuntimeEvent schema

The system SHALL define a `RuntimeEventSchema` as a Zod schema extending the SDK's `Event` type with:
- `id: string` — unique identifier prefixed with `evt_`
- `type: string` — event type
- `payload: unknown` — event data
- `correlationId: string` — correlation chain identifier
- `parentEventId?: string` — parent event for lineage (exact optional)
- `targetAction?: string` — routing hint (exact optional)
- `createdAt: Date` — creation timestamp (coerced)
- `state: "pending" | "processing" | "done" | "failed" | "skipped"` — lifecycle state
- `error?: unknown` — error information, populated when state is `"failed"` (exact optional)

The `RuntimeEvent` type SHALL be derived via `z.infer<typeof RuntimeEventSchema>`.

#### Scenario: Pending event has no error

- **GIVEN** a RuntimeEvent with `state: "pending"`
- **WHEN** the event is validated
- **THEN** `error` SHALL be `undefined`

#### Scenario: Failed event includes error

- **GIVEN** a RuntimeEvent with `state: "failed"` and `error: "timeout"`
- **WHEN** the event is validated
- **THEN** `error` SHALL be `"timeout"`

#### Scenario: Skipped event has no error

- **GIVEN** a RuntimeEvent with `state: "skipped"`
- **WHEN** the event is validated
- **THEN** `error` SHALL be `undefined`

#### Scenario: RuntimeEventSchema parses JSON from disk

- **GIVEN** a JSON object with `createdAt` as an ISO 8601 string and `state: "done"`
- **WHEN** `RuntimeEventSchema.parse(json)` is called
- **THEN** `createdAt` SHALL be a `Date` object and `state` SHALL be `"done"`

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
