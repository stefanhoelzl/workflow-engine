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

### Requirement: Compile-time only validation

The system SHALL NOT perform runtime validation of event payloads in v1. Zod schemas exist solely for TypeScript type inference.

#### Scenario: Malformed payload at runtime

- GIVEN a trigger produces a payload missing a required field
- WHEN the event is enqueued
- THEN it is enqueued without validation
- AND the action receives the malformed data as-is

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

