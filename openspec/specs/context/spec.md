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

The `ActionContext` SHALL provide an `env` property that gives access to environment variables. The `env` property SHALL be typed as `Record<string, string>` (no `undefined`). The env values SHALL be the per-action resolved values from the workflow manifest, not `process.env`.

#### Scenario: Access environment variable

- **GIVEN** an `ActionContext` created with env `{ "API_KEY": "secret", "BASE_URL": "https://example.com" }`
- **WHEN** the handler accesses `ctx.env.API_KEY`
- **THEN** the value is `"secret"`

#### Scenario: Env does not contain undeclared variables

- **GIVEN** an `ActionContext` created with env `{ "API_KEY": "secret" }`
- **AND** `process.env.OTHER_VAR` is `"other"`
- **WHEN** the handler accesses `ctx.env`
- **THEN** `ctx.env` SHALL NOT contain `OTHER_VAR`

### Requirement: ActionContext fetch method

The system SHALL provide a `fetch(url: string | URL, init?: RequestInit): Promise<Response>` method on `ActionContext` that delegates to an injected fetch function.

When called from within the QuickJS sandbox, the Response SHALL be proxied as a simplified object with:
- `status` (number), `statusText` (string), `ok` (boolean), `url` (string) as properties
- `headers` as a `Map` with lowercase-normalized keys
- `json()` as an async method bridged to the host
- `text()` as an async method bridged to the host

The host-side `ActionContext.fetch()` method remains unchanged — it still delegates to the injected fetch function with logging. The Response proxy is constructed by the sandbox bridge layer, not by `ActionContext` itself.

#### Scenario: Action performs a GET request via sandbox

- **GIVEN** an `ActionContext` with an injected fetch function
- **WHEN** action code in the sandbox calls `await ctx.fetch("https://api.example.com/orders/123")`
- **THEN** the host-side `ActionContext.fetch()` is called
- **AND** the sandbox bridge constructs a Response proxy from the real Response
- **AND** the proxy is returned to the action code inside QuickJS

#### Scenario: Action reads response headers via Map

- **GIVEN** a fetch response with headers `Content-Type: application/json` and `X-Request-Id: abc`
- **WHEN** action code accesses `res.headers.get("content-type")`
- **THEN** the value is `"application/json"`
- **AND** `res.headers.has("x-request-id")` returns `true`

#### Scenario: Action parses JSON response body

- **GIVEN** a fetch response with body `{"key": "value"}`
- **WHEN** action code calls `await res.json()`
- **THEN** the result is `{ key: "value" }` inside QuickJS
- **AND** the body is read on the host side and marshalled into QuickJS

#### Scenario: Action reads text response body

- **GIVEN** a fetch response with body `"hello"`
- **WHEN** action code calls `await res.text()`
- **THEN** the result is `"hello"` inside QuickJS

#### Scenario: Fetch error propagates to action

- **GIVEN** an `ActionContext` with an injected fetch function that rejects
- **WHEN** action code in the sandbox calls `await ctx.fetch("https://unreachable.example.com")`
- **THEN** the QuickJS promise rejects with an error containing the host error message
- **AND** the action can catch the error or let it propagate as a failed `SandboxResult`

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

The system SHALL provide a `createActionContext(source: EventSource, fetch: typeof globalThis.fetch, logger: Logger)` function that returns `(event: RuntimeEvent, actionName: string, env: Record<string, string>) => ActionContext`. The factory SHALL NOT accept a global env parameter; env SHALL be provided per-invocation.

#### Scenario: Create action context factory

- **GIVEN** an EventSource, fetch function, and Logger
- **WHEN** `createActionContext(source, fetch, logger)` is called
- **THEN** a function is returned that accepts a RuntimeEvent, action name, and per-action env record, and returns an ActionContext

#### Scenario: Factory function produces working ActionContext with per-action env

- **GIVEN** a context factory created via `createActionContext(source, fetch, logger)`
- **AND** a RuntimeEvent `evt_001` and env `{ "KEY": "value" }`
- **WHEN** `factory(evt_001, "myAction", { "KEY": "value" })` is called
- **THEN** the returned ActionContext has `event` set to `evt_001`, working `emit()`, `fetch()`, and `env` set to `{ "KEY": "value" }`
