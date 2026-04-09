## REMOVED Requirements

### Requirement: Context interface with emit
**Reason**: ActionContext is the sole implementer; handlers are already typed against ActionContext directly.
**Migration**: Remove Context interface. Use ActionContext type directly.

### Requirement: HttpTriggerContext
**Reason**: HttpTriggerContext was a thin wrapper that only held request body, definition, and an emit callback. The httpTriggerMiddleware called emit itself — no user handler code ever received this context. Replaced by direct EventSource.create() call in the middleware.
**Migration**: Remove HttpTriggerContext class. httpTriggerMiddleware calls source.create() directly.

### Requirement: ContextFactory
**Reason**: With HttpTriggerContext removed, ContextFactory only had one method (action). A class with one method is over-abstraction. Replaced by an inline function.
**Migration**: Replace `new ContextFactory(bus, eventFactory, fetch, env, logger)` with `createActionContext(source, fetch, env, logger)` which returns `(event: RuntimeEvent) => ActionContext`.

### Requirement: ContextFactory emit logging
**Reason**: Event lifecycle logging is moved to a dedicated LoggingConsumer bus consumer, centralizing all logging in one place.
**Migration**: Remove #logEmit from ContextFactory. Logging is handled by LoggingConsumer in the bus consumer chain.

## MODIFIED Requirements

### Requirement: ActionContext

The system SHALL provide an `ActionContext` that carries the source event being processed, an injected fetch function for outbound HTTP requests, and an injected env record exposing environment variables.

The `ActionContext.emit()` method SHALL accept `(type: string, payload: unknown)` and delegate to `EventSource.derive()`. There SHALL be no `EmitOptions` parameter.

The runtime's `ActionContext` uses the internal `Event` type (with `type` field). At the SDK boundary, the runtime maps `event.type` to `event.name` when passing context to SDK-defined action handlers, producing an `EventDefinition` with `{ name, payload }`.

#### Scenario: ActionContext properties

- **GIVEN** an action processing event `evt_001` with `type: "order.received"` and `payload: { orderId: "abc" }`
- **AND** an env record `{ "API_KEY": "secret" }`
- **WHEN** an `ActionContext` is created
- **THEN** `ctx.event` is the full source event object with `type` field
- **AND** `ctx.fetch` is a callable function
- **AND** `ctx.env` is `{ "API_KEY": "secret" }`

#### Scenario: ActionContext emit creates child event

- **GIVEN** an `ActionContext` for event `evt_001` with `correlationId: "corr_xyz"`
- **WHEN** `ctx.emit("order.validated", { valid: true })` is called
- **THEN** `EventSource.derive()` is called with the parent event, type, and payload
- **AND** the derived event is automatically emitted to the bus

#### Scenario: ActionContext emit with no options parameter

- **GIVEN** an `ActionContext`
- **WHEN** `ctx.emit("order.validated", { valid: true })` is called
- **THEN** the call succeeds with two arguments (type, payload)
- **AND** there is no third options parameter

## ADDED Requirements

### Requirement: createActionContext factory function

The system SHALL provide a `createActionContext(source: EventSource, fetch: typeof globalThis.fetch, env: Record<string, string | undefined>, logger: Logger)` function that returns `(event: RuntimeEvent) => ActionContext`. This replaces the `ContextFactory` class.

#### Scenario: Create action context factory

- **GIVEN** an EventSource, fetch function, env record, and Logger
- **WHEN** `createActionContext(source, fetch, env, logger)` is called
- **THEN** a function is returned that accepts a RuntimeEvent and returns an ActionContext

#### Scenario: Factory function produces working ActionContext

- **GIVEN** a context factory created via `createActionContext(source, fetch, env, logger)`
- **AND** a RuntimeEvent `evt_001`
- **WHEN** `factory(evt_001)` is called
- **THEN** the returned ActionContext has `event` set to `evt_001`, working `emit()`, `fetch()`, and `env`
