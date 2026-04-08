## MODIFIED Requirements

### Requirement: ContextFactory

The system SHALL provide a `ContextFactory` class that holds an EventBus reference, a schemas map, an injected fetch function, an injected env record, and a Logger instance. It SHALL expose `httpTrigger` and `action` as arrow properties for creating context objects. The Logger SHALL be passed via the constructor.

The schemas map SHALL be typed as `Record<string, { parse(data: unknown): unknown }>` (structural typing, no direct Zod import). The `ContextFactory` SHALL use the schemas map to validate event payloads in `#createAndEmit` before emitting to the bus.

#### Scenario: Create HttpTriggerContext via factory

- **GIVEN** a `ContextFactory` initialized with an EventBus, a schemas map, a fetch function, an env record, and a Logger
- **WHEN** `factory.httpTrigger(body, definition)` is called
- **THEN** an `HttpTriggerContext` is returned with the request body, definition, and a working `emit()` method that validates payloads
- **AND** `HttpTriggerContext` does NOT have an `env` property

#### Scenario: Create ActionContext via factory

- **GIVEN** a `ContextFactory` initialized with an EventBus, a schemas map, a fetch function, an env record `{ "API_KEY": "secret" }`, and a Logger
- **WHEN** `factory.action(event)` is called
- **THEN** an `ActionContext` is returned with the source event, a working `emit()` method that validates payloads, the injected fetch function, and `env` containing `{ "API_KEY": "secret" }`

#### Scenario: Factory properties can be passed as standalone references

- **GIVEN** a `ContextFactory` instance
- **WHEN** `factory.action` is assigned to a variable and called
- **THEN** it works correctly without explicit binding (arrow property captures `this`)

#### Scenario: Emit with valid payload creates RuntimeEvent and emits to bus

- **GIVEN** a `ContextFactory` with schemas `{ "order.received": z.object({ orderId: z.string() }) }`
- **WHEN** `ctx.emit("order.received", { orderId: "abc" })` is called from an HttpTriggerContext
- **THEN** a RuntimeEvent is created with `state: "pending"`, a new `evt_`-prefixed id, a new `corr_`-prefixed correlationId, and the validated payload
- **AND** `bus.emit(runtimeEvent)` is called

#### Scenario: Emit from ActionContext creates child RuntimeEvent

- **GIVEN** a `ContextFactory` with an EventBus
- **AND** an `ActionContext` for event `evt_001` with `correlationId: "corr_xyz"`
- **WHEN** `ctx.emit("order.validated", { valid: true })` is called
- **THEN** the RuntimeEvent has `correlationId: "corr_xyz"`, `parentEventId: "evt_001"`, and `state: "pending"`
- **AND** `bus.emit(runtimeEvent)` is called

#### Scenario: Emit with invalid payload throws PayloadValidationError

- **GIVEN** a `ContextFactory` with schemas `{ "order.received": z.object({ orderId: z.string() }) }`
- **WHEN** `ctx.emit("order.received", { orderId: 123 })` is called
- **THEN** a `PayloadValidationError` is thrown
- **AND** `bus.emit()` is NOT called

#### Scenario: Emit with unknown event type throws PayloadValidationError

- **GIVEN** a `ContextFactory` with schemas that do not include `"order.unknown"`
- **WHEN** `ctx.emit("order.unknown", {})` is called
- **THEN** a `PayloadValidationError` is thrown
- **AND** `bus.emit()` is NOT called

### Requirement: ContextFactory emit logging

The `ContextFactory.#createAndEmit` method SHALL log every event creation. This covers all emits from both `HttpTriggerContext` and `ActionContext` in a single location.

#### Scenario: Root event emitted from trigger

- **GIVEN** a `ContextFactory` with a Logger
- **AND** an `HttpTriggerContext` created by the factory
- **WHEN** `ctx.emit("order.received", { orderId: "abc" })` is called
- **THEN** `event.emitted` is logged at info level with correlationId, type `"order.received"`, and the new eventId
- **AND** `event.emitted.payload` is logged at trace level with the full payload

#### Scenario: Child event emitted from action

- **GIVEN** a `ContextFactory` with a Logger
- **AND** an `ActionContext` for event `evt_001` with `correlationId: "corr_xyz"`
- **WHEN** `ctx.emit("order.validated", { valid: true })` is called
- **THEN** `event.emitted` is logged at info level with correlationId `"corr_xyz"`, type `"order.validated"`, the new eventId, and parentEventId `"evt_001"`
- **AND** `event.emitted.payload` is logged at trace level with the full payload

#### Scenario: Targeted event includes targetAction in log

- **GIVEN** a `ContextFactory` with a Logger
- **WHEN** an event is emitted with `targetAction: "notify"`
- **THEN** `event.emitted` log entry includes `targetAction: "notify"`
