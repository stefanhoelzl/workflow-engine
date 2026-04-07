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

The system SHALL attach the following metadata to every event: `id`, `type`, `correlationId`, `parentEventId`, `targetAction`, `createdAt`.

#### Scenario: Trigger creates initial event

- **GIVEN** an HTTP trigger fires
- **WHEN** the event is created via `HttpTriggerContext.emit()`
- **THEN** `id` is a unique identifier (prefixed `evt_`)
- **AND** `correlationId` is a new unique ID (prefixed `corr_`)
- **AND** `parentEventId` is `undefined`

#### Scenario: Action emits downstream event

- **GIVEN** an action processing event `evt_001` emits a new event via `ctx.emit()`
- **WHEN** the downstream event is created
- **THEN** it inherits `correlationId` from `evt_001`
- **AND** `parentEventId` is set to `evt_001`

### Requirement: Fan-out dispatch

The system SHALL create one event file per subscribed action when an event type has multiple subscribers.

#### Scenario: Event with two subscribers

- GIVEN `OrderParsed` is subscribed to by `sendEmail` and `updateDB`
- WHEN an `OrderParsed` event is emitted
- THEN two separate event files are written to `pending/`
- AND one has `targetAction: "sendEmail"` and the other `targetAction: "updateDB"`

