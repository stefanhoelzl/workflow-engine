# Context Specification

## Purpose

Provide context objects that wrap event queue access and metadata propagation, giving triggers and actions a clean interface for emitting events with proper correlation and parent tracking.

## Requirements

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

### Requirement: ActionContext env property

The `ActionContext` SHALL provide an `env` property that gives access to environment variables. The `env` property SHALL be typed as `Record<string, string | undefined>`.

#### Scenario: Access environment variable

- **GIVEN** an `ActionContext` with env containing `DATABASE_URL=postgres://localhost/db`
- **WHEN** the handler accesses `ctx.env.DATABASE_URL`
- **THEN** the value is `"postgres://localhost/db"`

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
