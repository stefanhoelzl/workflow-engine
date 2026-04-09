## Purpose

Provide centralized RuntimeEvent construction and emission through a single EventSource that combines event creation with auto-emit to the EventBus, supporting three creation modes (create, derive, fork) and state transitions.

## Requirements

### Requirement: EventSource with three creation modes and auto-emit

The system SHALL provide an `EventSource` that centralizes `RuntimeEvent` construction and emission. It SHALL expose three creation methods: `create`, `derive`, and `fork`. Each method SHALL validate/construct the event, emit it to the EventBus, and return the `RuntimeEvent`. All three methods SHALL return `Promise<RuntimeEvent>`.

The EventSource SHALL be created via `createEventSource(schemas, bus)` where `schemas` is `Record<string, { parse(data: unknown): unknown }>` and `bus` is an `EventBus`. There SHALL be no exported `EventSource` class.

#### Scenario: Factory provides three creation methods and transition

- **GIVEN** an `EventSource` initialized with a schemas map and an EventBus
- **WHEN** the source is inspected
- **THEN** it exposes `create`, `derive`, `fork`, and `transition` methods

### Requirement: create method creates and emits root events

The `create` method SHALL accept `(type: string, payload: unknown)`, validate the payload against the schema for the given type, generate a `corr_`-prefixed correlation ID, construct a `RuntimeEvent` with `state: "pending"`, `createdAt: now`, `emittedAt: now`, emit it to the bus, and return the event.

#### Scenario: Create a root event with auto-emit

- **GIVEN** an `EventSource` with schemas `{ "order.received": z.object({ orderId: z.string() }) }` and a bus with a collector consumer
- **WHEN** `create("order.received", { orderId: "abc" })` is awaited
- **THEN** a `RuntimeEvent` is returned with `type: "order.received"`, `payload: { orderId: "abc" }`, `state: "pending"`, a unique `evt_`-prefixed `id`, a unique `corr_`-prefixed `correlationId`, `createdAt` set, and `emittedAt` set
- **AND** `parentEventId` is `undefined`
- **AND** `targetAction` is `undefined`
- **AND** the collector consumer received the event via `handle()`

#### Scenario: Create rejects invalid payload

- **GIVEN** an `EventSource` with schemas `{ "order.received": z.object({ orderId: z.string() }) }`
- **WHEN** `create("order.received", { orderId: 123 })` is awaited
- **THEN** a `PayloadValidationError` is thrown
- **AND** the bus does NOT receive any event

#### Scenario: Create rejects unknown event type

- **GIVEN** an `EventSource` with schemas that do not include `"order.unknown"`
- **WHEN** `create("order.unknown", {})` is awaited
- **THEN** a `PayloadValidationError` is thrown with an empty issues array

### Requirement: derive method creates and emits child events

The `derive` method SHALL accept `(parent: RuntimeEvent, type: string, payload: unknown)`, validate the payload, construct a `RuntimeEvent` that inherits `correlationId` from the parent and sets `parentEventId` to the parent's `id`, emit it to the bus, and return the event.

#### Scenario: Derive a child event with auto-emit

- **GIVEN** an `EventSource` with schemas and a bus with a collector consumer
- **AND** a parent event `{ id: "evt_001", correlationId: "corr_xyz" }`
- **WHEN** `derive(parent, "order.validated", { valid: true })` is awaited
- **THEN** a `RuntimeEvent` is returned with `correlationId: "corr_xyz"`, `parentEventId: "evt_001"`, `state: "pending"`, `createdAt` set, and `emittedAt` set
- **AND** the collector consumer received the event

#### Scenario: Derive rejects invalid payload

- **GIVEN** an `EventSource` with schemas `{ "order.validated": z.object({ valid: z.boolean() }) }`
- **WHEN** `derive(parent, "order.validated", { valid: "yes" })` is awaited
- **THEN** a `PayloadValidationError` is thrown
- **AND** the bus does NOT receive any event

### Requirement: fork method creates and emits targeted copies

The `fork` method SHALL accept `(parent: RuntimeEvent, options: { targetAction: string })`, construct a `RuntimeEvent` that copies `type`, `payload`, and `correlationId` from the parent, set `parentEventId` and `targetAction`, emit it to the bus, and return the event. Fork SHALL NOT validate the payload.

#### Scenario: Fork creates a targeted copy with auto-emit

- **GIVEN** a parent event `{ id: "evt_001", type: "order.received", payload: { orderId: "abc" }, correlationId: "corr_xyz" }`
- **AND** a bus with a collector consumer
- **WHEN** `fork(parent, { targetAction: "sendEmail" })` is awaited
- **THEN** a `RuntimeEvent` is returned with `targetAction: "sendEmail"`, `parentEventId: "evt_001"`, `correlationId: "corr_xyz"`, `state: "pending"`, `createdAt` set, and `emittedAt` set
- **AND** the collector consumer received the event

### Requirement: transition method emits state changes

The `transition` method SHALL accept `(event: RuntimeEvent, opts)` where opts is a discriminated union:
- `{ state: "processing" }` — sets `emittedAt = now`, `startedAt = now`
- `{ state: "done", result: "skipped" | "succeeded" }` — sets `emittedAt = now`, `doneAt = now`, `startedAt = event.startedAt ?? now`
- `{ state: "done", result: "failed", error: string }` — sets `emittedAt = now`, `doneAt = now`, `startedAt = event.startedAt ?? now`

The method SHALL create a new event object via spread (immutability), emit it to the bus, and return `Promise<void>`.

TypeScript types SHALL enforce that `"done"` requires `result`, and `"failed"` requires `error`.

#### Scenario: Transition to processing

- **GIVEN** an `EventSource` with a bus and a collector consumer
- **AND** a pending event
- **WHEN** `transition(event, { state: "processing" })` is awaited
- **THEN** the collector receives an event with `state: "processing"`, `emittedAt` set to now, and `startedAt` set to now

#### Scenario: Transition to done/succeeded

- **GIVEN** a processing event with `startedAt` set
- **WHEN** `transition(event, { state: "done", result: "succeeded" })` is awaited
- **THEN** the collector receives an event with `state: "done"`, `result: "succeeded"`, `emittedAt` set, `doneAt` set, and `startedAt` preserved from the input event

#### Scenario: Transition to done/failed with error

- **GIVEN** a processing event with `startedAt` set
- **WHEN** `transition(event, { state: "done", result: "failed", error: "timeout" })` is awaited
- **THEN** the collector receives an event with `state: "done"`, `result: "failed"`, `error: "timeout"`, `emittedAt` set, and `doneAt` set

#### Scenario: Transition to done/skipped without prior processing

- **GIVEN** a pending event with no `startedAt`
- **WHEN** `transition(event, { state: "done", result: "skipped" })` is awaited
- **THEN** the collector receives an event with `startedAt` equal to `doneAt`

#### Scenario: Transition preserves immutability

- **GIVEN** a pending event `original`
- **WHEN** `transition(original, { state: "processing" })` is awaited
- **THEN** `original.state` remains `"pending"`
- **AND** `original.startedAt` remains undefined

### Requirement: EventSource module exports

The `event-source.ts` module SHALL export:
- `createEventSource` factory function
- `EventSource` interface type

#### Scenario: All types importable from event-source module

- **WHEN** a consumer imports from the event-source module
- **THEN** `createEventSource` and `EventSource` are available
