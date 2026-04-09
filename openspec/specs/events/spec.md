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

The system SHALL attach the following metadata to every event: `id`, `type`, `correlationId`, `parentEventId`, `targetAction`, `createdAt`, `state`, `sourceType`, and `sourceName`. Terminal events (`state === "done"`) SHALL additionally carry a `result` field. Events with `result === "failed"` SHALL additionally carry an `error` field.

#### Scenario: Trigger creates initial event

- **GIVEN** an HTTP trigger named `"orders"` fires
- **WHEN** the event is created via `HttpTriggerContext.emit()`
- **THEN** `id` is a unique identifier (prefixed `evt_`)
- **AND** `correlationId` is a new unique ID (prefixed `corr_`)
- **AND** `parentEventId` is `undefined`
- **AND** `state` is `"pending"`
- **AND** `sourceType` is `"trigger"`
- **AND** `sourceName` is `"orders"`
- **AND** `result` is not present
- **AND** `error` is not present

#### Scenario: Action emits downstream event

- **GIVEN** an action named `"parse-order"` processing event `evt_001` emits a new event via `ctx.emit()`
- **WHEN** the downstream event is created
- **THEN** it inherits `correlationId` from `evt_001`
- **AND** `parentEventId` is set to `"evt_001"`
- **AND** `state` is `"pending"`
- **AND** `sourceType` is `"action"`
- **AND** `sourceName` is `"parse-order"`
- **AND** `result` is not present

#### Scenario: Failed event carries error information

- **GIVEN** an event transitions to `state: "done"` with `result: "failed"`
- **WHEN** the RuntimeEvent is constructed
- **THEN** `error` contains the serialized error information

#### Scenario: Succeeded event has no error

- **GIVEN** an event transitions to `state: "done"` with `result: "succeeded"`
- **WHEN** the RuntimeEvent is constructed
- **THEN** `error` is not present

#### Scenario: Skipped event has no error

- **GIVEN** an event transitions to `state: "done"` with `result: "skipped"`
- **WHEN** the RuntimeEvent is constructed
- **THEN** `error` is not present

#### Scenario: Forked event inherits source from parent

- **GIVEN** a `RuntimeEvent` with `sourceType: "trigger"` and `sourceName: "my-webhook"`
- **WHEN** the scheduler forks it for fan-out
- **THEN** the forked event has `sourceType: "trigger"` and `sourceName: "my-webhook"`

#### Scenario: State transitions preserve source

- **GIVEN** a `RuntimeEvent` with `sourceType: "action"` and `sourceName: "parse-order"`
- **WHEN** the scheduler transitions it through `pending → processing → done`
- **THEN** all emitted state transitions retain `sourceType: "action"` and `sourceName: "parse-order"`

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

The runtime SHALL define `RuntimeEvent` as a Zod union of four object variants sharing common base fields (`id`, `type`, `payload`, `targetAction`, `correlationId`, `parentEventId`, `createdAt`, `sourceType`, `sourceName`):

1. **ActiveEvent**: `state: "pending" | "processing"` — no `result`, no `error`
2. **SucceededEvent**: `state: "done"`, `result: "succeeded"` — no `error`
3. **SkippedEvent**: `state: "done"`, `result: "skipped"` — no `error`
4. **FailedEvent**: `state: "done"`, `result: "failed"`, `error: unknown`

The inferred `RuntimeEvent` TypeScript type SHALL allow control-flow narrowing: checking `state === "done"` SHALL make `result` available, and checking `result === "failed"` SHALL make `error` available.

#### Scenario: RuntimeEvent carries full metadata

- **GIVEN** a trigger named `"orders"` creates a new event
- **WHEN** the RuntimeEvent is constructed
- **THEN** it contains `id` (evt_ prefix), `type`, `payload`, `correlationId` (corr_ prefix), `createdAt`, `state: "pending"`, `sourceType: "trigger"`, and `sourceName: "orders"`
- **AND** `result` and `error` are not present

#### Scenario: TypeScript narrows on state

- **GIVEN** a variable of type `RuntimeEvent`
- **WHEN** code checks `event.state === "done"`
- **THEN** TypeScript infers `event.result` as `"succeeded" | "failed" | "skipped"`

#### Scenario: TypeScript narrows on result

- **GIVEN** a variable of type `RuntimeEvent` narrowed to `state === "done"`
- **WHEN** code checks `event.result === "failed"`
- **THEN** TypeScript infers `event.error` as `unknown`

### Requirement: Five-state lifecycle model

Events SHALL have three lifecycle states: `"pending"`, `"processing"`, `"done"`. Terminal events (`state === "done"`) SHALL carry a `result` field with one of three values: `"succeeded"`, `"failed"`, `"skipped"`.

State transitions:
- `pending → processing` (scheduler dequeues the event)
- `processing → done/succeeded` (action matched and succeeded)
- `processing → done/failed` (action threw an error)
- `processing → done/skipped` (no matching action found)

The `error` field SHALL be required when `result === "failed"` and absent otherwise. This SHALL be enforced at the Zod schema level via a union of object variants.

#### Scenario: Valid state transitions for success

- **GIVEN** a RuntimeEvent with `state: "pending"`
- **WHEN** the scheduler dequeues and processes it successfully
- **THEN** the event transitions through `pending → processing → done` with `result: "succeeded"`

#### Scenario: Skipped state for unmatched events

- **GIVEN** a RuntimeEvent with `state: "processing"`
- **AND** no action matches the event
- **WHEN** the scheduler determines there is no match
- **THEN** the event transitions to `state: "done"` with `result: "skipped"`

#### Scenario: Failed state includes error

- **GIVEN** a RuntimeEvent with `state: "processing"`
- **AND** the action throws `new Error("timeout")`
- **WHEN** the scheduler catches the error
- **THEN** the event transitions to `state: "done"` with `result: "failed"` and `error` containing the error information

#### Scenario: Schema rejects error on non-failed result

- **GIVEN** a RuntimeEvent with `state: "done"` and `result: "succeeded"`
- **WHEN** the event includes an `error` field
- **THEN** Zod schema validation SHALL reject the event

#### Scenario: Schema rejects missing error on failed result

- **GIVEN** a RuntimeEvent with `state: "done"` and `result: "failed"`
- **WHEN** the event omits the `error` field
- **THEN** Zod schema validation SHALL reject the event

#### Scenario: Schema rejects result on active event

- **GIVEN** a RuntimeEvent with `state: "pending"`
- **WHEN** the event includes a `result` field
- **THEN** Zod schema validation SHALL reject the event

