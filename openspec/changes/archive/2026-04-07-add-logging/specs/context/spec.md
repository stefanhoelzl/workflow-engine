## MODIFIED Requirements

### Requirement: ContextFactory

The system SHALL provide a `ContextFactory` class that holds a queue reference, an injected fetch function, and a Logger instance. It SHALL expose `httpTrigger` and `action` as arrow properties for creating context objects. The Logger SHALL be passed via the constructor.

#### Scenario: Create HttpTriggerContext via factory

- **GIVEN** a `ContextFactory` initialized with an event queue, a fetch function, and a Logger
- **WHEN** `factory.httpTrigger(body, definition)` is called
- **THEN** an `HttpTriggerContext` is returned with the request body, definition, and a working `emit()` method

#### Scenario: Create ActionContext via factory

- **GIVEN** a `ContextFactory` initialized with an event queue, a fetch function, and a Logger
- **WHEN** `factory.action(event)` is called
- **THEN** an `ActionContext` is returned with the source event, a working `emit()` method, and the injected fetch function

#### Scenario: Factory properties can be passed as standalone references

- **GIVEN** a `ContextFactory` instance
- **WHEN** `factory.httpTrigger` is assigned to a variable and called
- **THEN** it works correctly without explicit binding (arrow property captures `this`)

### Requirement: ContextFactory emit logging

The `ContextFactory.#createAndEnqueue` method SHALL log every event creation. This covers all emits from both `HttpTriggerContext` and `ActionContext` in a single location.

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

### Requirement: ActionContext fetch logging

The `ActionContext.fetch` method SHALL log the request lifecycle. The Logger SHALL be provided to `ActionContext` via the `ContextFactory`.

#### Scenario: Successful fetch is logged

- **GIVEN** an `ActionContext` with a Logger and an injected fetch that returns status 200
- **WHEN** `ctx.fetch("https://api.example.com/orders/123")` is called
- **THEN** `fetch.start` is logged at info level with correlationId, url, and method
- **AND** `fetch.completed` is logged at info level with correlationId, url, status, and duration in ms
- **AND** the Response is returned to the caller

#### Scenario: Fetch with request body logs payload at trace level

- **GIVEN** an `ActionContext` with a Logger at trace level
- **WHEN** `ctx.fetch("https://api.example.com/orders", { method: "POST", body: JSON.stringify({ id: "123" }) })` is called
- **THEN** `fetch.request.body` is logged at trace level with the body content

#### Scenario: Failed fetch is logged

- **GIVEN** an `ActionContext` with a Logger and an injected fetch that rejects with an error
- **WHEN** `ctx.fetch("https://unreachable.example.com")` is called
- **THEN** `fetch.start` is logged at info level
- **AND** `fetch.failed` is logged at error level with correlationId, url, error message, and duration
- **AND** the promise rejects with the same error from the injected function
