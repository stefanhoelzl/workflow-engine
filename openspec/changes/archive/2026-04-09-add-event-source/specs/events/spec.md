## MODIFIED Requirements

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
