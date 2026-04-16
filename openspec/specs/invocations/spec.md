# Invocations Specification

## Purpose

Define the invocation record shape, lifecycle events, and the relationship between trigger invocations and action calls.

## Requirements

### Requirement: Invocation record shape

An invocation record SHALL be the unit of persistence and indexing for a trigger run. The record SHALL contain: `id` (prefixed `evt_`), `workflow` (string), `trigger` (string), `input` (validated trigger payload), `startedAt` (ISO timestamp), `completedAt` (ISO timestamp, set on terminal transition), `status` (`"succeeded" | "failed"`), and one of `result` (when succeeded) or `error` (when failed).

#### Scenario: Succeeded invocation record

- **GIVEN** a successful trigger handler returning `{ status: 202 }`
- **WHEN** the invocation completes
- **THEN** the record SHALL contain `status: "succeeded"`, `result: { status: 202, body: "", headers: {} }`, `startedAt`, `completedAt`
- **AND** the record SHALL NOT contain an `error` field

#### Scenario: Failed invocation record

- **GIVEN** a trigger handler that throws `Error("boom")`
- **WHEN** the invocation completes
- **THEN** the record SHALL contain `status: "failed"`, `error: { message: "boom", stack: "..." }`, `startedAt`, `completedAt`
- **AND** the record SHALL NOT contain a `result` field

### Requirement: Invocation lifecycle events

The runtime SHALL define three invocation lifecycle event kinds emitted to the bus during normal operation: `started`, `completed`, `failed`. Each event SHALL carry the invocation id, workflow name, trigger name, and timestamp; `completed` events SHALL additionally carry the result; `failed` events SHALL additionally carry the serialized error.

#### Scenario: Started event has no terminal payload

- **GIVEN** an invocation about to begin
- **WHEN** the executor emits the `started` lifecycle event
- **THEN** the event SHALL carry `{ id, workflow, trigger, input, ts }`
- **AND** the event SHALL NOT carry `result` or `error`

#### Scenario: Completed event carries result

- **WHEN** the executor emits a `completed` lifecycle event
- **THEN** the event SHALL carry `{ id, workflow, trigger, ts, result }`

#### Scenario: Failed event carries error

- **WHEN** the executor emits a `failed` lifecycle event
- **THEN** the event SHALL carry `{ id, workflow, trigger, ts, error }`
- **AND** when emitted by recovery for crashed pendings, the event SHALL carry `error: { kind: "engine_crashed" }`

### Requirement: Action calls are not separate invocations

Action calls made within a trigger handler (e.g., `await sendNotification(input)`) SHALL be nested function calls within the trigger invocation, not separate persisted invocations. They SHALL NOT produce their own `pending/<id>.json` or `archive/<id>.json` files. They SHALL NOT emit lifecycle events to the bus.

#### Scenario: Action call inside trigger handler

- **GIVEN** a trigger handler that calls `await sendNotification({ message: "x" })`
- **WHEN** the handler executes
- **THEN** exactly one invocation record SHALL be persisted (for the trigger)
- **AND** no separate record SHALL be created for the `sendNotification` call

### Requirement: Invocation IDs are unique

Each invocation SHALL receive a unique id at creation. The id SHALL be prefixed `evt_` and SHALL be globally unique across the runtime.

#### Scenario: Generated id has expected prefix

- **WHEN** a new invocation is constructed
- **THEN** its id SHALL match the regex `^evt_[A-Za-z0-9_-]{8,}$`
