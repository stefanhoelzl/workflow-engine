# Events Specification

## Purpose

Provide a typed, schema-backed event system that serves as the connective tissue between triggers and actions. Events carry both payload data and rich metadata for tracing and debugging.

## Requirements

### Requirement: Zod-based event definitions

The system SHALL use Zod schemas to define event payload types, providing compile-time TypeScript type inference via `z.infer<>`.

#### Scenario: Define a typed event

- GIVEN a call to `defineEvent('order.received', z.object({ orderId: z.string() }))`
- WHEN an action declares `ctx: ActionContext<typeof OrderReceived, [...]>`
- THEN `ctx.data` is typed as `{ orderId: string }`
- AND type errors are caught at compile time

### Requirement: Runtime payload validation

The system SHALL validate event payloads at runtime against their Zod schema before enqueuing. The parsed output (with transforms, defaults, and stripping applied) SHALL be used as the event payload. Zod schemas continue to provide compile-time TypeScript type inference via `z.infer<>`.

#### Scenario: Valid payload is parsed and enqueued

- **GIVEN** an event type `"order.received"` with a Zod schema `z.object({ orderId: z.string() })`
- **WHEN** `ctx.emit("order.received", { orderId: "abc", extra: true })` is called
- **THEN** the event is enqueued with `payload: { orderId: "abc" }` (extra field stripped by Zod's default behavior)

#### Scenario: Invalid payload is rejected

- **GIVEN** an event type `"order.received"` with a Zod schema requiring `{ orderId: z.string() }`
- **WHEN** `ctx.emit("order.received", { orderId: 123 })` is called with an invalid payload
- **THEN** the event is NOT enqueued
- **AND** a `PayloadValidationError` is thrown

#### Scenario: Unknown event type is rejected

- **GIVEN** no schema is defined for event type `"order.unknown"`
- **WHEN** `ctx.emit("order.unknown", {})` is called
- **THEN** the event is NOT enqueued
- **AND** a `PayloadValidationError` is thrown with an empty issues array

### Requirement: Rich event metadata

The system SHALL attach the following metadata to every event: `id`, `type`, `correlationId`, `parentEventId`, `targetAction`, `createdAt`, `state`, and optionally `error`.

#### Scenario: Trigger creates initial event

- **GIVEN** an HTTP trigger fires
- **WHEN** the event is created via `HttpTriggerContext.emit()`
- **THEN** `id` is a unique identifier (prefixed `evt_`)
- **AND** `correlationId` is a new unique ID (prefixed `corr_`)
- **AND** `parentEventId` is `undefined`
- **AND** `state` is `"pending"`

#### Scenario: Action emits downstream event

- **GIVEN** an action processing event `evt_001` emits a new event via `ctx.emit()`
- **WHEN** the downstream event is created
- **THEN** it inherits `correlationId` from `evt_001`
- **AND** `parentEventId` is set to `"evt_001"`
- **AND** `state` is `"pending"`

#### Scenario: Failed event carries error information

- **GIVEN** an event transitions to `state: "failed"`
- **WHEN** the RuntimeEvent is constructed
- **THEN** `error` contains the serialized error information

### Requirement: Fan-out dispatch

The system SHALL create one event file per subscribed action when an event type has multiple subscribers.

#### Scenario: Event with two subscribers

- GIVEN `OrderParsed` is subscribed to by `sendEmail` and `updateDB`
- WHEN an `OrderParsed` event is emitted
- THEN two separate event files are written to `pending/`
- AND one has `targetAction: "sendEmail"` and the other `targetAction: "updateDB"`

### Requirement: SDK Event type

The SDK package SHALL export an `Event` type representing the minimal event interface that action handlers receive. It SHALL contain `name: string` and `payload: unknown`. This type MAY diverge from `EventDefinition` in the future but SHALL currently have the same shape.

#### Scenario: Action handler receives SDK Event

- **GIVEN** an action processing an event with type `"order.received"` and payload `{ orderId: "abc" }`
- **WHEN** the runtime invokes the SDK-defined handler
- **THEN** the handler receives `ctx.event` typed as `Event` with `{ name: "order.received", payload: { orderId: "abc" } }`

### Requirement: RuntimeEvent extends Event

The runtime SHALL define `RuntimeEvent` as an extension of the event model with infrastructure fields (`id`, `correlationId`, `parentEventId`, `targetAction`, `createdAt`) and lifecycle fields (`state`, `error`). The `RuntimeEvent` type SHALL be the canonical type flowing through the EventBus.

#### Scenario: RuntimeEvent carries full metadata

- **GIVEN** a trigger creates a new event
- **WHEN** the RuntimeEvent is constructed
- **THEN** it contains `id` (evt_ prefix), `type`, `payload`, `correlationId` (corr_ prefix), `createdAt`, and `state: "pending"`

### Requirement: Five-state lifecycle model

Events SHALL have five possible states: `"pending"`, `"processing"`, `"done"`, `"failed"`, `"skipped"`. Terminal states are `"done"`, `"failed"`, and `"skipped"`.

State transitions:
- `pending → processing` (scheduler dequeues the event)
- `processing → done` (action matched and succeeded)
- `processing → failed` (action threw an error, or ambiguous match)
- `processing → skipped` (no matching action found)

#### Scenario: Valid state transitions

- **GIVEN** a RuntimeEvent with `state: "pending"`
- **WHEN** the scheduler dequeues and processes it successfully
- **THEN** the event transitions through `pending → processing → done`

#### Scenario: Skipped state for unmatched events

- **GIVEN** a RuntimeEvent with `state: "processing"`
- **AND** no action matches the event
- **WHEN** the scheduler determines there is no match
- **THEN** the event transitions to `state: "skipped"`

#### Scenario: Failed state includes error

- **GIVEN** a RuntimeEvent with `state: "processing"`
- **AND** the action throws `new Error("timeout")`
- **WHEN** the scheduler catches the error
- **THEN** the event transitions to `state: "failed"` with `error` containing the error information

