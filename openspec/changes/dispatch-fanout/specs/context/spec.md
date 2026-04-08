## MODIFIED Requirements

### Requirement: ContextFactory

The system SHALL provide a `ContextFactory` class that holds an EventBus reference, an `EventFactory` instance, an injected fetch function, an injected env record, and a Logger instance. It SHALL expose `httpTrigger` and `action` as arrow properties for creating context objects. The Logger SHALL be passed via the constructor.

The `ContextFactory` SHALL delegate event construction to the `EventFactory`:
- `httpTrigger.emit()` calls `eventFactory.create()` and then `bus.emit()`
- `action.emit()` calls `eventFactory.derive()` and then `bus.emit()`

#### Scenario: Create HttpTriggerContext via factory

- **GIVEN** a `ContextFactory` initialized with an EventBus, an EventFactory, a fetch function, an env record, and a Logger
- **WHEN** `factory.httpTrigger(body, definition)` is called
- **THEN** an `HttpTriggerContext` is returned with the request body, definition, and a working `emit()` method
- **AND** `HttpTriggerContext` does NOT have an `env` property

#### Scenario: Create ActionContext via factory

- **GIVEN** a `ContextFactory` initialized with an EventBus, an EventFactory, a fetch function, an env record `{ "API_KEY": "secret" }`, and a Logger
- **WHEN** `factory.action(event)` is called
- **THEN** an `ActionContext` is returned with the source event, a working `emit()` method, the injected fetch function, and `env` containing `{ "API_KEY": "secret" }`

#### Scenario: HttpTrigger emit uses EventFactory.create

- **GIVEN** a `ContextFactory` with an EventFactory
- **WHEN** `ctx.emit("order.received", { orderId: "abc" })` is called from an HttpTriggerContext
- **THEN** `EventFactory.create()` is called with the type, payload, and a new `corr_`-prefixed correlationId
- **AND** the resulting RuntimeEvent is emitted to the bus

#### Scenario: Action emit uses EventFactory.derive

- **GIVEN** a `ContextFactory` with an EventFactory
- **AND** an `ActionContext` for event `evt_001` with `correlationId: "corr_xyz"`
- **WHEN** `ctx.emit("order.validated", { valid: true })` is called
- **THEN** `EventFactory.derive()` is called with the parent event, type, and payload
- **AND** the resulting RuntimeEvent is emitted to the bus

#### Scenario: Factory properties can be passed as standalone references

- **GIVEN** a `ContextFactory` instance
- **WHEN** `factory.action` is assigned to a variable and called
- **THEN** it works correctly without explicit binding (arrow property captures `this`)
