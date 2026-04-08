## ADDED Requirements

### Requirement: EventFactory with three creation modes

The system SHALL provide an `EventFactory` that centralizes `RuntimeEvent` construction. It SHALL expose three methods: `create`, `derive`, and `fork`. Each method SHALL return a `RuntimeEvent` with `state: "pending"`, a unique `evt_`-prefixed `id`, and a `createdAt` timestamp.

#### Scenario: Factory provides three methods

- **GIVEN** an `EventFactory` initialized with a schemas map
- **WHEN** the factory is inspected
- **THEN** it exposes `create`, `derive`, and `fork` methods

### Requirement: create method for new event chains

The `create` method SHALL accept `(type: string, payload: unknown, correlationId: string)`, validate the payload against the schema for the given type, and return a new `RuntimeEvent` with no `parentEventId` and no `targetAction`.

#### Scenario: Create a root event

- **GIVEN** an `EventFactory` with schemas `{ "order.received": z.object({ orderId: z.string() }) }`
- **WHEN** `create("order.received", { orderId: "abc" }, "corr_123")` is called
- **THEN** a `RuntimeEvent` is returned with `type: "order.received"`, `payload: { orderId: "abc" }`, `correlationId: "corr_123"`, `state: "pending"`, a unique `evt_`-prefixed `id`, and a `createdAt` timestamp
- **AND** `parentEventId` is `undefined`
- **AND** `targetAction` is `undefined`

#### Scenario: Create rejects invalid payload

- **GIVEN** an `EventFactory` with schemas `{ "order.received": z.object({ orderId: z.string() }) }`
- **WHEN** `create("order.received", { orderId: 123 }, "corr_123")` is called
- **THEN** a `PayloadValidationError` is thrown

#### Scenario: Create rejects unknown event type

- **GIVEN** an `EventFactory` with schemas that do not include `"order.unknown"`
- **WHEN** `create("order.unknown", {}, "corr_123")` is called
- **THEN** a `PayloadValidationError` is thrown with an empty issues array

### Requirement: derive method for child events in a chain

The `derive` method SHALL accept `(parent: RuntimeEvent, type: string, payload: unknown)`, validate the payload against the schema for the given type, and return a new `RuntimeEvent` that inherits `correlationId` from the parent and sets `parentEventId` to the parent's `id`.

#### Scenario: Derive a child event

- **GIVEN** an `EventFactory` with schemas `{ "order.validated": z.object({ valid: z.boolean() }) }`
- **AND** a parent event `{ id: "evt_001", correlationId: "corr_xyz", type: "order.received", ... }`
- **WHEN** `derive(parent, "order.validated", { valid: true })` is called
- **THEN** a `RuntimeEvent` is returned with `type: "order.validated"`, `payload: { valid: true }`, `correlationId: "corr_xyz"`, `parentEventId: "evt_001"`, `state: "pending"`, and a new unique `evt_`-prefixed `id`
- **AND** `targetAction` is `undefined`

#### Scenario: Derive rejects invalid payload

- **GIVEN** an `EventFactory` with schemas `{ "order.validated": z.object({ valid: z.boolean() }) }`
- **AND** a parent event
- **WHEN** `derive(parent, "order.validated", { valid: "yes" })` is called
- **THEN** a `PayloadValidationError` is thrown

### Requirement: fork method for fan-out copies

The `fork` method SHALL accept `(parent: RuntimeEvent, options: { targetAction: string })` and return a new `RuntimeEvent` that copies `type`, `payload`, and `correlationId` from the parent, sets `parentEventId` to the parent's `id`, and sets `targetAction` from the options. The `fork` method SHALL NOT validate the payload.

#### Scenario: Fork creates a targeted copy

- **GIVEN** a parent event `{ id: "evt_001", type: "order.received", payload: { orderId: "abc" }, correlationId: "corr_xyz", ... }`
- **WHEN** `fork(parent, { targetAction: "sendEmail" })` is called
- **THEN** a `RuntimeEvent` is returned with `type: "order.received"`, `payload: { orderId: "abc" }`, `correlationId: "corr_xyz"`, `parentEventId: "evt_001"`, `targetAction: "sendEmail"`, `state: "pending"`, and a new unique `evt_`-prefixed `id`

#### Scenario: Fork preserves payload without re-validation

- **GIVEN** a parent event with a validated payload
- **WHEN** `fork(parent, { targetAction: "notify" })` is called
- **THEN** the payload is copied as-is from the parent
- **AND** no schema lookup or validation occurs

#### Scenario: Fork generates independent metadata

- **GIVEN** a parent event with `id: "evt_001"` and `createdAt: 2026-04-08T10:00:00Z`
- **WHEN** `fork(parent, { targetAction: "sendEmail" })` is called
- **THEN** the forked event has a different `evt_`-prefixed `id` than `"evt_001"`
- **AND** the forked event has its own `createdAt` timestamp

### Requirement: EventFactory is a closure-based factory

The `EventFactory` SHALL be created via a `createEventFactory(schemas)` function that accepts a schemas map typed as `Record<string, { parse(data: unknown): unknown }>`. There SHALL be no exported `EventFactory` class.

#### Scenario: Factory creation

- **GIVEN** a schemas map `{ "order.received": z.object({ orderId: z.string() }) }`
- **WHEN** `createEventFactory(schemas)` is called
- **THEN** the returned object has `create`, `derive`, and `fork` methods
