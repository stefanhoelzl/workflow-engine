## ADDED Requirements

### Requirement: ActionContext fetch method

The system SHALL provide a `fetch(url: string | URL, init?: RequestInit): Promise<Response>` method on `ActionContext` that delegates to an injected fetch function.

#### Scenario: Action performs a GET request

- **GIVEN** an `ActionContext` with an injected fetch function
- **WHEN** `ctx.fetch("https://api.example.com/orders/123")` is called
- **THEN** the injected fetch function is called with `"https://api.example.com/orders/123"` and `undefined`
- **AND** the native `Response` is returned to the caller

#### Scenario: Action performs a POST request with options

- **GIVEN** an `ActionContext` with an injected fetch function
- **WHEN** `ctx.fetch("https://api.example.com/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "123" }) })` is called
- **THEN** the injected fetch function is called with the URL and the full `RequestInit` options
- **AND** the native `Response` is returned to the caller

#### Scenario: Fetch error propagates to action

- **GIVEN** an `ActionContext` with an injected fetch function that rejects
- **WHEN** `ctx.fetch("https://unreachable.example.com")` is called
- **THEN** the promise rejects with the same error from the injected function
- **AND** the action can catch the error or let it propagate to the scheduler

## MODIFIED Requirements

### Requirement: ActionContext

The system SHALL provide an `ActionContext` implementing `Context` that carries the source event being processed and an injected fetch function for outbound HTTP requests.

#### Scenario: ActionContext properties

- **GIVEN** an action processing event `evt_001` with `type: "order.received"` and `payload: { orderId: "abc" }`
- **WHEN** an `ActionContext` is created
- **THEN** `ctx.event` is the full source event object
- **AND** `ctx.fetch` is a callable function

#### Scenario: ActionContext emit creates child event

- **GIVEN** an `ActionContext` for event `evt_001` with `correlationId: "corr_xyz"`
- **WHEN** `ctx.emit("order.validated", { valid: true })` is called
- **THEN** the enqueued event inherits `correlationId: "corr_xyz"`
- **AND** `parentEventId` is set to `"evt_001"`

#### Scenario: ActionContext emit multiple events

- **GIVEN** an `ActionContext` for event `evt_001`
- **WHEN** the action calls `ctx.emit()` twice with different types
- **THEN** two separate events are enqueued
- **AND** both inherit the same `correlationId` from `evt_001`
- **AND** both have `parentEventId` set to `"evt_001"`

### Requirement: ContextFactory

The system SHALL provide a `ContextFactory` class that holds a queue reference and an injected fetch function, and exposes `httpTrigger` and `action` as arrow properties for creating context objects.

#### Scenario: Create HttpTriggerContext via factory

- **GIVEN** a `ContextFactory` initialized with an event queue and a fetch function
- **WHEN** `factory.httpTrigger(body, definition)` is called
- **THEN** an `HttpTriggerContext` is returned with the request body, definition, and a working `emit()` method

#### Scenario: Create ActionContext via factory

- **GIVEN** a `ContextFactory` initialized with an event queue and a fetch function
- **WHEN** `factory.action(event)` is called
- **THEN** an `ActionContext` is returned with the source event, a working `emit()` method, and the injected fetch function

#### Scenario: Factory properties can be passed as standalone references

- **GIVEN** a `ContextFactory` instance
- **WHEN** `factory.httpTrigger` is assigned to a variable and called
- **THEN** it works correctly without explicit binding (arrow property captures `this`)
