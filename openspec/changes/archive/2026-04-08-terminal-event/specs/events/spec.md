## MODIFIED Requirements

### Requirement: Rich event metadata

The system SHALL attach the following metadata to every event: `id`, `type`, `correlationId`, `parentEventId`, `targetAction`, `createdAt`, and `state`. Terminal events (`state === "done"`) SHALL additionally carry a `result` field. Events with `result === "failed"` SHALL additionally carry an `error` field.

#### Scenario: Trigger creates initial event

- **GIVEN** an HTTP trigger fires
- **WHEN** the event is created via `HttpTriggerContext.emit()`
- **THEN** `id` is a unique identifier (prefixed `evt_`)
- **AND** `correlationId` is a new unique ID (prefixed `corr_`)
- **AND** `parentEventId` is `undefined`
- **AND** `state` is `"pending"`
- **AND** `result` is not present
- **AND** `error` is not present

#### Scenario: Action emits downstream event

- **GIVEN** an action processing event `evt_001` emits a new event via `ctx.emit()`
- **WHEN** the downstream event is created
- **THEN** it inherits `correlationId` from `evt_001`
- **AND** `parentEventId` is set to `"evt_001"`
- **AND** `state` is `"pending"`
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

### Requirement: RuntimeEvent extends Event

The runtime SHALL define `RuntimeEvent` as a Zod union of four object variants sharing common base fields (`id`, `type`, `payload`, `targetAction`, `correlationId`, `parentEventId`, `createdAt`):

1. **ActiveEvent**: `state: "pending" | "processing"` — no `result`, no `error`
2. **SucceededEvent**: `state: "done"`, `result: "succeeded"` — no `error`
3. **SkippedEvent**: `state: "done"`, `result: "skipped"` — no `error`
4. **FailedEvent**: `state: "done"`, `result: "failed"`, `error: unknown`

The inferred `RuntimeEvent` TypeScript type SHALL allow control-flow narrowing: checking `state === "done"` SHALL make `result` available, and checking `result === "failed"` SHALL make `error` available.

#### Scenario: RuntimeEvent carries full metadata

- **GIVEN** a trigger creates a new event
- **WHEN** the RuntimeEvent is constructed
- **THEN** it contains `id` (evt_ prefix), `type`, `payload`, `correlationId` (corr_ prefix), `createdAt`, and `state: "pending"`
- **AND** `result` and `error` are not present

#### Scenario: TypeScript narrows on state

- **GIVEN** a variable of type `RuntimeEvent`
- **WHEN** code checks `event.state === "done"`
- **THEN** TypeScript infers `event.result` as `"succeeded" | "failed" | "skipped"`

#### Scenario: TypeScript narrows on result

- **GIVEN** a variable of type `RuntimeEvent` narrowed to `state === "done"`
- **WHEN** code checks `event.result === "failed"`
- **THEN** TypeScript infers `event.error` as `unknown`
