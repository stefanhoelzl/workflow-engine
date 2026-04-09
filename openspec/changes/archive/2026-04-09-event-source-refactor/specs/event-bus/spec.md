## MODIFIED Requirements

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
