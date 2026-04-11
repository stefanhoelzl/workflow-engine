## REMOVED Requirements

### Requirement: ActionContext fetch method

**Reason**: Replaced by global `fetch` polyfill backed by the `__hostFetch` bridge. Actions now call `fetch(url, init)` instead of `ctx.fetch(url, init)`. The Response is constructed natively by whatwg-fetch inside QuickJS, eliminating the need for host-side Response marshalling.

**Migration**: Change `ctx.fetch(url, init)` to `fetch(url, init)` in action handler code. Response objects are now spec-compliant (real `Headers` instance via `.headers`, standard `.json()`, `.text()` methods).

### Requirement: ActionContext fetch logging

**Reason**: Replaced by bridge factory auto-logging on the `__hostFetch` bridge. Every `__hostFetch` invocation is automatically logged with method, url, headers, body, duration, and status.

**Migration**: Fetch logging now appears in `SandboxResult.logs` as entries with `method: "xhr.send"`. The runtime Logger-based `fetch.start`/`fetch.completed`/`fetch.failed` logging is removed.

## MODIFIED Requirements

### Requirement: ActionContext

The system SHALL provide an `ActionContext` that carries the source event being processed and an injected env record exposing environment variables.

The `ActionContext.emit()` method SHALL accept `(type: string, payload: unknown)` and delegate to `EventSource.derive()`. There SHALL be no `EmitOptions` parameter.

The runtime's `ActionContext` uses the internal `Event` type (with `type` field). At the SDK boundary, the runtime maps `event.type` to `event.name` when passing context to SDK-defined action handlers, producing an `EventDefinition` with `{ name, payload }`.

Network access SHALL be provided by the global `fetch` function (a polyfill), not by a method on `ActionContext`.

#### Scenario: ActionContext properties

- **GIVEN** an action processing event `evt_001` with `type: "order.received"` and `payload: { orderId: "abc" }`
- **AND** an env record `{ "API_KEY": "secret" }`
- **WHEN** an `ActionContext` is created
- **THEN** `ctx.event` is the full source event object with `type` field
- **AND** `ctx.env` is `{ "API_KEY": "secret" }`
- **AND** `ctx` SHALL NOT have a `fetch` property

#### Scenario: ActionContext emit creates child event

- **GIVEN** an `ActionContext` for event `evt_001` with `correlationId: "corr_xyz"`
- **WHEN** `ctx.emit("order.validated", { valid: true })` is called
- **THEN** `EventSource.derive()` is called with the parent event, type, and payload
- **AND** the derived event is automatically emitted to the bus

### Requirement: createActionContext factory function

The system SHALL provide a `createActionContext(source: EventSource, logger: Logger)` function that returns `(event: RuntimeEvent, actionName: string, env: Record<string, string>) => ActionContext`. The factory SHALL NOT accept a fetch parameter. The factory SHALL NOT accept a global env parameter; env SHALL be provided per-invocation.

#### Scenario: Create action context factory

- **GIVEN** an EventSource and Logger
- **WHEN** `createActionContext(source, logger)` is called
- **THEN** a function is returned that accepts a RuntimeEvent, action name, and per-action env record, and returns an ActionContext

#### Scenario: Factory function produces working ActionContext with per-action env

- **GIVEN** a context factory created via `createActionContext(source, logger)`
- **AND** a RuntimeEvent `evt_001` and env `{ "KEY": "value" }`
- **WHEN** `factory(evt_001, "myAction", { "KEY": "value" })` is called
- **THEN** the returned ActionContext has `event` set to `evt_001`, working `emit()`, and `env` set to `{ "KEY": "value" }`
